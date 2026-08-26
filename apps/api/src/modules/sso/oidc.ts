import { createHash, createPublicKey, randomBytes, verify as verifySignature } from 'node:crypto';

/**
 * OpenID Connect, with no new dependency.
 *
 * ID token verification is done against the provider's published JWKS using
 * Node's own JWK import, rather than by trusting the token's own claims. That
 * distinction is the whole security of the flow: an unverified ID token is
 * just an attacker-supplied JSON blob naming whichever user they like.
 */

export interface OidcConfig {
  issuer: string;
  authorizationEndpoint: string;
  tokenEndpoint: string;
  jwksUri: string;
  clientId: string;
  scopes?: string[];
  /** Claim carrying the user's groups. Defaults to `groups`. */
  groupsClaim?: string;
}

export interface IdTokenClaims {
  iss: string;
  sub: string;
  aud: string | string[];
  exp: number;
  iat: number;
  nonce?: string;
  email?: string;
  email_verified?: boolean;
  given_name?: string;
  family_name?: string;
  name?: string;
  [claim: string]: unknown;
}

export interface Jwk {
  kty: string;
  kid?: string;
  alg?: string;
  use?: string;
  n?: string;
  e?: string;
  crv?: string;
  x?: string;
  y?: string;
}

/** Algorithms accepted for an ID token, and how Node names each. */
const ALGORITHMS: Record<string, { hash: string; padding?: number; dsa?: 'ieee-p1363' }> = {
  RS256: { hash: 'RSA-SHA256' },
  RS384: { hash: 'RSA-SHA384' },
  RS512: { hash: 'RSA-SHA512' },
  ES256: { hash: 'SHA256', dsa: 'ieee-p1363' },
  ES384: { hash: 'SHA384', dsa: 'ieee-p1363' },
};

export function base64UrlDecode(value: string): Buffer {
  return Buffer.from(value.replace(/-/g, '+').replace(/_/g, '/'), 'base64');
}

/** PKCE S256: a verifier and the challenge derived from it. */
export function createPkcePair(): { verifier: string; challenge: string } {
  const verifier = randomBytes(32).toString('base64url');
  const challenge = createHash('sha256').update(verifier).digest('base64url');
  return { verifier, challenge };
}

export function buildAuthorizationUrl(
  config: OidcConfig,
  params: { redirectUri: string; state: string; nonce: string; challenge: string },
): string {
  const url = new URL(config.authorizationEndpoint);
  url.searchParams.set('response_type', 'code');
  url.searchParams.set('client_id', config.clientId);
  url.searchParams.set('redirect_uri', params.redirectUri);
  url.searchParams.set('scope', (config.scopes ?? ['openid', 'profile', 'email']).join(' '));
  url.searchParams.set('state', params.state);
  url.searchParams.set('nonce', params.nonce);
  url.searchParams.set('code_challenge', params.challenge);
  url.searchParams.set('code_challenge_method', 'S256');
  return url.toString();
}

/**
 * Verify an ID token: signature first, then the claims that bind it to this
 * request. Order matters — checking `aud` on an unverified token proves
 * nothing, since the attacker wrote it.
 */
export function verifyIdToken(
  token: string,
  keys: Jwk[],
  expected: { issuer: string; audience: string; nonce?: string; clockToleranceSec?: number },
): IdTokenClaims {
  const parts = token.split('.');
  if (parts.length !== 3) throw new Error('The ID token is not a JWS');

  const [headerB64, payloadB64, signatureB64] = parts;
  const header = JSON.parse(base64UrlDecode(headerB64).toString('utf8')) as {
    alg?: string;
    kid?: string;
  };

  const algorithm = header.alg && ALGORITHMS[header.alg];
  if (!algorithm)
    throw new Error(
      `The ID token is signed with "${header.alg}", which is not accepted. "none" and HMAC algorithms are refused.`,
    );

  // A token naming a kid must match that key; without one, any published key
  // of the right type is tried, which is what providers mid-rotation need.
  const candidates = header.kid ? keys.filter((key) => key.kid === header.kid) : keys;
  if (!candidates.length)
    throw new Error(`No key in the provider's JWKS matches kid "${header.kid ?? '(none)'}"`);

  const signed = Buffer.from(`${headerB64}.${payloadB64}`);
  const signature = base64UrlDecode(signatureB64);

  const verified = candidates.some((jwk) => {
    try {
      const key = createPublicKey({ key: jwk as never, format: 'jwk' });
      return verifySignature(
        algorithm.hash,
        signed,
        { key, dsaEncoding: algorithm.dsa },
        signature,
      );
    } catch {
      return false;
    }
  });
  if (!verified)
    throw new Error('The ID token signature does not verify against the provider JWKS');

  const claims = JSON.parse(base64UrlDecode(payloadB64).toString('utf8')) as IdTokenClaims;
  const tolerance = expected.clockToleranceSec ?? 60;
  const now = Math.floor(Date.now() / 1000);

  if (claims.iss !== expected.issuer)
    throw new Error(`The ID token was issued by "${claims.iss}", not "${expected.issuer}"`);

  const audiences = Array.isArray(claims.aud) ? claims.aud : [claims.aud];
  if (!audiences.includes(expected.audience))
    throw new Error('The ID token was not issued for this client');

  if (typeof claims.exp !== 'number' || claims.exp + tolerance < now)
    throw new Error('The ID token has expired');
  if (typeof claims.iat === 'number' && claims.iat - tolerance > now)
    throw new Error('The ID token is dated in the future');

  // Binding the nonce is what stops a token captured elsewhere being replayed
  // into this login.
  if (expected.nonce && claims.nonce !== expected.nonce)
    throw new Error('The ID token does not carry this login’s nonce');

  if (!claims.sub) throw new Error('The ID token carries no subject');

  return claims;
}

/** Names and email from whichever claims the provider chose to populate. */
export function profileFromClaims(claims: IdTokenClaims): {
  email?: string;
  firstName: string;
  lastName: string;
} {
  const email = typeof claims.email === 'string' ? claims.email.toLowerCase() : undefined;
  const given = typeof claims.given_name === 'string' ? claims.given_name : '';
  const family = typeof claims.family_name === 'string' ? claims.family_name : '';

  if (given || family) return { email, firstName: given || family, lastName: family || '' };

  const full = typeof claims.name === 'string' ? claims.name.trim() : '';
  if (full) {
    const [first, ...rest] = full.split(/\s+/);
    return { email, firstName: first, lastName: rest.join(' ') };
  }

  const local = email?.split('@')[0] ?? 'User';
  return { email, firstName: local, lastName: '' };
}

/** Groups as the provider reported them, from a claim that may be a string. */
export function groupsFromClaims(claims: IdTokenClaims, groupsClaim = 'groups'): string[] {
  const raw = claims[groupsClaim];
  if (Array.isArray(raw)) return raw.map(String);
  if (typeof raw === 'string') return raw.split(/[\s,]+/).filter(Boolean);
  return [];
}

/**
 * Resolve a role from the provider's groups.
 *
 * The mapping is ordered, and the *first* match wins rather than the most
 * permissive: an administrator who is also in the agents group should be an
 * administrator, and that is only predictable if the tenant controls the
 * order.
 */
export function resolveRole(
  groups: string[],
  mapping: { group: string; roleKey: string }[],
  defaultRole?: string,
): string | undefined {
  const normalized = new Set(groups.map((group) => group.toLowerCase()));
  for (const entry of mapping) {
    if (normalized.has(entry.group.toLowerCase())) return entry.roleKey;
  }
  return defaultRole;
}
