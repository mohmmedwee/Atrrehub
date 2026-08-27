/**
 * Generates the SDK's typed operations from the API's own OpenAPI document.
 *
 * Run against a running API — `pnpm --filter @atrrehub/sdk generate` — or
 * against a saved document with `--input path/to/openapi.json`. The output is
 * committed so that installing the SDK never requires a running server, and so
 * that a regeneration shows up as a reviewable diff rather than as a silent
 * change in behaviour.
 *
 * Deliberately not a general-purpose OpenAPI generator. It understands exactly
 * the shapes this API emits, which is why it is fifty lines of readable code
 * instead of a dependency that produces a thousand lines nobody reads.
 */
import { readFile, writeFile } from 'node:fs/promises';
import { fileURLToPath } from 'node:url';
import { dirname, resolve } from 'node:path';

interface OpenApiOperation {
  operationId?: string;
  summary?: string;
  tags?: string[];
  parameters?: { name: string; in: string; required?: boolean; schema?: { type?: string } }[];
  requestBody?: unknown;
}

type OpenApiDocument = {
  paths: Record<string, Record<string, OpenApiOperation>>;
};

const METHODS = ['get', 'post', 'put', 'patch', 'delete'] as const;
const HERE = dirname(fileURLToPath(import.meta.url));

interface Operation {
  method: string;
  path: string;
  name: string;
  summary?: string;
  pathParams: string[];
  queryParams: { name: string; required: boolean }[];
  hasBody: boolean;
  /** Mutating, but the document does not describe a body. */
  maybeBody: boolean;
}

async function loadDocument(): Promise<OpenApiDocument> {
  const inputIndex = process.argv.indexOf('--input');
  if (inputIndex !== -1) {
    const path = process.argv[inputIndex + 1];
    if (!path) throw new Error('--input needs a file path');
    return JSON.parse(await readFile(path, 'utf8')) as OpenApiDocument;
  }

  const urlIndex = process.argv.indexOf('--url');
  const base = (urlIndex !== -1 ? process.argv[urlIndex + 1] : undefined) ?? 'http://localhost:4000';
  const response = await fetch(`${base.replace(/\/+$/, '')}/api/openapi.json`);
  if (!response.ok) {
    throw new Error(
      `Could not read the OpenAPI document from ${base} (${response.status}). ` +
        'Start the API, or pass --input with a saved document.',
    );
  }
  return (await response.json()) as OpenApiDocument;
}

/** `/api/v1/webhooks/{endpointId}/ping` + POST → `pingWebhook`-ish, from the operationId. */
function methodName(operationId: string | undefined, method: string, path: string): string {
  if (operationId) {
    // Nest emits `ControllerName_handlerName`; the handler name is the useful half.
    const handler = operationId.includes('_') ? operationId.split('_').slice(1).join('_') : operationId;
    const controller = operationId.includes('_') ? operationId.split('_')[0] ?? '' : '';
    const group = controller.replace(/Controller$/, '');
    return camel(`${handler}_${group}`);
  }
  const segments = path.split('/').filter((segment) => segment && !segment.startsWith('{'));
  return camel([method, ...segments].join('_'));
}

function camel(value: string): string {
  const parts = value.split(/[^A-Za-z0-9]+/).filter(Boolean);
  return parts
    .map((part, index) =>
      index === 0
        ? part.charAt(0).toLowerCase() + part.slice(1)
        : part.charAt(0).toUpperCase() + part.slice(1),
    )
    .join('');
}

function collect(document: OpenApiDocument): Operation[] {
  const operations: Operation[] = [];
  const seen = new Set<string>();

  for (const [path, item] of Object.entries(document.paths ?? {})) {
    for (const method of METHODS) {
      const operation = item[method];
      if (!operation) continue;

      const parameters = operation.parameters ?? [];
      let name = methodName(operation.operationId, method, path);
      // Two handlers can normalize to the same name; suffixing beats colliding.
      let suffix = 2;
      while (seen.has(name)) name = `${methodName(operation.operationId, method, path)}${suffix++}`;
      seen.add(name);

      operations.push({
        method: method.toUpperCase(),
        path: path.replace(/^\/api\/v1/, ''),
        name,
        summary: operation.summary,
        pathParams: parameters.filter((p) => p.in === 'path').map((p) => p.name),
        queryParams: parameters
          .filter((p) => p.in === 'query')
          .map((p) => ({ name: p.name, required: p.required ?? false })),
        hasBody: Boolean(operation.requestBody),
        // A handful of endpoints take a body the document cannot describe —
        // a multipart upload, a provider's own webhook payload. Emitting an
        // optional parameter for every mutating verb keeps those callable
        // without forcing an argument on the many that genuinely take none.
        maybeBody: !operation.requestBody && ['post', 'put', 'patch'].includes(method),
      });
    }
  }
  return operations.sort((a, b) => a.name.localeCompare(b.name));
}

function render(operations: Operation[]): string {
  const lines: string[] = [
    '/* eslint-disable */',
    '// Generated from the Atrrehub OpenAPI document. Do not edit by hand —',
    '// run `pnpm --filter @atrrehub/sdk generate` against a running API.',
    '',
    "import type { HttpClient, RequestOptions } from './http.js';",
    '',
    '/**',
    ' * Every operation the API exposes, as a method.',
    ' *',
    ' * Return types are `unknown` by design: the API validates request and',
    ' * response bodies with Zod schemas that OpenAPI cannot fully express, and a',
    ' * generated type that is subtly wrong is worse than no type at all. Narrow',
    ' * with your own type on the call: `await api.listWebhooks<Endpoint[]>()`.',
    ' */',
    'export class Operations {',
    '  constructor(protected readonly http: HttpClient) {}',
    '',
  ];

  for (const operation of operations) {
    // Built as two lists and concatenated, because TypeScript will not accept
    // a required parameter after an optional one and the mix varies per route.
    const required: string[] = operation.pathParams.map((param) => `${camel(param)}: string`);
    const optional: string[] = [];

    if (operation.hasBody) required.push('body: unknown');
    else if (operation.maybeBody) optional.push('body?: unknown');

    if (operation.queryParams.length) {
      const fields = operation.queryParams
        .map((param) => `${JSON.stringify(param.name)}${param.required ? '' : '?'}: string | number | boolean`)
        .join('; ');
      if (operation.queryParams.some((param) => param.required)) required.push(`query: { ${fields} }`);
      else optional.push(`query?: { ${fields} }`);
    }
    optional.push('options?: RequestOptions');
    const args = [...required, ...optional];

    const template = operation.path.replace(/\{(\w+)\}/g, (_match, param) => `\${encodeURIComponent(${camel(param)})}`);
    const requestOptions: string[] = ['...options'];
    if (operation.hasBody || operation.maybeBody) requestOptions.push('body');
    if (operation.queryParams.length) requestOptions.push('query: { ...query, ...options?.query }');

    if (operation.summary) lines.push(`  /** ${operation.summary} */`);
    lines.push(
      `  ${operation.name}<T = unknown>(${args.join(', ')}): Promise<T> {`,
      `    return this.http.request<T>(${JSON.stringify(operation.method)}, \`${template}\`, { ${requestOptions.join(', ')} });`,
      '  }',
      '',
    );
  }

  lines.push('}', '');
  return lines.join('\n');
}

const document = await loadDocument();
const operations = collect(document);
if (!operations.length) throw new Error('The OpenAPI document described no operations');

const output = resolve(HERE, '..', 'src', 'operations.generated.ts');
await writeFile(output, render(operations), 'utf8');
process.stdout.write(`Generated ${operations.length} operations into ${output}\n`);
