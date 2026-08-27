import { diag, DiagConsoleLogger, DiagLogLevel } from '@opentelemetry/api';
import { getNodeAutoInstrumentations } from '@opentelemetry/auto-instrumentations-node';
import { OTLPTraceExporter } from '@opentelemetry/exporter-trace-otlp-http';
import { PrismaInstrumentation } from '@prisma/instrumentation';
import { resourceFromAttributes } from '@opentelemetry/resources';
import { NodeSDK } from '@opentelemetry/sdk-node';
import { ATTR_SERVICE_NAME, ATTR_SERVICE_VERSION } from '@opentelemetry/semantic-conventions';

/**
 * Distributed tracing.
 *
 * 168 Prometheus metrics could already say *that* something was slow. None of
 * them could say where: a request crossing the API, the workflow runtime, the
 * AI gateway, retrieval and the database looked like one number. This makes
 * the hops visible.
 *
 * Started from a separate entry point before anything else is imported,
 * because instrumentation patches modules as they load — required after Prisma
 * or Fastify it silently traces nothing, which is the worst failure mode
 * available to an observability tool.
 */

let sdk: NodeSDK | undefined;

export function startTracing(): void {
  if (process.env.OTEL_ENABLED !== 'true') return;
  if (sdk) return;

  if (process.env.OTEL_DIAG === 'true') diag.setLogger(new DiagConsoleLogger(), DiagLogLevel.WARN);

  const endpoint = process.env.OTEL_EXPORTER_OTLP_ENDPOINT ?? 'http://localhost:4318';

  sdk = new NodeSDK({
    resource: resourceFromAttributes({
      [ATTR_SERVICE_NAME]: process.env.OTEL_SERVICE_NAME ?? 'atrrehub-api',
      [ATTR_SERVICE_VERSION]: process.env.npm_package_version ?? '0.1.0',
      'deployment.environment': process.env.NODE_ENV ?? 'development',
      'deployment.mode': process.env.DEPLOYMENT_MODE ?? 'standalone',
    }),
    traceExporter: new OTLPTraceExporter({ url: `${endpoint.replace(/\/+$/, '')}/v1/traces` }),
    instrumentations: [
      // Prisma is not covered by the auto-instrumentations and is the span
      // that matters most: "the request was slow" and "this query was slow"
      // are different findings, and only one of them can be acted on.
      new PrismaInstrumentation(),
      getNodeAutoInstrumentations({
        // Filesystem spans drown everything else and say nothing useful about
        // a request; they are the first thing anyone turns off.
        '@opentelemetry/instrumentation-fs': { enabled: false },
        '@opentelemetry/instrumentation-http': {
          // Health probes fire every few seconds and would dominate trace
          // volume without ever being the thing anyone is looking for.
          ignoreIncomingRequestHook: (request) =>
            ['/healthz', '/readyz', '/metrics'].includes((request.url ?? '').split('?')[0]),
        },
      }),
    ],
  });

  sdk.start();

  // Flush on the way out. A crash that loses its own trace is a crash nobody
  // can explain afterwards.
  const shutdown = () => {
    void sdk
      ?.shutdown()
      .catch(() => undefined)
      .finally(() => process.exit(0));
  };
  process.once('SIGTERM', shutdown);
  process.once('SIGINT', shutdown);
}
