import { describe, expect, it } from 'vitest';
import { parseDuration } from './auth.service';

describe('parseDuration', () => {
  it('parses each supported unit', () => {
    expect(parseDuration('500ms')).toBe(500);
    expect(parseDuration('45s')).toBe(45_000);
    expect(parseDuration('15m')).toBe(900_000);
    expect(parseDuration('12h')).toBe(43_200_000);
    expect(parseDuration('30d')).toBe(2_592_000_000);
  });

  it('tolerates surrounding whitespace', () => {
    expect(parseDuration(' 15m ')).toBe(900_000);
  });

  it('rejects anything it cannot interpret rather than guessing', () => {
    expect(() => parseDuration('15')).toThrow();
    expect(() => parseDuration('15 weeks')).toThrow();
    expect(() => parseDuration('')).toThrow();
  });
});
