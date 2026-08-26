import { describe, expect, it } from 'vitest';
import { chunkDocument } from './chunker';

describe('chunkDocument', () => {
  it('returns nothing for empty input', () => {
    expect(chunkDocument('')).toEqual([]);
    expect(chunkDocument('   \n\n  ')).toEqual([]);
  });

  it('keeps a short document as a single chunk', () => {
    const chunks = chunkDocument('Refunds are processed within three working days.');
    expect(chunks).toHaveLength(1);
    expect(chunks[0].content).toContain('three working days');
  });

  it('splits on headings so each chunk covers one topic', () => {
    const document = ['# Refunds', 'Refunds take three days.', '', '# Shipping', 'Shipping takes five days.'].join('\n');
    const chunks = chunkDocument(document);
    expect(chunks).toHaveLength(2);
    expect(chunks[0].heading).toBe('Refunds');
    expect(chunks[1].heading).toBe('Shipping');
  });

  it('repeats the heading inside the chunk so retrieved context stays self-describing', () => {
    const chunks = chunkDocument('## Billing policy\nInvoices are issued monthly.');
    expect(chunks[0].content.startsWith('Billing policy')).toBe(true);
  });

  it('numbers chunks in document order', () => {
    const document = ['# A', 'Alpha.', '# B', 'Beta.', '# C', 'Gamma.'].join('\n');
    expect(chunkDocument(document).map((c) => c.position)).toEqual([0, 1, 2]);
  });

  it('splits a long section into several chunks', () => {
    const sentence = 'This is a sentence about the refund policy that repeats. ';
    const chunks = chunkDocument(sentence.repeat(400), { targetTokens: 200, maxTokens: 300 });
    expect(chunks.length).toBeGreaterThan(1);
  });

  it('overlaps consecutive chunks so a fact on a boundary survives', () => {
    const sentences = Array.from({ length: 120 }, (_, i) => `Fact number ${i} explains part of the billing policy.`).join(' ');
    const chunks = chunkDocument(sentences, { targetTokens: 120, overlapTokens: 40, maxTokens: 240 });
    expect(chunks.length).toBeGreaterThan(1);

    const tailOfFirst = chunks[0].content.split(/(?<=\.)\s+/).slice(-2).join(' ');
    // At least part of the first chunk's tail reappears at the head of the next.
    const overlapFound = tailOfFirst
      .split(/(?<=\.)\s+/)
      .some((sentence) => sentence.trim() && chunks[1].content.includes(sentence.trim()));
    expect(overlapFound).toBe(true);
  });

  it('never splits a fenced code block', () => {
    const code = ['```js', ...Array.from({ length: 60 }, (_, i) => `const line${i} = ${i};`), '```'].join('\n');
    const document = `Intro sentence.\n\n${code}\n\nClosing sentence.`;
    const chunks = chunkDocument(document, { targetTokens: 50, maxTokens: 80 });

    const opens = chunks.reduce((total, chunk) => total + (chunk.content.match(/```/g) ?? []).length, 0);
    // Every fence marker is still paired, so no chunk holds half a code block.
    expect(opens % 2).toBe(0);
    const holdingCode = chunks.find((chunk) => chunk.content.includes('const line0'));
    expect(holdingCode!.content).toContain('const line59');
  });

  it('keeps table rows intact', () => {
    const rows = Array.from({ length: 40 }, (_, i) => `| Plan ${i} | ${i * 10} USD | monthly |`).join('\n');
    const chunks = chunkDocument(`| Plan | Price | Cycle |\n${rows}`, { targetTokens: 60, maxTokens: 120 });
    for (const chunk of chunks) {
      for (const line of chunk.content.split('\n').filter((l) => l.includes('|'))) {
        // A row that starts with a pipe must also end with one.
        expect(line.trim().endsWith('|')).toBe(true);
      }
    }
  });

  it('handles Arabic text, which the routing rules assume is first class', () => {
    const arabic = 'يتم معالجة المبالغ المستردة خلال ثلاثة أيام عمل. يرجى الاحتفاظ برقم الطلب.';
    const chunks = chunkDocument(arabic);
    expect(chunks).toHaveLength(1);
    expect(chunks[0].content).toContain('المبالغ المستردة');
    expect(chunks[0].tokenCount).toBeGreaterThan(0);
  });

  it('reports a token count for every chunk', () => {
    for (const chunk of chunkDocument('# Title\nSome content here that is long enough to measure.')) {
      expect(chunk.tokenCount).toBeGreaterThan(0);
    }
  });
});
