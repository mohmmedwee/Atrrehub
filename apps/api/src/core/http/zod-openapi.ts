import { ApiBody, ApiQuery } from '@nestjs/swagger';
import { z, type ZodTypeAny } from 'zod';

/**
 * Describes Zod schemas to OpenAPI.
 *
 * The API validates every body and query string with Zod rather than with DTO
 * classes, which is a better fit for the coercion and refinement these payloads
 * need — but it means Nest's Swagger integration, which reads class metadata,
 * sees nothing. Without this the published document lists every endpoint and
 * describes not one of their inputs, so nobody can call the API from the docs
 * and no client can be generated from them.
 *
 * Deliberately hand-written rather than a dependency: it covers the constructs
 * these schemas actually use, and an unsupported one degrades to an untyped
 * object rather than throwing at boot.
 */

export interface OpenApiSchema {
  type?: string;
  format?: string;
  enum?: unknown[];
  items?: OpenApiSchema;
  properties?: Record<string, OpenApiSchema>;
  required?: string[];
  additionalProperties?: boolean | OpenApiSchema;
  nullable?: boolean;
  description?: string;
  default?: unknown;
  minimum?: number;
  maximum?: number;
  minLength?: number;
  maxLength?: number;
  minItems?: number;
  maxItems?: number;
  oneOf?: OpenApiSchema[];
}

/** Unwraps the wrappers that describe presence rather than shape. */
function unwrap(schema: ZodTypeAny): { inner: ZodTypeAny; optional: boolean; nullable: boolean; defaultValue?: unknown } {
  let inner = schema;
  let optional = false;
  let nullable = false;
  let defaultValue: unknown;

  // Bounded rather than `while (true)`: a schema built by a cyclic factory
  // would otherwise hang the process at module load, before any log line.
  for (let depth = 0; depth < 20; depth += 1) {
    const definition = inner._def as { typeName?: string; innerType?: ZodTypeAny; defaultValue?: () => unknown; schema?: ZodTypeAny };
    if (definition.typeName === 'ZodOptional') {
      optional = true;
      inner = definition.innerType!;
    } else if (definition.typeName === 'ZodNullable') {
      nullable = true;
      inner = definition.innerType!;
    } else if (definition.typeName === 'ZodDefault') {
      optional = true;
      defaultValue = definition.defaultValue?.();
      inner = definition.innerType!;
    } else if (definition.typeName === 'ZodEffects') {
      inner = definition.schema!;
    } else {
      break;
    }
  }
  return { inner, optional, nullable, defaultValue };
}

export function zodToOpenApi(schema: ZodTypeAny): OpenApiSchema {
  const { inner, nullable, defaultValue } = unwrap(schema);
  const definition = inner._def as Record<string, any>;
  const base: OpenApiSchema = {};
  if (nullable) base.nullable = true;
  if (defaultValue !== undefined) base.default = defaultValue;
  if (inner.description) base.description = inner.description;

  switch (definition.typeName) {
    case 'ZodString': {
      const checks = (definition.checks ?? []) as { kind: string; value?: number }[];
      const format = checks.find((check) => ['email', 'url', 'uuid', 'datetime'].includes(check.kind));
      return {
        ...base,
        type: 'string',
        ...(format ? { format: format.kind === 'datetime' ? 'date-time' : format.kind } : {}),
        ...numericCheck(checks, 'min', 'minLength'),
        ...numericCheck(checks, 'max', 'maxLength'),
      };
    }
    case 'ZodNumber': {
      const checks = (definition.checks ?? []) as { kind: string; value?: number }[];
      return {
        ...base,
        type: checks.some((check) => check.kind === 'int') ? 'integer' : 'number',
        ...numericCheck(checks, 'min', 'minimum'),
        ...numericCheck(checks, 'max', 'maximum'),
      };
    }
    case 'ZodBoolean':
      return { ...base, type: 'boolean' };
    case 'ZodDate':
      return { ...base, type: 'string', format: 'date-time' };
    case 'ZodLiteral':
      return { ...base, type: typeof definition.value, enum: [definition.value] };
    case 'ZodEnum':
      return { ...base, type: 'string', enum: [...(definition.values as string[])] };
    case 'ZodNativeEnum':
      return { ...base, type: 'string', enum: Object.values(definition.values as object) };
    case 'ZodArray': {
      const checks = definition as { minLength?: { value: number }; maxLength?: { value: number } };
      return {
        ...base,
        type: 'array',
        items: zodToOpenApi(definition.type),
        ...(checks.minLength ? { minItems: checks.minLength.value } : {}),
        ...(checks.maxLength ? { maxItems: checks.maxLength.value } : {}),
      };
    }
    case 'ZodObject': {
      const shape = definition.shape() as Record<string, ZodTypeAny>;
      const properties: Record<string, OpenApiSchema> = {};
      const required: string[] = [];
      for (const [key, value] of Object.entries(shape)) {
        properties[key] = zodToOpenApi(value);
        if (!unwrap(value).optional) required.push(key);
      }
      return {
        ...base,
        type: 'object',
        properties,
        ...(required.length ? { required } : {}),
        // `.strict()` is a promise to the caller that a typo will be rejected
        // rather than ignored, and the document should say so.
        additionalProperties: definition.unknownKeys === 'strict' ? false : true,
      };
    }
    case 'ZodRecord':
      return { ...base, type: 'object', additionalProperties: zodToOpenApi(definition.valueType) };
    case 'ZodUnion':
    case 'ZodDiscriminatedUnion': {
      const options = (definition.options as ZodTypeAny[] | Map<string, ZodTypeAny>) ?? [];
      const list = Array.isArray(options) ? options : [...options.values()];
      return { ...base, oneOf: list.map(zodToOpenApi) };
    }
    case 'ZodIntersection': {
      const left = zodToOpenApi(definition.left);
      const right = zodToOpenApi(definition.right);
      return {
        ...base,
        type: 'object',
        properties: { ...left.properties, ...right.properties },
        required: [...(left.required ?? []), ...(right.required ?? [])],
      };
    }
    default:
      // An unrecognised construct documents as "some object" rather than
      // failing the build — a slightly vague document beats no document.
      return base;
  }
}

function numericCheck(
  checks: { kind: string; value?: number }[],
  kind: string,
  key: 'minLength' | 'maxLength' | 'minimum' | 'maximum',
): Record<string, number> {
  const check = checks.find((candidate) => candidate.kind === kind);
  return check?.value === undefined ? {} : { [key]: check.value };
}

/** `@ApiZodBody(CreateTicketSchema)` alongside `@Body(zodBody(CreateTicketSchema))`. */
export function ApiZodBody(schema: ZodTypeAny): MethodDecorator {
  return ApiBody({ schema: zodToOpenApi(schema) as Record<string, unknown>, required: true });
}

/**
 * Describe a query schema as individual parameters.
 *
 * Query strings are a flat list in OpenAPI, not an object, so an object schema
 * has to be flattened — and optionality has to be carried across, because Nest
 * marks every `@Query()` as required by default and a generated client then
 * demands filters nobody wanted to set.
 */
export function ApiZodQuery(schema: ZodTypeAny): MethodDecorator {
  const { inner } = unwrap(schema);
  const definition = inner._def as Record<string, any>;
  if (definition.typeName !== 'ZodObject') return () => undefined;

  const shape = definition.shape() as Record<string, ZodTypeAny>;
  const decorators = Object.entries(shape).map(([name, value]) =>
    ApiQuery({
      name,
      required: !unwrap(value).optional,
      schema: zodToOpenApi(value) as Record<string, unknown>,
    }),
  );

  return (target, key, descriptor) => {
    for (const decorate of decorators) decorate(target, key, descriptor);
  };
}

/** For a handler that takes loose `@Query('name')` parameters rather than a schema. */
export function ApiOptionalQuery(...names: string[]): MethodDecorator {
  const decorators = names.map((name) =>
    ApiQuery({ name, required: false, schema: { type: 'string' } }),
  );
  return (target, key, descriptor) => {
    for (const decorate of decorators) decorate(target, key, descriptor);
  };
}

export { z };
