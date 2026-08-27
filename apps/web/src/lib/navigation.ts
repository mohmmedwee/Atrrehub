import {
  Activity,
  BarChart3,
  Bot,
  Braces,
  CalendarClock,
  CreditCard,
  Database,
  FileText,
  Gauge,
  Inbox,
  KeyRound,
  LifeBuoy,
  type LucideIcon,
  Phone,
  Plug,
  ScrollText,
  ShieldCheck,
  Ticket,
  Users,
  Workflow,
} from 'lucide-react';

/**
 * Every surface the product has, in one place.
 *
 * The old shell hard-coded four links in a top bar, which is why fourteen
 * capabilities that the API fully supports had nowhere to live and were simply
 * unreachable. A grouped list scales; a row of tabs does not.
 *
 * `status` is deliberately part of the model rather than a comment. A surface
 * whose API exists but whose screen does not is still worth showing — a
 * disabled row with a reason tells an operator the capability is coming, where
 * silence tells them it does not exist.
 */
export interface NavItem {
  href: string;
  label: string;
  icon: LucideIcon;
  /** Server permission required to see it at all. */
  permission: string;
  /** Extra words that should match this item in the command palette. */
  keywords?: string;
  status?: 'ready' | 'planned';
}

export interface NavGroup {
  label: string;
  items: NavItem[];
}

export const NAV_GROUPS: NavGroup[] = [
  {
    label: 'Work',
    items: [
      {
        href: '/workspace',
        label: 'Inbox',
        icon: Inbox,
        permission: 'conversation:read',
        keywords: 'conversations queue chat messages',
      },
      {
        href: '/tickets',
        label: 'Tickets',
        icon: Ticket,
        permission: 'ticket:read',
        keywords: 'cases issues sla',
      },
      {
        href: '/customers',
        label: 'Customers',
        icon: Users,
        permission: 'customer:read',
        keywords: 'contacts people accounts',
        status: 'planned',
      },
      {
        href: '/calls',
        label: 'Calls',
        icon: Phone,
        permission: 'call:read',
        keywords: 'voice telephony ivr recordings',
        status: 'planned',
      },
    ],
  },
  {
    label: 'Intelligence',
    items: [
      {
        href: '/ai',
        label: 'AI Studio',
        icon: Bot,
        permission: 'agent:read',
        keywords: 'agents prompts workflows executions debugger',
      },
      {
        href: '/knowledge',
        label: 'Knowledge',
        icon: LifeBuoy,
        permission: 'knowledge:read',
        keywords: 'articles help centre rag documents',
        status: 'planned',
      },
      {
        href: '/quality',
        label: 'Quality',
        icon: ShieldCheck,
        permission: 'qc:read_all',
        keywords: 'qa scorecards evaluations calibration',
        status: 'planned',
      },
      {
        href: '/evaluation',
        label: 'Evaluation',
        icon: Gauge,
        permission: 'eval:manage',
        keywords: 'datasets gates scorers benchmarks',
        status: 'planned',
      },
    ],
  },
  {
    label: 'Insight',
    items: [
      {
        href: '/analytics',
        label: 'Analytics',
        icon: BarChart3,
        permission: 'analytics:read',
        keywords: 'dashboard metrics kpi charts',
      },
      {
        href: '/reports',
        label: 'Reports',
        icon: FileText,
        permission: 'report:manage',
        keywords: 'saved reports export csv scheduled',
        status: 'planned',
      },
      {
        href: '/wfm',
        label: 'Workforce',
        icon: CalendarClock,
        permission: 'wfm:read',
        keywords: 'forecast staffing shifts rosters adherence erlang',
        status: 'planned',
      },
    ],
  },
  {
    label: 'Configure',
    items: [
      {
        href: '/admin',
        label: 'Admin',
        icon: Users,
        permission: 'organization:read',
        keywords: 'people queues teams roles business hours',
      },
      {
        href: '/automation',
        label: 'Automation',
        icon: Workflow,
        permission: 'automation:manage',
        keywords: 'rules triggers actions macros',
        status: 'planned',
      },
      {
        href: '/integrations',
        label: 'Integrations',
        icon: Plug,
        permission: 'integration:manage',
        keywords: 'crm salesforce hubspot sync connectors',
        status: 'planned',
      },
      {
        href: '/webhooks',
        label: 'Developers',
        icon: Braces,
        permission: 'webhook:manage',
        keywords: 'webhooks api keys sdk deliveries events',
        status: 'planned',
      },
    ],
  },
  {
    label: 'Governance',
    items: [
      {
        href: '/governance',
        label: 'AI Governance',
        icon: ShieldCheck,
        permission: 'governance:manage',
        keywords: 'policy retention erasure access review gdpr subject rights',
        status: 'planned',
      },
      {
        href: '/billing',
        label: 'Billing & plans',
        icon: CreditCard,
        permission: 'billing:read',
        keywords: 'subscription usage invoice limits seats plan',
        status: 'planned',
      },
      {
        href: '/sso',
        label: 'SSO & SCIM',
        icon: KeyRound,
        permission: 'organization:manage',
        keywords: 'saml oidc identity provisioning directory',
        status: 'planned',
      },
      {
        href: '/audit',
        label: 'Audit log',
        icon: ScrollText,
        permission: 'audit:read',
        keywords: 'history who did what trail',
        status: 'planned',
      },
    ],
  },
  {
    label: 'Operations',
    items: [
      {
        href: '/resilience',
        label: 'Queues & jobs',
        icon: Activity,
        permission: 'organization:manage',
        keywords: 'dead letters replay partitions replica background',
        status: 'planned',
      },
      {
        href: '/dr',
        label: 'Backups',
        icon: Database,
        permission: 'organization:manage',
        keywords: 'disaster recovery restore snapshots',
        status: 'planned',
      },
    ],
  },
];

/** Mirrors the server's rule: an explicit grant, a `:manage` grant, or `*`. */
export function allows(granted: string[], required: string): boolean {
  if (granted.includes('*') || granted.includes(required)) return true;
  return granted.includes(`${required.split(':')[0]}:manage`);
}

/** The groups this principal may see, with empty groups dropped. */
export function visibleGroups(permissions: string[]): NavGroup[] {
  return NAV_GROUPS.map((group) => ({
    ...group,
    items: group.items.filter((item) => allows(permissions, item.permission)),
  })).filter((group) => group.items.length > 0);
}

export function flatItems(permissions: string[]): NavItem[] {
  return visibleGroups(permissions).flatMap((group) => group.items);
}
