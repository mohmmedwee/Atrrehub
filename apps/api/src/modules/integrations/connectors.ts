/**
 * Integration connectors.
 *
 * Every provider is expressed as configuration over one generic REST client
 * rather than as its own code path. A Salesforce integration and a bespoke
 * internal API differ in their base URL, how they authenticate, where the
 * records live in the response and what the fields are called — not in what
 * has to happen. Keeping that as data means a new CRM is a preset, and the
 * egress, retry and error handling stay in one place where they can be
 * audited.
 */

export type AuthKind = 'bearer' | 'api_key_header' | 'basic' | 'query_param' | 'none';

export interface ConnectorConfig {
  /** Root of the provider's API. Must be https in production. */
  baseUrl: string;
  auth: AuthKind;
  /** Header or query parameter name, for the kinds that need one. */
  authParam?: string;
  /** Path appended to baseUrl to list contacts. */
  contactsPath: string;
  /** Dotted path to the array of records in the response body. */
  recordsPath?: string;
  /** Dotted path to the next-page cursor or URL, when the provider paginates. */
  nextPath?: string;
  /** Query parameter carrying the page cursor. */
  cursorParam?: string;
  pageSize?: number;
  pageSizeParam?: string;
  /** Extra static query parameters. */
  query?: Record<string, string>;
  headers?: Record<string, string>;
}

export interface ConnectorPreset {
  label: string;
  /** Defaults a tenant can accept wholesale or override field by field. */
  config: Partial<ConnectorConfig>;
  /** Credential keys this provider needs, so the UI can ask for them by name. */
  credentials: string[];
  /** A sensible starting field map, external → internal. */
  fieldMapping: Record<string, string>;
}

/** Internal customer fields an external field may be mapped onto. */
export const MAPPABLE_FIELDS = [
  'firstName',
  'lastName',
  'displayName',
  'company',
  'jobTitle',
  'locale',
  'timezone',
  'tier',
  'externalId',
  'email',
  'phone',
] as const;

export type MappableField = (typeof MAPPABLE_FIELDS)[number];

export const PRESETS: Record<string, ConnectorPreset> = {
  salesforce: {
    label: 'Salesforce',
    credentials: ['accessToken', 'instanceUrl'],
    config: {
      auth: 'bearer',
      contactsPath: '/services/data/v60.0/query',
      recordsPath: 'records',
      nextPath: 'nextRecordsUrl',
      query: {
        q: 'SELECT Id, FirstName, LastName, Email, Phone, Account.Name, Title FROM Contact',
      },
    },
    fieldMapping: {
      Id: 'externalId',
      FirstName: 'firstName',
      LastName: 'lastName',
      Email: 'email',
      Phone: 'phone',
      Title: 'jobTitle',
    },
  },

  hubspot: {
    label: 'HubSpot',
    credentials: ['accessToken'],
    config: {
      baseUrl: 'https://api.hubapi.com',
      auth: 'bearer',
      contactsPath: '/crm/v3/objects/contacts',
      recordsPath: 'results',
      nextPath: 'paging.next.after',
      cursorParam: 'after',
      pageSizeParam: 'limit',
      pageSize: 100,
      query: { properties: 'firstname,lastname,email,phone,company,jobtitle' },
    },
    fieldMapping: {
      id: 'externalId',
      'properties.firstname': 'firstName',
      'properties.lastname': 'lastName',
      'properties.email': 'email',
      'properties.phone': 'phone',
      'properties.company': 'company',
      'properties.jobtitle': 'jobTitle',
    },
  },

  dynamics: {
    label: 'Microsoft Dynamics 365',
    credentials: ['accessToken'],
    config: {
      auth: 'bearer',
      contactsPath: '/api/data/v9.2/contacts',
      recordsPath: 'value',
      nextPath: '@odata.nextLink',
    },
    fieldMapping: {
      contactid: 'externalId',
      firstname: 'firstName',
      lastname: 'lastName',
      emailaddress1: 'email',
      telephone1: 'phone',
      jobtitle: 'jobTitle',
    },
  },

  rest: {
    label: 'Generic REST API',
    credentials: ['token'],
    config: { auth: 'bearer', contactsPath: '/contacts', recordsPath: 'data' },
    fieldMapping: {},
  },
};

/** Read `a.b.c` out of a nested object; returns undefined rather than throwing. */
export function readPath(source: unknown, path: string): unknown {
  if (!path) return source;
  return path.split('.').reduce<unknown>((value, segment) => {
    if (value === null || value === undefined) return undefined;
    if (Array.isArray(value)) {
      const index = Number(segment);
      return Number.isInteger(index) ? value[index] : undefined;
    }
    if (typeof value === 'object') return (value as Record<string, unknown>)[segment];
    return undefined;
  }, source);
}

/**
 * Apply the tenant's field map to one external record.
 *
 * Unmapped fields are dropped rather than passed through: a CRM contact
 * carries far more than a support platform should store, and copying it
 * wholesale would quietly import personal data nobody chose to bring across.
 */
export function mapRecord(
  record: Record<string, unknown>,
  mapping: Record<string, string>,
): Partial<Record<MappableField, string>> {
  const mapped: Partial<Record<MappableField, string>> = {};

  for (const [external, internal] of Object.entries(mapping)) {
    if (!(MAPPABLE_FIELDS as readonly string[]).includes(internal)) continue;
    const value = readPath(record, external);
    if (value === null || value === undefined || value === '') continue;
    mapped[internal as MappableField] = String(value).slice(0, 500);
  }

  return mapped;
}

/** Build the request for one page. */
export function buildRequest(
  config: ConnectorConfig,
  credentials: Record<string, string>,
  cursor?: string,
): { url: string; headers: Record<string, string> } {
  // A provider that returns an absolute next-page URL is followed directly.
  const absolute = cursor && /^https?:\/\//i.test(cursor);
  const base = credentials.instanceUrl?.replace(/\/+$/, '') || config.baseUrl.replace(/\/+$/, '');
  const url = new URL(absolute ? cursor : `${base}${config.contactsPath}`);

  if (!absolute) {
    for (const [key, value] of Object.entries(config.query ?? {})) url.searchParams.set(key, value);
    if (config.pageSize && config.pageSizeParam)
      url.searchParams.set(config.pageSizeParam, String(config.pageSize));
    if (cursor && config.cursorParam) url.searchParams.set(config.cursorParam, cursor);
  }

  const headers: Record<string, string> = { accept: 'application/json', ...config.headers };

  switch (config.auth) {
    case 'bearer':
      headers.authorization = `Bearer ${credentials.accessToken ?? credentials.token ?? ''}`;
      break;
    case 'api_key_header':
      headers[config.authParam ?? 'x-api-key'] = credentials.apiKey ?? credentials.token ?? '';
      break;
    case 'basic':
      headers.authorization = `Basic ${Buffer.from(
        `${credentials.username ?? ''}:${credentials.password ?? ''}`,
      ).toString('base64')}`;
      break;
    case 'query_param':
      url.searchParams.set(config.authParam ?? 'api_key', credentials.apiKey ?? '');
      break;
    case 'none':
      break;
  }

  return { url: url.toString(), headers };
}
