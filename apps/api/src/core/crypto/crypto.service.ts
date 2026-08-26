import { Injectable } from '@nestjs/common';
import {
  createCipheriv,
  createDecipheriv,
  createHash,
  createHmac,
  randomBytes,
  scrypt as scryptCb,
  timingSafeEqual,
} from 'node:crypto';
import type { ScryptOptions } from 'node:crypto';

/** `promisify` cannot see the options overload, so wrap it explicitly. */
const scrypt = (
  password: string,
  salt: Buffer,
  keylen: number,
  options: ScryptOptions,
): Promise<Buffer> =>
  new Promise((resolve, reject) => {
    scryptCb(password, salt, keylen, options, (error, derived) =>
      error ? reject(error) : resolve(derived),
    );
  });

const ALGORITHM = 'aes-256-gcm';
const IV_LENGTH = 12;
const TAG_LENGTH = 16;
const SALT_LENGTH = 16;
/** scrypt parameters: ~64 MB memory, deliberately expensive to brute force. */
const SCRYPT_N = 16384;
const SCRYPT_R = 8;
const SCRYPT_P = 2;
const KEY_LENGTH = 32;

/**
 * Symmetric encryption for credentials at rest, password hashing, and the HMAC
 * primitives used for webhook signing and opaque token storage.
 */
@Injectable()
export class CryptoService {
  private readonly masterKey: Buffer;

  constructor(encryptionKey: string) {
    // Derive a fixed-length key so operators can supply any sufficiently long secret.
    this.masterKey = createHash('sha256').update(encryptionKey).digest();
  }

  /** AES-256-GCM. Output is `v1.<iv>.<tag>.<ciphertext>`, all base64url. */
  encrypt(plaintext: string): string {
    const iv = randomBytes(IV_LENGTH);
    const cipher = createCipheriv(ALGORITHM, this.masterKey, iv);
    const ciphertext = Buffer.concat([cipher.update(plaintext, 'utf8'), cipher.final()]);
    const tag = cipher.getAuthTag();
    return [
      'v1',
      iv.toString('base64url'),
      tag.toString('base64url'),
      ciphertext.toString('base64url'),
    ].join('.');
  }

  decrypt(payload: string): string {
    const [version, ivB64, tagB64, dataB64] = payload.split('.');
    if (version !== 'v1' || !ivB64 || !tagB64 || !dataB64) {
      throw new Error('Malformed ciphertext');
    }
    const decipher = createDecipheriv(ALGORITHM, this.masterKey, Buffer.from(ivB64, 'base64url'));
    decipher.setAuthTag(Buffer.from(tagB64, 'base64url'));
    return Buffer.concat([
      decipher.update(Buffer.from(dataB64, 'base64url')),
      decipher.final(),
    ]).toString('utf8');
  }

  /** Encrypt every string leaf of an object, leaving structure and keys intact. */
  encryptObject(value: Record<string, unknown>): Record<string, unknown> {
    const out: Record<string, unknown> = {};
    for (const [k, v] of Object.entries(value)) {
      out[k] = typeof v === 'string' ? this.encrypt(v) : v;
    }
    return out;
  }

  decryptObject(value: Record<string, unknown>): Record<string, unknown> {
    const out: Record<string, unknown> = {};
    for (const [k, v] of Object.entries(value)) {
      out[k] = typeof v === 'string' && v.startsWith('v1.') ? this.decrypt(v) : v;
    }
    return out;
  }

  /**
   * Password hashing. scrypt is used rather than Argon2id because it is in the
   * Node standard library — no native build step, which matters for air-gapped
   * and private-cloud installs. Parameters are tuned to Argon2id-comparable cost.
   * Format: `scrypt$N$r$p$salt$hash`.
   */
  async hashPassword(password: string): Promise<string> {
    const salt = randomBytes(SALT_LENGTH);
    const derived = await scrypt(password.normalize('NFKC'), salt, KEY_LENGTH, {
      N: SCRYPT_N,
      r: SCRYPT_R,
      p: SCRYPT_P,
      maxmem: 256 * 1024 * 1024,
    });
    return [
      'scrypt',
      SCRYPT_N,
      SCRYPT_R,
      SCRYPT_P,
      salt.toString('base64url'),
      derived.toString('base64url'),
    ].join('$');
  }

  async verifyPassword(password: string, stored: string): Promise<boolean> {
    const parts = stored.split('$');
    if (parts.length !== 6 || parts[0] !== 'scrypt') return false;
    const [, n, r, p, saltB64, hashB64] = parts;
    const expected = Buffer.from(hashB64, 'base64url');
    const derived = await scrypt(
      password.normalize('NFKC'),
      Buffer.from(saltB64, 'base64url'),
      expected.length,
      {
        N: Number(n),
        r: Number(r),
        p: Number(p),
        maxmem: 256 * 1024 * 1024,
      },
    );
    return derived.length === expected.length && timingSafeEqual(derived, expected);
  }

  /** SHA-256, used to store opaque tokens (refresh tokens, API keys) at rest. */
  hashToken(token: string): string {
    return createHash('sha256').update(token).digest('hex');
  }

  hmac(payload: string, secret: string): string {
    return createHmac('sha256', secret).update(payload).digest('hex');
  }

  /** Constant-time comparison that tolerates different-length inputs. */
  safeEqual(a: string, b: string): boolean {
    const bufA = Buffer.from(a);
    const bufB = Buffer.from(b);
    if (bufA.length !== bufB.length) return false;
    return timingSafeEqual(bufA, bufB);
  }

  randomToken(bytes = 32): string {
    return randomBytes(bytes).toString('base64url');
  }

  /** Short numeric code for email verification and MFA recovery. */
  randomCode(digits = 6): string {
    const max = 10 ** digits;
    return (parseInt(randomBytes(4).toString('hex'), 16) % max).toString().padStart(digits, '0');
  }

  contentHash(content: string): string {
    return createHash('sha256').update(content).digest('hex');
  }
}
