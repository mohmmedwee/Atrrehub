import type { ChannelType } from '@prisma/client';

/**
 * The single contract every channel implements.
 *
 * Keeping channel specifics behind this interface is what stops WhatsApp
 * template rules or email threading headers from leaking into the interaction
 * engine — the core only ever sees a `NormalizedInboundMessage`.
 */
export interface ChannelAdapter {
  readonly channel: ChannelType;

  /** Translate a provider payload into the platform's normalized shape. */
  receive(
    payload: unknown,
    account: ChannelAccountContext,
  ): Promise<NormalizedInboundMessage | null>;

  /** Deliver an outbound message through the provider. */
  send(message: OutboundMessage, account: ChannelAccountContext): Promise<DeliveryReceipt>;

  /** Confirm receipt to the provider where the protocol requires it. */
  acknowledge?(externalId: string, account: ChannelAccountContext): Promise<void>;

  /** Fetch media the provider referenced rather than inlined. */
  media?(reference: string, account: ChannelAccountContext): Promise<MediaObject | null>;

  /** Poll delivery state for providers without status webhooks. */
  status?(externalId: string, account: ChannelAccountContext): Promise<DeliveryState>;

  /**
   * Verify an inbound webhook actually came from the provider.
   *
   * Every social channel delivers messages over a public, unauthenticated URL,
   * so without this anyone who learns the endpoint can inject a message into a
   * tenant's inbox as any customer they choose. Adapters whose transport is
   * already authenticated — web chat, email through a trusted relay — do not
   * implement it.
   */
  verifySignature?(
    payload: unknown,
    headers: Record<string, string | undefined>,
    account: ChannelAccountContext,
    rawBody?: string,
  ): boolean;

  /**
   * Answer a provider's subscription challenge.
   *
   * Meta's platforms verify an endpoint by GETting it with a token before they
   * will deliver anything to it.
   */
  challenge?(
    query: Record<string, string | undefined>,
    account: ChannelAccountContext,
  ): string | null;

  /** Capabilities the workspace UI adapts to. */
  metadata(): ChannelMetadata;
}

export interface ChannelAccountContext {
  id: string;
  organizationId: string;
  workspaceId?: string | null;
  queueId?: string | null;
  /** Decrypted at the boundary; never persisted in this form. */
  credentials: Record<string, unknown>;
  config: Record<string, unknown>;
}

export interface NormalizedInboundMessage {
  /** Provider-side message id, used for idempotent ingestion. */
  externalId: string;
  /** Stable key that groups messages into one conversation (email thread, chat session). */
  threadKey?: string;
  /** How to identify or create the customer. */
  contact: {
    kind: 'email' | 'phone' | 'whatsapp' | 'telegram' | 'external';
    value: string;
    displayName?: string;
  };
  subject?: string;
  body: string;
  bodyHtml?: string;
  locale?: string;
  attachments?: InboundAttachment[];
  metadata?: Record<string, unknown>;
  receivedAt?: Date;
}

export interface InboundAttachment {
  filename: string;
  contentType: string;
  /** Either inline content or a provider reference resolved through `media()`. */
  content?: Buffer;
  reference?: string;
  sizeBytes?: number;
}

export interface OutboundMessage {
  conversationId: string;
  messageId: string;
  to: string;
  subject?: string;
  body: string;
  bodyHtml?: string;
  threadKey?: string;
  /** Provider id of the message being replied to, for correct threading. */
  inReplyTo?: string;
  attachments?: { filename: string; content: Buffer; contentType: string }[];
  metadata?: Record<string, unknown>;
}

export interface DeliveryReceipt {
  externalId?: string;
  state: DeliveryState;
  error?: string;
}

export type DeliveryState = 'pending' | 'sent' | 'delivered' | 'read' | 'failed';

export interface MediaObject {
  filename: string;
  contentType: string;
  content: Buffer;
}

export interface ChannelMetadata {
  supportsAttachments: boolean;
  supportsRichText: boolean;
  supportsTypingIndicator: boolean;
  supportsReadReceipts: boolean;
  /** Undefined means no provider-imposed limit. */
  maxMessageLength?: number;
  /** Providers such as WhatsApp only allow templates outside a session window. */
  sessionWindowHours?: number;
}
