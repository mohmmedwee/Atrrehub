/**
 * Detection primitives for the guardrail pipeline. Kept pure and free of
 * infrastructure so they can be reasoned about and tested exhaustively — these
 * are the checks that stand between an enterprise's data and a model.
 */

export interface Detection {
  matched: boolean;
  /** 0-1; higher means more certain. */
  confidence: number;
  evidence: string[];
}

/**
 * Prompt-injection heuristics.
 *
 * Deliberately pattern-based rather than model-based: it runs on every message
 * with no latency or cost, and it catches the overwhelming majority of real
 * attempts, which are unsubtle. A model-based classifier can be layered on top
 * for the residual, but this must never be the slow path.
 */
const INJECTION_PATTERNS: { pattern: RegExp; weight: number; label: string }[] = [
  { pattern: /ignore\s+(all\s+)?(previous|prior|above|earlier)\s+(instructions?|prompts?|rules?)/i, weight: 0.9, label: 'ignore-previous-instructions' },
  { pattern: /disregard\s+(all\s+)?(previous|prior|above|your)\s+\w+/i, weight: 0.85, label: 'disregard-instructions' },
  { pattern: /forget\s+(everything|all)\s+(you|that)/i, weight: 0.8, label: 'forget-context' },
  { pattern: /you\s+are\s+now\s+(a|an|in)\s+/i, weight: 0.6, label: 'role-reassignment' },
  { pattern: /\b(developer|debug|god|admin|sudo)\s+mode\b/i, weight: 0.75, label: 'privileged-mode' },
  // Requires the possessive "your" or an explicit "system" — "show me the
  // instructions for returning an item" is a customer asking for help, not an
  // exfiltration attempt.
  { pattern: /(reveal|show|print|repeat|output)\s+(me\s+)?(your\s+(system\s+)?(prompt|instructions?|rules?)|the\s+system\s+(prompt|instructions?))/i, weight: 0.9, label: 'system-prompt-exfiltration' },
  { pattern: /\bDAN\b|\bjailbreak\b/i, weight: 0.7, label: 'jailbreak-keyword' },
  { pattern: /pretend\s+(you|to\s+be)\s+/i, weight: 0.5, label: 'pretend' },
  { pattern: /<\s*\/?\s*(system|assistant)\s*>/i, weight: 0.8, label: 'role-tag-injection' },
  { pattern: /\[\s*(SYSTEM|INST|\/INST)\s*\]/i, weight: 0.75, label: 'template-token-injection' },
  { pattern: /(without|no)\s+(any\s+)?(restrictions?|limitations?|filters?|guardrails?)/i, weight: 0.7, label: 'restriction-removal' },
  { pattern: /new\s+(instructions?|system\s+prompt)\s*:/i, weight: 0.85, label: 'instruction-override' },
];

export function detectPromptInjection(text: string): Detection {
  const evidence: string[] = [];
  let peak = 0;

  for (const { pattern, weight, label } of INJECTION_PATTERNS) {
    if (pattern.test(text)) {
      evidence.push(label);
      peak = Math.max(peak, weight);
    }
  }

  // Several weak signals together are stronger than any one of them.
  const confidence = evidence.length > 1 ? Math.min(0.99, peak + 0.1 * (evidence.length - 1)) : peak;
  return { matched: confidence >= 0.5, confidence, evidence };
}

export type PiiKind =
  | 'email'
  | 'phone'
  | 'credit_card'
  | 'iban'
  | 'ssn'
  | 'national_id'
  | 'ip_address'
  | 'api_key';

export interface PiiMatch {
  kind: PiiKind;
  value: string;
  start: number;
  end: number;
}

const PII_PATTERNS: { kind: PiiKind; pattern: RegExp }[] = [
  { kind: 'email', pattern: /\b[\w.+-]+@[\w-]+\.[\w.-]{2,}\b/g },
  { kind: 'credit_card', pattern: /\b(?:\d[ -]*?){13,19}\b/g },
  { kind: 'iban', pattern: /\b[A-Z]{2}\d{2}[A-Z0-9]{10,30}\b/g },
  { kind: 'ssn', pattern: /\b\d{3}-\d{2}-\d{4}\b/g },
  // A permissive shape, validated below by digit count — international numbers
  // group their digits in too many ways to enumerate as patterns.
  { kind: 'ip_address', pattern: /\b(?:\d{1,3}\.){3}\d{1,3}\b/g },
  { kind: 'phone', pattern: /\+?\d[\d\s().-]{7,20}\d/g },
  { kind: 'api_key', pattern: /\b(?:sk|pk|ak|rk)[-_][A-Za-z0-9_-]{16,}\b/g },
];

/**
 * Detect PII spans. Card numbers are Luhn-validated and phone candidates are
 * length-checked, because the cost of a false positive is a masked order number
 * in a customer's own message — visible, confusing, and worse than useless.
 */
export function detectPii(text: string, kinds?: PiiKind[]): PiiMatch[] {
  const matches: PiiMatch[] = [];

  for (const { kind, pattern } of PII_PATTERNS) {
    if (kinds && !kinds.includes(kind)) continue;
    for (const match of text.matchAll(new RegExp(pattern.source, pattern.flags))) {
      const value = match[0];
      const start = match.index ?? 0;

      if (kind === 'credit_card') {
        const digits = value.replace(/\D/g, '');
        if (digits.length < 13 || digits.length > 19 || !luhn(digits)) continue;
      }
      if (kind === 'phone') {
        const digits = value.replace(/\D/g, '');
        if (digits.length < 9 || digits.length > 15) continue;
        // Reject runs that are mostly separators — those are formatting, not numbers.
        if (digits.length / value.length < 0.5) continue;
        // A dotted quad is an IP address, and is matched as one below.
        if (/^\d{1,3}(\.\d{1,3}){3}$/.test(value.trim())) continue;
      }
      if (kind === 'ip_address' && value.split('.').some((octet) => Number(octet) > 255)) continue;

      matches.push({ kind, value, start, end: start + value.length });
    }
  }

  // Resolve overlaps by keeping the longer, more specific match.
  matches.sort((a, b) => a.start - b.start || b.end - a.end);
  const resolved: PiiMatch[] = [];
  for (const match of matches) {
    if (resolved.some((existing) => match.start < existing.end && match.end > existing.start)) continue;
    resolved.push(match);
  }
  return resolved;
}

/** Replace detected PII, keeping enough of the value for a human to recognise it. */
export function maskPii(text: string, kinds?: PiiKind[]): { masked: string; matches: PiiMatch[] } {
  const matches = detectPii(text, kinds);
  if (!matches.length) return { masked: text, matches };

  let masked = '';
  let cursor = 0;
  for (const match of matches) {
    masked += text.slice(cursor, match.start) + maskValue(match);
    cursor = match.end;
  }
  masked += text.slice(cursor);
  return { masked, matches };
}

function maskValue(match: PiiMatch): string {
  switch (match.kind) {
    case 'email': {
      const [local, domain] = match.value.split('@');
      return `${local.slice(0, 2)}${'*'.repeat(Math.max(3, local.length - 2))}@${domain}`;
    }
    case 'credit_card': {
      const digits = match.value.replace(/\D/g, '');
      return `**** **** **** ${digits.slice(-4)}`;
    }
    case 'phone': {
      const digits = match.value.replace(/\D/g, '');
      return `${'*'.repeat(Math.max(0, digits.length - 4))}${digits.slice(-4)}`;
    }
    default:
      return `[${match.kind.toUpperCase()} REDACTED]`;
  }
}

function luhn(digits: string): boolean {
  let sum = 0;
  let double = false;
  for (let index = digits.length - 1; index >= 0; index -= 1) {
    let value = Number(digits[index]);
    if (double) {
      value *= 2;
      if (value > 9) value -= 9;
    }
    sum += value;
    double = !double;
  }
  return sum % 10 === 0;
}

/** Categories a customer-facing agent must never produce. */
const CONTENT_PATTERNS: { category: string; pattern: RegExp }[] = [
  { category: 'self_harm', pattern: /\b(kill|hurt|harm)\s+(yourself|themselves)\b/i },
  { category: 'violence', pattern: /\b(how\s+to\s+)?(make|build)\s+(a\s+)?(bomb|explosive|weapon)\b/i },
  { category: 'illegal', pattern: /\b(launder\s+money|buy\s+(drugs|weapons)\s+online)\b/i },
  { category: 'credentials', pattern: /\b(password|api[\s_-]?key|secret)\s+(is|=|:)\s*\S{6,}/i },
];

export function detectContentPolicy(text: string): Detection {
  const evidence = CONTENT_PATTERNS.filter(({ pattern }) => pattern.test(text)).map(({ category }) => category);
  return { matched: evidence.length > 0, confidence: evidence.length ? 0.9 : 0, evidence };
}

/**
 * Whether a tool may reach a host. Blocks private address space and anything
 * not on an explicit allow-list, so a custom tool cannot be turned into an
 * internal-network probe.
 */
export function isEgressAllowed(url: string, allowlist: string[] = []): { allowed: boolean; reason?: string } {
  let parsed: URL;
  try {
    parsed = new URL(url);
  } catch {
    return { allowed: false, reason: 'malformed URL' };
  }

  if (!['http:', 'https:'].includes(parsed.protocol)) {
    return { allowed: false, reason: `protocol ${parsed.protocol} is not permitted` };
  }
  if (isPrivateHost(parsed.hostname)) {
    return { allowed: false, reason: 'private and link-local addresses are not reachable from tools' };
  }
  if (allowlist.length) {
    const host = parsed.hostname.toLowerCase();
    const permitted = allowlist.some((entry) => {
      const candidate = entry.toLowerCase().trim();
      return host === candidate || host.endsWith(`.${candidate}`);
    });
    if (!permitted) return { allowed: false, reason: `${parsed.hostname} is not on the egress allow-list` };
  }
  return { allowed: true };
}

export function isPrivateHost(hostname: string): boolean {
  const host = hostname.toLowerCase().replace(/^\[|\]$/g, '');
  if (host === 'localhost' || host.endsWith('.localhost') || host.endsWith('.internal') || host.endsWith('.local')) return true;

  if (/^\d{1,3}(\.\d{1,3}){3}$/.test(host)) {
    const [a, b] = host.split('.').map(Number);
    return (
      a === 0 ||
      a === 10 ||
      a === 127 ||
      (a === 172 && b >= 16 && b <= 31) ||
      (a === 192 && b === 168) ||
      (a === 169 && b === 254) ||
      (a === 100 && b >= 64 && b <= 127)
    );
  }
  // IPv6 loopback, unique-local and link-local.
  return host === '::1' || host === '::' || /^f[cd]/.test(host) || host.startsWith('fe80');
}
