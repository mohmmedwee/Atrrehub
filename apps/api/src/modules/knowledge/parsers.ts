import { parse as parseHtml } from 'node-html-parser';

/**
 * Text extraction for the ingestion pipeline.
 *
 * Every parser aims for the same thing: recover the *reading order* of the
 * document and drop the furniture, because boilerplate navigation and repeated
 * headers dilute the embeddings and pollute retrieval.
 */
export interface ParsedDocument {
  text: string;
  title?: string;
  metadata?: Record<string, unknown>;
}

export async function parseContent(
  content: Buffer,
  contentType: string,
  filename?: string,
): Promise<ParsedDocument> {
  const type = contentType.toLowerCase();

  if (type.includes('html')) return parseHtmlContent(content.toString('utf8'));
  if (type.includes('json')) return parseJsonContent(content.toString('utf8'));
  if (type.includes('csv') || type.includes('tab-separated')) return parseCsvContent(content.toString('utf8'));
  if (type.includes('wordprocessingml') || filename?.endsWith('.docx')) return parseDocx(content);
  if (type.includes('pdf')) return parsePdf(content);
  return { text: cleanText(content.toString('utf8')), title: filename };
}

/** Strip navigation and chrome, then recover block structure as markdown-ish text. */
export function parseHtmlContent(html: string): ParsedDocument {
  const root = parseHtml(html, { blockTextElements: { script: false, style: false, noscript: false } });

  for (const selector of ['script', 'style', 'noscript', 'nav', 'header', 'footer', 'aside', 'form', 'iframe']) {
    root.querySelectorAll(selector).forEach((node) => node.remove());
  }

  const title = root.querySelector('title')?.text?.trim() || root.querySelector('h1')?.text?.trim();

  // Prefer the main content region when the page marks one.
  const main = root.querySelector('main') ?? root.querySelector('article') ?? root.querySelector('body') ?? root;

  const lines: string[] = [];
  const walk = (node: { childNodes: unknown[] }) => {
    for (const child of node.childNodes as { tagName?: string; text?: string; childNodes?: unknown[] }[]) {
      const tag = child.tagName?.toLowerCase();

      if (!tag) {
        const text = (child.text ?? '').trim();
        if (text) lines.push(text);
        continue;
      }
      if (/^h[1-6]$/.test(tag)) {
        const text = (child.text ?? '').trim();
        if (text) lines.push(`\n${'#'.repeat(Number(tag[1]))} ${text}\n`);
        continue;
      }
      if (tag === 'li') {
        const text = (child.text ?? '').trim();
        if (text) lines.push(`- ${text}`);
        continue;
      }
      if (tag === 'br') {
        lines.push('');
        continue;
      }
      if (['p', 'div', 'section', 'td', 'th', 'tr', 'table', 'ul', 'ol', 'pre', 'blockquote'].includes(tag)) {
        walk(child as { childNodes: unknown[] });
        lines.push('');
        continue;
      }
      walk(child as { childNodes: unknown[] });
    }
  };
  walk(main as unknown as { childNodes: unknown[] });

  return { text: cleanText(lines.join('\n')), title, metadata: { source: 'html' } };
}

/** Flatten JSON into `path: value` lines, which embed far better than raw JSON. */
export function parseJsonContent(json: string): ParsedDocument {
  try {
    const parsed = JSON.parse(json);
    const lines: string[] = [];
    const walk = (value: unknown, path: string[]) => {
      if (value === null || value === undefined) return;
      if (Array.isArray(value)) {
        value.forEach((item, index) => walk(item, [...path, String(index)]));
        return;
      }
      if (typeof value === 'object') {
        for (const [key, child] of Object.entries(value)) walk(child, [...path, key]);
        return;
      }
      lines.push(`${path.join('.')}: ${String(value)}`);
    };
    walk(parsed, []);
    return { text: cleanText(lines.join('\n')), metadata: { source: 'json' } };
  } catch {
    return { text: cleanText(json), metadata: { source: 'json', parseFailed: true } };
  }
}

/**
 * Render each CSV row as `Header: value` pairs. A bare row of values loses all
 * meaning once chunking separates it from its header line.
 */
export function parseCsvContent(csv: string): ParsedDocument {
  const rows = parseDelimited(csv);
  if (!rows.length) return { text: '' };

  const [headers, ...body] = rows;
  const lines = body.map((row, index) => {
    const pairs = headers
      .map((header, column) => (row[column] ? `${header.trim()}: ${row[column].trim()}` : null))
      .filter(Boolean);
    return `Row ${index + 1} — ${pairs.join(' | ')}`;
  });

  return {
    text: cleanText(lines.join('\n')),
    metadata: { source: 'csv', rows: body.length, columns: headers.length },
  };
}

/** Minimal RFC 4180 reader: handles quoted fields, escaped quotes and embedded newlines. */
export function parseDelimited(input: string, delimiter = ','): string[][] {
  const rows: string[][] = [];
  let row: string[] = [];
  let field = '';
  let quoted = false;

  for (let index = 0; index < input.length; index += 1) {
    const char = input[index];

    if (quoted) {
      if (char === '"') {
        if (input[index + 1] === '"') {
          field += '"';
          index += 1;
        } else {
          quoted = false;
        }
      } else {
        field += char;
      }
      continue;
    }

    if (char === '"') {
      quoted = true;
    } else if (char === delimiter) {
      row.push(field);
      field = '';
    } else if (char === '\n') {
      row.push(field);
      rows.push(row);
      row = [];
      field = '';
    } else if (char !== '\r') {
      field += char;
    }
  }

  if (field || row.length) {
    row.push(field);
    rows.push(row);
  }
  return rows.filter((entry) => entry.some((value) => value.trim()));
}

async function parseDocx(content: Buffer): Promise<ParsedDocument> {
  try {
    const mammoth = await import('mammoth');
    const result = await mammoth.convertToHtml({ buffer: content });
    return { ...parseHtmlContent(result.value), metadata: { source: 'docx' } };
  } catch {
    return { text: '', metadata: { source: 'docx', parseFailed: true } };
  }
}

/**
 * PDF text extraction without a native dependency: pull text-showing operators
 * out of the content streams. This handles the text-based PDFs that make up
 * enterprise knowledge; a scanned document needs OCR, which is a separate step
 * and is reported rather than silently indexed as empty.
 */
async function parsePdf(content: Buffer): Promise<ParsedDocument> {
  const raw = content.toString('latin1');
  const pieces: string[] = [];

  // Text lives between BT/ET markers, shown by the Tj and TJ operators.
  for (const block of raw.match(/BT[\s\S]*?ET/g) ?? []) {
    for (const match of block.matchAll(/\((?:[^()\\]|\\.)*\)/g)) {
      const text = match[0]
        .slice(1, -1)
        .replace(/\\([()\\])/g, '$1')
        .replace(/\\n/g, '\n')
        .replace(/\\r/g, '')
        .replace(/\\t/g, ' ');
      if (text.trim()) pieces.push(text);
    }
    pieces.push('\n');
  }

  const text = cleanText(pieces.join(' '));
  return {
    text,
    metadata: {
      source: 'pdf',
      ...(text ? {} : { parseFailed: true, reason: 'no extractable text — the file may be scanned' }),
    },
  };
}

/** Control characters that survive extraction and add nothing but noise. */
const CONTROL_CHARACTERS = new RegExp(
  `[${String.fromCharCode(0)}-${String.fromCharCode(8)}${String.fromCharCode(11)}${String.fromCharCode(12)}${String.fromCharCode(14)}-${String.fromCharCode(31)}${String.fromCharCode(127)}]`,
  'g',
);

/**
 * Normalize whitespace, drop control characters, and remove lines that repeat
 * on nearly every page — running headers and footers, which would otherwise
 * dominate the index and match every query.
 */
export function cleanText(text: string): string {
  const normalized = text
    .replace(CONTROL_CHARACTERS, ' ')
    .replace(/\r\n/g, '\n')
    .replace(/[ \t]+/g, ' ')
    .replace(/ *\n */g, '\n')
    .replace(/\n{3,}/g, '\n\n')
    .trim();

  const lines = normalized.split('\n');
  if (lines.length < 30) return normalized;

  const counts = new Map<string, number>();
  for (const line of lines) {
    const key = line.trim();
    if (key.length > 3 && key.length < 120) counts.set(key, (counts.get(key) ?? 0) + 1);
  }

  // A line appearing on ~4% of lines or more is furniture, not content.
  const threshold = Math.max(3, Math.floor(lines.length / 25));
  const boilerplate = new Set([...counts.entries()].filter(([, count]) => count >= threshold).map(([line]) => line));
  if (!boilerplate.size) return normalized;

  return lines
    .filter((line) => !boilerplate.has(line.trim()))
    .join('\n')
    .replace(/\n{3,}/g, '\n\n')
    .trim();
}
