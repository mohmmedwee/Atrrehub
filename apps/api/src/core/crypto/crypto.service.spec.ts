import { beforeAll, describe, expect, it } from 'vitest';
import { CryptoService } from './crypto.service';

describe('CryptoService', () => {
  let crypto: CryptoService;

  beforeAll(() => {
    crypto = new CryptoService('test-encryption-key-that-is-long-enough-000000');
  });

  describe('symmetric encryption', () => {
    it('round-trips a value', () => {
      const secret = 'sk-live-abc123';
      expect(crypto.decrypt(crypto.encrypt(secret))).toBe(secret);
    });

    it('produces a different ciphertext each time', () => {
      expect(crypto.encrypt('same')).not.toBe(crypto.encrypt('same'));
    });

    it('rejects a tampered ciphertext rather than returning garbage', () => {
      const payload = crypto.encrypt('sensitive');
      const parts = payload.split('.');
      parts[3] = Buffer.from('tampered').toString('base64url');
      expect(() => crypto.decrypt(parts.join('.'))).toThrow();
    });

    it('encrypts string leaves of an object and leaves other types alone', () => {
      const encrypted = crypto.encryptObject({ apiKey: 'secret', timeout: 30, enabled: true });
      expect(encrypted.apiKey).not.toBe('secret');
      expect(encrypted.timeout).toBe(30);
      expect(crypto.decryptObject(encrypted)).toEqual({
        apiKey: 'secret',
        timeout: 30,
        enabled: true,
      });
    });
  });

  describe('password hashing', () => {
    it('verifies the correct password', async () => {
      const hash = await crypto.hashPassword('Str0ngPassword!23');
      expect(await crypto.verifyPassword('Str0ngPassword!23', hash)).toBe(true);
    });

    it('rejects a wrong password', async () => {
      const hash = await crypto.hashPassword('Str0ngPassword!23');
      expect(await crypto.verifyPassword('Str0ngPassword!24', hash)).toBe(false);
    });

    it('salts, so identical passwords hash differently', async () => {
      expect(await crypto.hashPassword('same')).not.toBe(await crypto.hashPassword('same'));
    });

    it('returns false for a malformed stored hash instead of throwing', async () => {
      expect(await crypto.verifyPassword('x', 'not-a-hash')).toBe(false);
      expect(await crypto.verifyPassword('x', '')).toBe(false);
    });

    it('normalizes unicode so equivalent inputs match', async () => {
      // "é" as a single code point vs. e + combining accent.
      const hash = await crypto.hashPassword('caféPassword12');
      expect(await crypto.verifyPassword('caféPassword12', hash)).toBe(true);
    });
  });

  describe('token helpers', () => {
    it('hashes deterministically so lookups by hash work', () => {
      expect(crypto.hashToken('rt_abc')).toBe(crypto.hashToken('rt_abc'));
      expect(crypto.hashToken('rt_abc')).not.toBe(crypto.hashToken('rt_abd'));
    });

    it('compares in constant time and tolerates length mismatch', () => {
      expect(crypto.safeEqual('abc', 'abc')).toBe(true);
      expect(crypto.safeEqual('abc', 'abd')).toBe(false);
      expect(crypto.safeEqual('abc', 'abcd')).toBe(false);
    });

    it('signs stably with HMAC', () => {
      expect(crypto.hmac('payload', 'secret')).toBe(crypto.hmac('payload', 'secret'));
      expect(crypto.hmac('payload', 'secret')).not.toBe(crypto.hmac('payload', 'other'));
    });

    it('generates codes of the requested length', () => {
      expect(crypto.randomCode(6)).toMatch(/^\d{6}$/);
    });
  });
});
