import { estimateTokens } from '../ai/provider';

export interface Chunk {
  content: string;
  heading?: string;
  position: number;
  tokenCount: number;
}

export interface ChunkOptions {
  /** Target size in tokens. Chunks may overshoot to avoid splitting a structure. */
  targetTokens?: number;
  /** Overlap carried into the next chunk so an answer spanning a boundary survives. */
  overlapTokens?: number;
  maxTokens?: number;
}

const DEFAULTS: Required<ChunkOptions> = { targetTokens: 800, overlapTokens: 120, maxTokens: 1600 };

/**
 * Structure-aware chunking.
 *
 * Splitting on headings first keeps a chunk about one topic, which is what
 * makes retrieval precise. Within a section, sentences are the unit — never
 * characters — and code blocks and table rows are kept whole, because half a
 * code block or a header-less table row is worse than useless as context.
 */
export function chunkDocument(text: string, options: ChunkOptions = {}): Chunk[] {
  const config = { ...DEFAULTS, ...options };
  const normalized = text.replace(/\r\n/g, '\n').replace(/\n{3,}/g, '\n\n').trim();
  if (!normalized) return [];

  const sections = splitByHeading(normalized);
  const chunks: Chunk[] = [];

  for (const section of sections) {
    for (const body of splitSection(section.body, config)) {
      chunks.push({
        content: section.heading ? `${section.heading}\n\n${body}` : body,
        heading: section.heading,
        position: chunks.length,
        tokenCount: estimateTokens(body),
      });
    }
  }

  return chunks;
}

interface Section {
  heading?: string;
  body: string;
}

/** Markdown ATX headings, then setext, then a single unheaded section. */
function splitByHeading(text: string): Section[] {
  const lines = text.split('\n');
  const sections: Section[] = [];
  let heading: string | undefined;
  let buffer: string[] = [];
  let inFence = false;

  const flush = () => {
    const body = buffer.join('\n').trim();
    if (body) sections.push({ heading, body });
    buffer = [];
  };

  for (const line of lines) {
    if (/^\s*```/.test(line)) inFence = !inFence;
    // A heading inside a fenced block is content, not structure.
    if (!inFence && /^#{1,6}\s+\S/.test(line)) {
      flush();
      heading = line.replace(/^#+\s*/, '').trim();
      continue;
    }
    buffer.push(line);
  }
  flush();

  return sections.length ? sections : [{ body: text }];
}

/** Split one section into token-bounded pieces, respecting atomic structures. */
function splitSection(body: string, config: Required<ChunkOptions>): string[] {
  if (estimateTokens(body) <= config.maxTokens) return [body];

  const units = splitIntoUnits(body);
  const pieces: string[] = [];
  let current: string[] = [];
  let currentTokens = 0;

  for (const unit of units) {
    const unitTokens = estimateTokens(unit);

    // A single unit larger than the ceiling is emitted alone rather than split
    // mid-structure; over-long context beats broken context.
    if (unitTokens > config.maxTokens) {
      if (current.length) {
        pieces.push(current.join('\n').trim());
        current = [];
        currentTokens = 0;
      }
      pieces.push(unit.trim());
      continue;
    }

    if (currentTokens + unitTokens > config.targetTokens && current.length) {
      pieces.push(current.join('\n').trim());
      // Carry the tail forward so a fact straddling the boundary appears in both.
      const overlap = takeOverlap(current, config.overlapTokens);
      current = [...overlap];
      currentTokens = overlap.reduce((total, item) => total + estimateTokens(item), 0);
    }

    current.push(unit);
    currentTokens += unitTokens;
  }

  if (current.length) pieces.push(current.join('\n').trim());
  return pieces.filter(Boolean);
}

/**
 * Break text into atomic units: fenced code blocks and table rows stay whole,
 * everything else splits into sentences.
 */
function splitIntoUnits(body: string): string[] {
  const units: string[] = [];
  const lines = body.split('\n');
  let fence: string[] | null = null;

  for (const line of lines) {
    if (/^\s*```/.test(line)) {
      if (fence) {
        fence.push(line);
        units.push(fence.join('\n'));
        fence = null;
      } else {
        fence = [line];
      }
      continue;
    }
    if (fence) {
      fence.push(line);
      continue;
    }
    // A table row is one unit — splitting it loses the column alignment.
    if (/^\s*\|.*\|\s*$/.test(line)) {
      units.push(line);
      continue;
    }
    if (!line.trim()) continue;

    for (const sentence of line.match(/[^.!?؟]+[.!?؟]+[\s]*|[^.!?؟]+$/g) ?? [line]) {
      const trimmed = sentence.trim();
      if (trimmed) units.push(trimmed);
    }
  }

  if (fence) units.push(fence.join('\n'));
  return units;
}

function takeOverlap(units: string[], overlapTokens: number): string[] {
  const overlap: string[] = [];
  let total = 0;
  for (let index = units.length - 1; index >= 0; index -= 1) {
    const tokens = estimateTokens(units[index]);
    if (total + tokens > overlapTokens) break;
    overlap.unshift(units[index]);
    total += tokens;
  }
  return overlap;
}
