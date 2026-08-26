import { createSign, generateKeyPairSync, type KeyObject } from 'node:crypto';
import { describe, expect, it } from 'vitest';
import {
  buildAuthorizationUrl,
  createPkcePair,
  groupsFromClaims,
  profileFromClaims,
  resolveRole,
  verifyIdToken,
  type IdTokenClaims,
  type Jwk,
} from './oidc';

/** A throwaway provider: a real RSA key pair, published as a real JWKS. */
const { publicKey, privateKey } = generateKeyPairSync('rsa', { modulusLength: 2048 });
const jwk = { ...(publicKey.export({ format: 'jwk' }) as Jwk), kid: 'key-1', alg: 'RS256' };

const other = generateKeyPairSync('rsa', { modulusLength: 2048 });

const now = () => Math.floor(Date.now() / 1000);

function sign(claims: Partial<IdTokenClaims>, key: KeyObject = privateKey, header = {}): string {
  const head = Buffer.from(
    JSON.stringify({ alg: 'RS256', typ: 'JWT', kid: 'key-1', ...header }),
  ).toString('base64url');
  const body = Buffer.from(
    JSON.stringify({
      iss: 'https://idp.example.com',
      sub: 'user-1',
      aud: 'client-abc',
      exp: now() + 300,
      iat: now(),
      nonce: 'nonce-1',
      ...claims,
    }),
  ).toString('base64url');

  const signer = createSign('RSA-SHA256');
  signer.update(`${head}.${body}`);
  return `${head}.${body}.${signer.sign(key).toString('base64url')}`;
}

const expected = { issuer: 'https://idp.example.com', audience: 'client-abc', nonce: 'nonce-1' };

describe('verifyIdToken', () => {
  it('accepts a correctly signed token', () => {
    const claims = verifyIdToken(sign({ email: 'ada@example.com' }), [jwk], expected);
    expect(claims.sub).toBe('user-1');
    expect(claims.email).toBe('ada@example.com');
  });

  it('rejects a token signed by a different key', () => {
    expect(() => verifyIdToken(sign({}, other.privateKey), [jwk], expected)).toThrow(
      /signature does not verify/,
    );
  });

  it('rejects a tampered payload', () => {
    const token = sign({ sub: 'user-1' });
    const [head, , signature] = token.split('.');
    const forged = Buffer.from(JSON.stringify({ ...expected, sub: 'admin' })).toString('base64url');
    expect(() => verifyIdToken(`${head}.${forged}.${signature}`, [jwk], expected)).toThrow();
  });

  it('refuses alg "none"', () => {
    const head = Buffer.from(JSON.stringify({ alg: 'none', typ: 'JWT' })).toString('base64url');
    const body = Buffer.from(
      JSON.stringify({
        iss: expected.issuer,
        sub: 'admin',
        aud: expected.audience,
        exp: now() + 60,
      }),
    ).toString('base64url');
    expect(() => verifyIdToken(`${head}.${body}.`, [jwk], expected)).toThrow(/not accepted/);
  });

  it('refuses an HMAC algorithm, which would treat the public key as a secret', () => {
    expect(() => verifyIdToken(sign({}, privateKey, { alg: 'HS256' }), [jwk], expected)).toThrow(
      /not accepted/,
    );
  });

  it('rejects a token from another issuer', () => {
    expect(() => verifyIdToken(sign({ iss: 'https://evil.example' }), [jwk], expected)).toThrow(
      /issued by/,
    );
  });

  it('rejects a token issued for another client', () => {
    expect(() => verifyIdToken(sign({ aud: 'someone-else' }), [jwk], expected)).toThrow(
      /not issued for this client/,
    );
  });

  it('accepts a token whose audience array contains this client', () => {
    expect(verifyIdToken(sign({ aud: ['other', 'client-abc'] }), [jwk], expected).sub).toBe(
      'user-1',
    );
  });

  it('rejects an expired token', () => {
    expect(() => verifyIdToken(sign({ exp: now() - 3600 }), [jwk], expected)).toThrow(/expired/);
  });

  it('rejects a replayed token carrying a different login’s nonce', () => {
    expect(() => verifyIdToken(sign({ nonce: 'someone-elses' }), [jwk], expected)).toThrow(/nonce/);
  });

  it('rejects a token whose kid matches no published key', () => {
    expect(() =>
      verifyIdToken(sign({}, privateKey, { kid: 'rotated-away' }), [jwk], expected),
    ).toThrow(/No key/);
  });

  it('tries every published key when the token names no kid', () => {
    const otherJwk = { ...(other.publicKey.export({ format: 'jwk' }) as Jwk), kid: 'key-0' };
    const token = sign({}, privateKey, { kid: undefined });
    expect(verifyIdToken(token, [otherJwk, { ...jwk, kid: undefined }], expected).sub).toBe(
      'user-1',
    );
  });

  it('rejects something that is not a JWS at all', () => {
    expect(() => verifyIdToken('not.a.token.at.all', [jwk], expected)).toThrow(/not a JWS/);
  });
});

describe('PKCE', () => {
  it('derives a challenge that differs from the verifier', () => {
    const { verifier, challenge } = createPkcePair();
    expect(verifier).not.toBe(challenge);
    expect(verifier.length).toBeGreaterThanOrEqual(43);
  });

  it('produces a fresh verifier each time', () => {
    expect(createPkcePair().verifier).not.toBe(createPkcePair().verifier);
  });
});

describe('buildAuthorizationUrl', () => {
  it('carries state, nonce and the S256 challenge', () => {
    const url = new URL(
      buildAuthorizationUrl(
        {
          issuer: 'https://idp.example.com',
          authorizationEndpoint: 'https://idp.example.com/authorize',
          tokenEndpoint: 'https://idp.example.com/token',
          jwksUri: 'https://idp.example.com/jwks',
          clientId: 'client-abc',
        },
        {
          redirectUri: 'https://app.example.com/cb',
          state: 'st',
          nonce: 'no',
          challenge: 'ch',
        },
      ),
    );
    expect(url.searchParams.get('response_type')).toBe('code');
    expect(url.searchParams.get('state')).toBe('st');
    expect(url.searchParams.get('nonce')).toBe('no');
    expect(url.searchParams.get('code_challenge_method')).toBe('S256');
    expect(url.searchParams.get('scope')).toBe('openid profile email');
  });
});

describe('profile and group mapping', () => {
  it('prefers the structured name claims', () => {
    expect(
      profileFromClaims({ given_name: 'Ada', family_name: 'Lovelace' } as IdTokenClaims),
    ).toMatchObject({ firstName: 'Ada', lastName: 'Lovelace' });
  });

  it('splits a single name claim', () => {
    expect(profileFromClaims({ name: 'Grace Brewster Hopper' } as IdTokenClaims)).toMatchObject({
      firstName: 'Grace',
      lastName: 'Brewster Hopper',
    });
  });

  it('falls back to the email local part rather than leaving a name blank', () => {
    expect(profileFromClaims({ email: 'Ada@Example.com' } as IdTokenClaims)).toMatchObject({
      email: 'ada@example.com',
      firstName: 'ada',
    });
  });

  it('reads groups from an array or a delimited string', () => {
    expect(groupsFromClaims({ groups: ['a', 'b'] } as unknown as IdTokenClaims)).toEqual([
      'a',
      'b',
    ]);
    expect(groupsFromClaims({ roles: 'a, b' } as unknown as IdTokenClaims, 'roles')).toEqual([
      'a',
      'b',
    ]);
    expect(groupsFromClaims({} as IdTokenClaims)).toEqual([]);
  });

  it('takes the first matching rule, not the most permissive', () => {
    const mapping = [
      { group: 'support-admins', roleKey: 'admin' },
      { group: 'support-agents', roleKey: 'agent' },
    ];
    expect(resolveRole(['support-agents', 'support-admins'], mapping)).toBe('admin');
    expect(resolveRole(['support-agents'], mapping)).toBe('agent');
  });

  it('matches group names case-insensitively', () => {
    expect(resolveRole(['SUPPORT-ADMINS'], [{ group: 'support-admins', roleKey: 'admin' }])).toBe(
      'admin',
    );
  });

  it('falls back to the default role, and to nothing when there is none', () => {
    expect(resolveRole(['unknown'], [], 'viewer')).toBe('viewer');
    expect(resolveRole(['unknown'], [])).toBeUndefined();
  });
});
