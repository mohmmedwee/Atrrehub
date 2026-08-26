import { describe, expect, it } from 'vitest';
import { CustomersService } from './customers.service';

const { normalize } = CustomersService;

describe('contact normalization', () => {
  it('lower-cases and trims email so casing never splits an identity', () => {
    expect(normalize('email', '  Ada@Example.COM ')).toBe('ada@example.com');
  });

  it('strips phone formatting but keeps the country prefix', () => {
    expect(normalize('phone', '+1 (555) 010-9999')).toBe('+15550109999');
    expect(normalize('phone', '+1-555-010-9999')).toBe('+15550109999');
    expect(normalize('whatsapp', '+962 7 9000 0000')).toBe('+962790000000');
  });

  it('collapses formatting variants of the same number to one key', () => {
    const variants = ['+15550109999', '+1 555 010 9999', '+1 (555) 010-9999', ' +1.555.010.9999 '];
    const normalized = new Set(variants.map((v) => normalize('phone', v)));
    expect(normalized.size).toBe(1);
  });

  it('keeps distinct numbers distinct', () => {
    expect(normalize('phone', '+15550109999')).not.toBe(normalize('phone', '+15550109998'));
  });

  it('falls back to trimmed lower case for opaque identifiers', () => {
    expect(normalize('external', '  CRM-ABC123 ')).toBe('crm-abc123');
  });
});
