import type { PlanTier } from '@prisma/client';

/**
 * What each plan actually allows.
 *
 * Held in code rather than in the database because a plan is a commercial
 * contract, not tenant configuration: a limit that any administrator can raise
 * on their own row is not a limit. The `Subscription.limits` column exists for
 * the negotiated exceptions an enterprise deal produces, and overrides these
 * per tenant — deliberately, and visibly.
 */

export type LimitKey =
  | 'seats'
  | 'monthlyConversations'
  | 'knowledgeBases'
  | 'aiAgents'
  | 'workflows'
  | 'storageGb'
  | 'monthlyAiTokens'
  | 'phoneNumbers'
  | 'integrations'
  | 'dataPlanes';

export interface Plan {
  tier: PlanTier;
  name: string;
  /** Monthly list price in USD. Zero means "talk to sales". */
  monthlyPriceUsd: number;
  /** Per-seat price above the included seats. */
  perSeatUsd: number;
  /** `null` means unlimited — which only enterprise gets, and only sometimes. */
  limits: Record<LimitKey, number | null>;
  features: string[];
}

export const PLANS: Record<PlanTier, Plan> = {
  starter: {
    tier: 'starter',
    name: 'Starter',
    monthlyPriceUsd: 49,
    perSeatUsd: 19,
    limits: {
      seats: 5,
      monthlyConversations: 1_000,
      knowledgeBases: 1,
      aiAgents: 1,
      workflows: 3,
      storageGb: 5,
      monthlyAiTokens: 500_000,
      phoneNumbers: 1,
      integrations: 1,
      dataPlanes: 0,
    },
    features: ['web_chat', 'email', 'knowledge', 'ai_agent', 'analytics'],
  },

  professional: {
    tier: 'professional',
    name: 'Professional',
    monthlyPriceUsd: 199,
    perSeatUsd: 39,
    limits: {
      seats: 25,
      monthlyConversations: 10_000,
      knowledgeBases: 5,
      aiAgents: 5,
      workflows: 25,
      storageGb: 50,
      monthlyAiTokens: 5_000_000,
      phoneNumbers: 5,
      integrations: 5,
      dataPlanes: 0,
    },
    features: [
      'web_chat',
      'email',
      'whatsapp',
      'sms',
      'knowledge',
      'ai_agent',
      'workflows',
      'analytics',
      'quality',
      'automation',
    ],
  },

  business: {
    tier: 'business',
    name: 'Business',
    monthlyPriceUsd: 799,
    perSeatUsd: 59,
    limits: {
      seats: 100,
      monthlyConversations: 100_000,
      knowledgeBases: 25,
      aiAgents: 25,
      workflows: 200,
      storageGb: 500,
      monthlyAiTokens: 50_000_000,
      phoneNumbers: 25,
      integrations: 25,
      dataPlanes: 0,
    },
    features: [
      'web_chat',
      'email',
      'whatsapp',
      'sms',
      'telegram',
      'messenger',
      'instagram',
      'voice',
      'knowledge',
      'ai_agent',
      'workflows',
      'analytics',
      'quality',
      'automation',
      'wfm',
      'sso',
    ],
  },

  enterprise: {
    tier: 'enterprise',
    name: 'Enterprise',
    monthlyPriceUsd: 0,
    perSeatUsd: 0,
    limits: {
      seats: null,
      monthlyConversations: null,
      knowledgeBases: null,
      aiAgents: null,
      workflows: null,
      storageGb: null,
      monthlyAiTokens: null,
      phoneNumbers: null,
      integrations: null,
      dataPlanes: null,
    },
    features: ['*'],
  },
};

/** How a limit reads to a person, for the message they see when they hit it. */
export const LIMIT_LABELS: Record<LimitKey, string> = {
  seats: 'users',
  monthlyConversations: 'conversations this month',
  knowledgeBases: 'knowledge bases',
  aiAgents: 'AI agents',
  workflows: 'workflows',
  storageGb: 'GB of storage',
  monthlyAiTokens: 'AI tokens this month',
  phoneNumbers: 'phone numbers',
  integrations: 'integrations',
  dataPlanes: 'data planes',
};

/**
 * The effective limit for a tenant: the plan's, unless their subscription
 * negotiated something else.
 *
 * An override of `null` means unlimited, which is a legitimate thing for a
 * contract to say — so the absence of a key is what falls back to the plan,
 * not a falsy value.
 */
export function effectiveLimit(
  tier: PlanTier,
  key: LimitKey,
  overrides?: Record<string, unknown> | null,
): number | null {
  if (overrides && Object.hasOwn(overrides, key)) {
    const value = overrides[key];
    if (value === null) return null;
    const numeric = Number(value);
    if (Number.isFinite(numeric) && numeric >= 0) return numeric;
  }
  return PLANS[tier].limits[key];
}

export function hasFeature(tier: PlanTier, feature: string): boolean {
  const plan = PLANS[tier];
  return plan.features.includes('*') || plan.features.includes(feature);
}
