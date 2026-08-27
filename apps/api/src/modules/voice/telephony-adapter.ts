/**
 * The telephony contract.
 *
 * Voice does not fit the `ChannelAdapter` shape the messaging channels share:
 * a call is a *session* with live media and control operations, not an exchange
 * of discrete messages. So it gets its own contract — but calls still become
 * Conversations, so the workspace, Customer 360, SLA, routing, quality and
 * analytics read them through the same record every other channel uses.
 *
 * Everything a provider does is expressed here as an intent ("play this",
 * "collect four digits", "bridge to this agent"). Providers differ enormously
 * in how they express that — TwiML documents, NCCO arrays, ARI commands over a
 * websocket — and none of that difference is allowed past this boundary.
 */

export type TelephonyProviderKey = 'simulated' | 'twilio' | 'sip';

export interface TelephonyAccount {
  id: string;
  organizationId: string;
  /** Decrypted at the moment of use; never persisted in this form. */
  credentials: Record<string, string>;
  config: Record<string, unknown>;
}

/** A provider event, normalized. One call produces many of these. */
export interface NormalizedCallEvent {
  providerCallId: string;
  type:
    | 'initiated'
    | 'ringing'
    | 'answered'
    | 'dtmf'
    | 'speech'
    | 'recording_available'
    | 'hangup'
    | 'failed';
  from?: string;
  to?: string;
  direction?: 'inbound' | 'outbound';
  /** DTMF digits, for `dtmf`. */
  digits?: string;
  /** Recognized text, for providers that do their own recognition. */
  text?: string;
  /** Where the provider is holding a recording, for `recording_available`. */
  recordingUrl?: string;
  recordingDurationSec?: number;
  /** Provider's own cause code, kept verbatim for support tickets. */
  cause?: string;
  hangupBy?: 'caller' | 'platform' | 'agent' | 'provider';
  timestamp?: Date;
  raw?: Record<string, unknown>;
}

/**
 * What the platform wants the provider to do next.
 *
 * A list rather than a single action because every provider's control document
 * is a sequence, and expressing "say this, then collect a digit" as two
 * round-trips would add a network hop of latency to every IVR prompt.
 */
export type CallAction =
  | { kind: 'say'; text: string; voice?: string; locale?: string }
  | { kind: 'play'; url: string }
  | {
      kind: 'collect';
      /** Prompt played while waiting; barge-in cancels it. */
      say?: string;
      maxDigits: number;
      /** Digit that submits early, usually #. */
      terminator?: string;
      timeoutSec: number;
    }
  | { kind: 'listen'; timeoutSec: number; endpointingMs?: number }
  | { kind: 'bridge'; to: string; timeoutSec?: number; callerId?: string }
  | { kind: 'enqueue'; queueId: string; holdMusicUrl?: string }
  | { kind: 'record'; maxSeconds?: number; beep?: boolean; playBeforeSec?: number }
  | { kind: 'pause'; seconds: number }
  | { kind: 'hangup'; cause?: string };

export interface OriginateRequest {
  from: string;
  to: string;
  /** Correlates the provider's callbacks with the platform's call record. */
  reference: string;
  timeoutSec?: number;
}

export interface TelephonyCapabilities {
  /** Whether the provider can stream media to the platform for its own STT. */
  supportsMediaStreaming: boolean;
  /** Whether the provider recognizes speech itself. */
  supportsProviderSpeech: boolean;
  supportsRecording: boolean;
  supportsTransfer: boolean;
  supportsHold: boolean;
  supportsOutbound: boolean;
  /** Providers that cannot barge in must finish a prompt before hearing input. */
  supportsBargeIn: boolean;
}

export interface TelephonyAdapter {
  readonly key: TelephonyProviderKey;

  /** Translate a provider webhook body into the platform's event shape. */
  receive(payload: unknown, account: TelephonyAccount): Promise<NormalizedCallEvent | null>;

  /**
   * Render the platform's intent into whatever the provider expects, and
   * return it. The caller writes it into the webhook response where the
   * provider drives the call from its own document, or the adapter issues it
   * over the provider's API where control is imperative.
   */
  control(
    providerCallId: string,
    actions: CallAction[],
    account: TelephonyAccount,
  ): Promise<{ body?: unknown; contentType?: string }>;

  /** Place an outbound call. */
  originate?(
    request: OriginateRequest,
    account: TelephonyAccount,
  ): Promise<{ providerCallId: string }>;

  /** Fetch a recording so it can be stored in the platform's own object store. */
  fetchRecording?(
    url: string,
    account: TelephonyAccount,
  ): Promise<{ content: Buffer; contentType: string }>;

  /**
   * Verify a webhook actually came from the provider. A telephony webhook can
   * start calls, move them and expose recordings, so an unverified one is an
   * open door.
   */
  verifySignature?(
    payload: unknown,
    headers: Record<string, string | undefined>,
    account: TelephonyAccount,
    rawBody?: string,
  ): boolean;

  capabilities(): TelephonyCapabilities;
}
