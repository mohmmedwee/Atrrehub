import { Injectable, LoggerService, Scope } from '@nestjs/common';
import pino, { type Logger } from 'pino';
import { RequestContextStore } from '../context/request-context';

/**
 * Keys whose values never reach a log line. Matching is case-insensitive and by
 * substring, so `customerPassword` and `x-api-key` are both caught.
 */
const REDACT_KEYS = [
  'password',
  'passwordhash',
  'token',
  'secret',
  'apikey',
  'api_key',
  'authorization',
  'cookie',
  'refreshtoken',
  'credentials',
  'ssn',
  'creditcard',
  'cardnumber',
  'cvv',
  'mfasecret',
  'recoverycodes',
];

const MAX_DEPTH = 6;

export function redact(value: unknown, depth = 0): unknown {
  if (depth > MAX_DEPTH || value == null) return value;
  if (Array.isArray(value)) return value.map((v) => redact(v, depth + 1));
  if (typeof value !== 'object') return value;
  if (value instanceof Date) return value.toISOString();

  const out: Record<string, unknown> = {};
  for (const [key, val] of Object.entries(value as Record<string, unknown>)) {
    const lower = key.toLowerCase();
    out[key] = REDACT_KEYS.some((k) => lower.includes(k)) ? '[redacted]' : redact(val, depth + 1);
  }
  return out;
}

@Injectable({ scope: Scope.DEFAULT })
export class AppLogger implements LoggerService {
  private readonly root: Logger;

  constructor(level = 'info', pretty = false, serviceName = 'atrrehub-api') {
    this.root = pino({
      level,
      base: { service: serviceName },
      timestamp: pino.stdTimeFunctions.isoTime,
      formatters: { level: (label) => ({ level: label }) },
      ...(pretty
        ? {
            transport: {
              target: 'pino-pretty',
              options: {
                colorize: true,
                translateTime: 'HH:MM:ss.l',
                ignore: 'pid,hostname,service',
              },
            },
          }
        : {}),
    });
  }

  /** Correlation fields attached to every line, pulled from the active request. */
  private bindings(): Record<string, unknown> {
    const moduleContext = (this as unknown as { moduleContext?: string }).moduleContext;
    const ctx = RequestContextStore.get();
    if (!ctx) return moduleContext ? { context: moduleContext } : {};
    return {
      ...(moduleContext ? { context: moduleContext } : {}),
      requestId: ctx.requestId,
      organizationId: ctx.organizationId,
      workspaceId: ctx.workspaceId,
      principalId: ctx.principal?.id,
      principalType: ctx.principal?.type,
    };
  }

  /** A logger that tags every line with a module name. */
  child(context: string): AppLogger {
    const clone = Object.create(this) as AppLogger;
    (clone as unknown as { moduleContext: string }).moduleContext = context;
    return clone;
  }

  /**
   * Nest's own LoggerService passes a context *string* as the second argument,
   * while application code passes a metadata object. Normalize both.
   */
  private fields(meta?: Record<string, unknown> | string): Record<string, unknown> {
    if (typeof meta === 'string') return { ...this.bindings(), context: meta };
    return { ...this.bindings(), ...(redact(meta) as object) };
  }

  log(message: string, meta?: Record<string, unknown> | string): void {
    this.root.info(this.fields(meta), message);
  }

  info(message: string, meta?: Record<string, unknown> | string): void {
    this.log(message, meta);
  }

  warn(message: string, meta?: Record<string, unknown> | string): void {
    this.root.warn(this.fields(meta), message);
  }

  debug(message: string, meta?: Record<string, unknown> | string): void {
    this.root.debug(this.fields(meta), message);
  }

  verbose(message: string, meta?: Record<string, unknown> | string): void {
    this.root.trace(this.fields(meta), message);
  }

  error(message: string, error?: unknown, meta?: Record<string, unknown> | string): void {
    const err =
      error instanceof Error
        ? { name: error.name, message: error.message, stack: error.stack }
        : error != null
          ? { message: String(error) }
          : undefined;
    this.root.error({ ...this.fields(meta), err }, message);
  }

  fatal(message: string, error?: unknown): void {
    this.root.fatal({ ...this.bindings(), err: error }, message);
  }
}
