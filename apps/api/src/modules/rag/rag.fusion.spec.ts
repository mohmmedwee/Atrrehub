import { describe, expect, it } from 'vitest';
import { RagService, type RetrievalHit } from './rag.service';

/** The fusion and groundedness logic is pure, so it can be exercised directly. */
const service = Object.create(RagService.prototype) as RagService;

const hit = (chunkId: string, content = 'content'): RetrievalHit => ({
  chunkId,
  documentId: `doc-${chunkId}`,
  knowledgeBaseId: 'kb1',
  title: `Doc ${chunkId}`,
  content,
  score: 0,
  version: 1,
});

describe('reciprocal rank fusion', () => {
  it('ranks a result found by both searches above one found by only one', () => {
    const vector = [hit('a'), hit('b')];
    const keyword = [hit('c'), hit('a')];
    const fused = service.fuse(vector, keyword);
    expect(fused[0].chunkId).toBe('a');
  });

  it('keeps every distinct result', () => {
    const fused = service.fuse([hit('a'), hit('b')], [hit('c')]);
    expect(fused.map((h) => h.chunkId).sort()).toEqual(['a', 'b', 'c']);
  });

  it('records which list each result came from', () => {
    const fused = service.fuse([hit('a')], [hit('a')]);
    expect(fused[0].vectorRank).toBe(1);
    expect(fused[0].keywordRank).toBe(1);
  });

  it('marks a vector-only result with no keyword rank', () => {
    const fused = service.fuse([hit('a')], [hit('b')]);
    const a = fused.find((h) => h.chunkId === 'a')!;
    expect(a.vectorRank).toBe(1);
    expect(a.keywordRank).toBeUndefined();
  });

  it('preserves order within a single list', () => {
    const fused = service.fuse([hit('a'), hit('b'), hit('c')], []);
    expect(fused.map((h) => h.chunkId)).toEqual(['a', 'b', 'c']);
  });

  it('returns nothing when neither search matched', () => {
    expect(service.fuse([], [])).toEqual([]);
  });

  it('lets a strong keyword match outrank a weak vector match', () => {
    // 'x' is 3rd by vector but 1st by keyword; 'y' is 2nd by vector only.
    const vector = [hit('p'), hit('y'), hit('x')];
    const keyword = [hit('x')];
    const fused = service.fuse(vector, keyword);
    expect(fused.findIndex((h) => h.chunkId === 'x')).toBeLessThan(fused.findIndex((h) => h.chunkId === 'y'));
  });
});

describe('groundedness', () => {
  const sources = [hit('a', 'Refunds are processed within three working days of approval by the billing team.')];

  it('scores an answer drawn from the sources as grounded', () => {
    const result = service.groundedness('Refunds are processed within three working days of approval.', sources);
    expect(result.score).toBe(1);
    expect(result.unsupported).toEqual([]);
  });

  it('flags a sentence that the sources do not support', () => {
    const answer = 'Refunds are processed within three working days of approval. We also guarantee compensation vouchers for every delayed shipment.';
    const result = service.groundedness(answer, sources);
    expect(result.score).toBeLessThan(1);
    expect(result.unsupported.join(' ')).toContain('compensation vouchers');
  });

  it('reports zero when nothing was retrieved', () => {
    expect(service.groundedness('Anything at all.', []).score).toBe(0);
  });

  it('treats a very short answer as grounded rather than guessing', () => {
    expect(service.groundedness('Yes.', sources).score).toBe(1);
  });
});
