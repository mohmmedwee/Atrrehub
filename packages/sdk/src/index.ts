import { HttpClient, type ClientOptions } from './http.js';
import { Operations } from './operations.generated.js';

export { AtrrehubError, type ProblemDetails } from './errors.js';
export type { ClientOptions, Page, RequestOptions } from './http.js';
export { HttpClient } from './http.js';
export {
  DELIVERY_HEADER,
  DEFAULT_TOLERANCE_SECONDS,
  EVENT_HEADER,
  SIGNATURE_HEADER,
  WebhookVerificationError,
  constructEvent,
  verifySignature,
  type WebhookEvent,
} from './webhooks.js';

/**
 * The Atrrehub client.
 *
 * ```ts
 * const api = new Atrrehub({ baseUrl: 'https://api.atrrehub.com', apiKey: process.env.ATRREHUB_API_KEY! });
 * const endpoint = await api.createWebhooks({ name: 'Orders', url: 'https://example.com/hooks', events: ['conversation.*'] });
 * ```
 */
export class Atrrehub extends Operations {
  constructor(options: ClientOptions) {
    super(new HttpClient(options));
  }

  /** For a call the generator has not caught up with yet. */
  request<T>(method: string, path: string, options?: Parameters<HttpClient['request']>[2]): Promise<T> {
    return this.http.request<T>(method, path, options);
  }
}

export default Atrrehub;
