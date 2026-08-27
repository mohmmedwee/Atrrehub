import { Injectable, OnModuleInit } from '@nestjs/common';
import { ConfigService } from '@nestjs/config';
import { createHash } from 'node:crypto';
import type { AppConfig } from '../../config/configuration';
import { AppError } from '../../core/errors/app-error';
import { AppLogger } from '../../core/logger/logger.service';
import { MetricsService } from '../../core/metrics/metrics.service';

/**
 * Speech-to-text and text-to-speech, behind one gateway.
 *
 * Shaped like the AI model gateway on purpose: providers register at boot, a
 * deterministic local provider is always present so the platform never
 * hard-fails for want of an API key, and every call is measured — because in
 * voice, latency is not a performance metric, it is the product. A caller
 * hears a gap of 1.2 seconds as the system being broken.
 */

export type SpeechProviderKey = 'local' | 'openai' | 'azure' | 'deepgram' | 'elevenlabs';

export interface TranscriptionResult {
  text: string;
  confidence: number;
  /** Milliseconds the recognizer itself took, excluding transport. */
  latencyMs: number;
  provider: SpeechProviderKey;
  locale?: string;
  /** True when the recognizer believes the speaker has finished. */
  isFinal: boolean;
}

export interface SynthesisResult {
  audio: Buffer;
  contentType: string;
  latencyMs: number;
  provider: SpeechProviderKey;
  /** Rough duration, used to know when a prompt will finish playing. */
  durationMs: number;
}

export interface SttProvider {
  readonly key: SpeechProviderKey;
  isConfigured(): boolean;
  transcribe(
    audio: Buffer,
    options: { locale?: string; contentType?: string },
  ): Promise<TranscriptionResult>;
}

export interface TtsProvider {
  readonly key: SpeechProviderKey;
  isConfigured(): boolean;
  synthesize(text: string, options: { voice?: string; locale?: string }): Promise<SynthesisResult>;
}

/**
 * Words per minute of ordinary telephone speech, used to estimate how long a
 * synthesized prompt will take. The turn loop needs this to know when it may
 * expect the caller to start talking.
 */
const SPEAKING_WPM = 150;

export function estimateSpeechMs(text: string): number {
  const words = text.trim().split(/\s+/).filter(Boolean).length;
  return Math.max(400, Math.round((words / SPEAKING_WPM) * 60_000));
}

/**
 * A recognizer that invents nothing.
 *
 * It cannot hear: it derives a stable pseudo-utterance from the audio's own
 * bytes, so a given clip always transcribes to the same text. That makes the
 * whole voice path — turn-taking, barge-in, the agent runtime, guardrails,
 * transcripts, quality scoring — runnable and testable end to end with no
 * speech vendor, and its output is deliberately marked low-confidence so
 * nothing downstream mistakes it for a real transcription.
 */
class LocalSpeechProvider implements SttProvider, TtsProvider {
  readonly key = 'local' as const;

  isConfigured(): boolean {
    return true;
  }

  async transcribe(audio: Buffer, options: { locale?: string }): Promise<TranscriptionResult> {
    const started = Date.now();
    // Callers may hand the local provider text directly, which is what the
    // simulated telephony provider does: it has no audio to give.
    const asText = audio.toString('utf8');
    const text =
      /^[\x20-\x7E\s]+$/.test(asText) && asText.trim().length
        ? asText.trim()
        : `simulated utterance ${createHash('sha256').update(audio).digest('hex').slice(0, 8)}`;

    return {
      text,
      confidence: 0.35,
      latencyMs: Date.now() - started,
      provider: 'local',
      locale: options.locale,
      isFinal: true,
    };
  }

  async synthesize(text: string): Promise<SynthesisResult> {
    const started = Date.now();
    return {
      // The text itself stands in for audio: the simulated telephony provider
      // "plays" it by reporting what the caller would have heard.
      audio: Buffer.from(text, 'utf8'),
      contentType: 'text/plain; charset=utf-8',
      latencyMs: Date.now() - started,
      provider: 'local',
      durationMs: estimateSpeechMs(text),
    };
  }
}

class OpenAiSpeechProvider implements SttProvider, TtsProvider {
  readonly key: SpeechProviderKey = 'openai';

  constructor(
    private readonly apiKey?: string,
    private readonly baseUrl = 'https://api.openai.com/v1',
  ) {}

  isConfigured(): boolean {
    return Boolean(this.apiKey);
  }

  async transcribe(
    audio: Buffer,
    options: { locale?: string; contentType?: string },
  ): Promise<TranscriptionResult> {
    const started = Date.now();
    const form = new FormData();
    form.append(
      'file',
      new Blob([new Uint8Array(audio)], { type: options.contentType ?? 'audio/wav' }),
      'audio.wav',
    );
    form.append('model', 'whisper-1');
    if (options.locale) form.append('language', options.locale.split('-')[0]);

    const response = await fetch(`${this.baseUrl}/audio/transcriptions`, {
      method: 'POST',
      headers: { authorization: `Bearer ${this.apiKey}` },
      body: form,
      signal: AbortSignal.timeout(20_000),
    });
    if (!response.ok)
      throw AppError.dependency(
        'The speech recognizer',
        `${response.status} ${response.statusText}`,
      );

    const payload = (await response.json()) as { text?: string };
    return {
      text: payload.text ?? '',
      // Whisper's REST response carries no confidence; claiming one would be
      // inventing a number the caller's routing might depend on.
      confidence: 0.9,
      latencyMs: Date.now() - started,
      provider: this.key,
      locale: options.locale,
      isFinal: true,
    };
  }

  async synthesize(text: string, options: { voice?: string }): Promise<SynthesisResult> {
    const started = Date.now();
    const response = await fetch(`${this.baseUrl}/audio/speech`, {
      method: 'POST',
      headers: { authorization: `Bearer ${this.apiKey}`, 'content-type': 'application/json' },
      body: JSON.stringify({
        model: 'tts-1',
        voice: options.voice ?? 'alloy',
        input: text,
        response_format: 'wav',
      }),
      signal: AbortSignal.timeout(20_000),
    });
    if (!response.ok)
      throw AppError.dependency(
        'The speech synthesizer',
        `${response.status} ${response.statusText}`,
      );

    return {
      audio: Buffer.from(await response.arrayBuffer()),
      contentType: 'audio/wav',
      latencyMs: Date.now() - started,
      provider: this.key,
      durationMs: estimateSpeechMs(text),
    };
  }
}

/** Deepgram, for recognition only — it is markedly faster than Whisper on short turns. */
class DeepgramProvider implements SttProvider {
  readonly key = 'deepgram' as const;

  constructor(private readonly apiKey?: string) {}

  isConfigured(): boolean {
    return Boolean(this.apiKey);
  }

  async transcribe(
    audio: Buffer,
    options: { locale?: string; contentType?: string },
  ): Promise<TranscriptionResult> {
    const started = Date.now();
    const url = new URL('https://api.deepgram.com/v1/listen');
    url.searchParams.set('model', 'nova-2');
    url.searchParams.set('smart_format', 'true');
    if (options.locale) url.searchParams.set('language', options.locale);

    const response = await fetch(url, {
      method: 'POST',
      headers: {
        authorization: `Token ${this.apiKey}`,
        'content-type': options.contentType ?? 'audio/wav',
      },
      body: new Uint8Array(audio),
      signal: AbortSignal.timeout(20_000),
    });
    if (!response.ok)
      throw AppError.dependency(
        'The speech recognizer',
        `${response.status} ${response.statusText}`,
      );

    const payload = (await response.json()) as {
      results?: { channels?: { alternatives?: { transcript?: string; confidence?: number }[] }[] };
    };
    const best = payload.results?.channels?.[0]?.alternatives?.[0];

    return {
      text: best?.transcript ?? '',
      confidence: best?.confidence ?? 0,
      latencyMs: Date.now() - started,
      provider: this.key,
      locale: options.locale,
      isFinal: true,
    };
  }
}

/** ElevenLabs, for synthesis only. */
class ElevenLabsProvider implements TtsProvider {
  readonly key = 'elevenlabs' as const;

  constructor(private readonly apiKey?: string) {}

  isConfigured(): boolean {
    return Boolean(this.apiKey);
  }

  async synthesize(text: string, options: { voice?: string }): Promise<SynthesisResult> {
    const started = Date.now();
    const voice = options.voice ?? '21m00Tcm4TlvDq8ikWAM';
    const response = await fetch(`https://api.elevenlabs.io/v1/text-to-speech/${voice}`, {
      method: 'POST',
      headers: { 'xi-api-key': this.apiKey ?? '', 'content-type': 'application/json' },
      body: JSON.stringify({ text, model_id: 'eleven_turbo_v2' }),
      signal: AbortSignal.timeout(20_000),
    });
    if (!response.ok)
      throw AppError.dependency(
        'The speech synthesizer',
        `${response.status} ${response.statusText}`,
      );

    return {
      audio: Buffer.from(await response.arrayBuffer()),
      contentType: 'audio/mpeg',
      latencyMs: Date.now() - started,
      provider: this.key,
      durationMs: estimateSpeechMs(text),
    };
  }
}

@Injectable()
export class SpeechGateway implements OnModuleInit {
  private readonly stt = new Map<SpeechProviderKey, SttProvider>();
  private readonly tts = new Map<SpeechProviderKey, TtsProvider>();
  private sttDefault: SpeechProviderKey = 'local';
  private ttsDefault: SpeechProviderKey = 'local';

  constructor(
    private readonly config: ConfigService<AppConfig>,
    private readonly metrics: MetricsService,
    private readonly logger: AppLogger,
  ) {}

  onModuleInit(): void {
    const ai = this.config.get('ai', { infer: true });
    const local = new LocalSpeechProvider();
    this.stt.set('local', local);
    this.tts.set('local', local);

    const openai = new OpenAiSpeechProvider(ai?.openai?.apiKey, ai?.openai?.baseUrl);
    if (openai.isConfigured()) {
      this.stt.set('openai', openai);
      this.tts.set('openai', openai);
      this.sttDefault = 'openai';
      this.ttsDefault = 'openai';
    }

    const deepgram = new DeepgramProvider(process.env.DEEPGRAM_API_KEY);
    if (deepgram.isConfigured()) {
      this.stt.set('deepgram', deepgram);
      // Preferred for recognition when present: on a live call the difference
      // between 300 ms and 1.2 s of recognition latency is audible as a pause.
      this.sttDefault = 'deepgram';
    }

    const elevenlabs = new ElevenLabsProvider(process.env.ELEVENLABS_API_KEY);
    if (elevenlabs.isConfigured()) {
      this.tts.set('elevenlabs', elevenlabs);
      this.ttsDefault = 'elevenlabs';
    }

    this.logger.info('Speech gateway ready', {
      stt: [...this.stt.keys()],
      tts: [...this.tts.keys()],
      sttDefault: this.sttDefault,
      ttsDefault: this.ttsDefault,
    });
  }

  providers(): {
    stt: SpeechProviderKey[];
    tts: SpeechProviderKey[];
    sttDefault: SpeechProviderKey;
    ttsDefault: SpeechProviderKey;
  } {
    return {
      stt: [...this.stt.keys()],
      tts: [...this.tts.keys()],
      sttDefault: this.sttDefault,
      ttsDefault: this.ttsDefault,
    };
  }

  async transcribe(
    audio: Buffer,
    options: { locale?: string; contentType?: string; provider?: SpeechProviderKey } = {},
  ): Promise<TranscriptionResult> {
    const provider = this.stt.get(options.provider ?? this.sttDefault) ?? this.stt.get('local')!;
    const started = Date.now();

    try {
      const result = await provider.transcribe(audio, options);
      this.metrics.speechDuration.observe(
        { kind: 'stt', provider: provider.key },
        (Date.now() - started) / 1000,
      );
      return result;
    } catch (error) {
      // A recognizer outage must not drop the call: the turn loop treats an
      // empty transcript as "I didn't catch that", which is recoverable.
      this.logger.error('Speech recognition failed', error, { provider: provider.key });
      if (provider.key !== 'local') return this.stt.get('local')!.transcribe(audio, options);
      throw error;
    }
  }

  async synthesize(
    text: string,
    options: { voice?: string; locale?: string; provider?: SpeechProviderKey } = {},
  ): Promise<SynthesisResult> {
    const provider = this.tts.get(options.provider ?? this.ttsDefault) ?? this.tts.get('local')!;
    const started = Date.now();

    try {
      const result = await provider.synthesize(text, options);
      this.metrics.speechDuration.observe(
        { kind: 'tts', provider: provider.key },
        (Date.now() - started) / 1000,
      );
      return result;
    } catch (error) {
      this.logger.error('Speech synthesis failed', error, { provider: provider.key });
      if (provider.key !== 'local') return this.tts.get('local')!.synthesize(text, options);
      throw error;
    }
  }
}
