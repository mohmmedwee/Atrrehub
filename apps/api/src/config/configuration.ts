import type { Env } from './env.schema';

/** Shape the flat environment into the nested config the modules consume. */
export const buildConfig = (env: Env) => ({
  env: env.NODE_ENV,
  isProduction: env.NODE_ENV === 'production',
  isTest: env.NODE_ENV === 'test',
  logLevel: env.LOG_LEVEL,

  http: {
    port: env.API_PORT,
    host: env.API_HOST,
    publicApiUrl: env.PUBLIC_API_URL,
    publicWebUrl: env.PUBLIC_WEB_URL,
    corsOrigins: env.CORS_ORIGINS.split(',')
      .map((o) => o.trim())
      .filter(Boolean),
  },

  database: { url: env.DATABASE_URL, rls: env.DB_RLS },
  redis: { url: env.REDIS_URL },

  security: {
    jwtSecret: env.JWT_SECRET,
    accessTtl: env.JWT_ACCESS_TTL,
    refreshTtl: env.JWT_REFRESH_TTL,
    encryptionKey: env.ENCRYPTION_KEY,
    widgetTokenSecret: env.WIDGET_TOKEN_SECRET,
  },

  storage: {
    driver: env.STORAGE_DRIVER,
    localPath: env.STORAGE_LOCAL_PATH,
    s3: {
      endpoint: env.S3_ENDPOINT,
      region: env.S3_REGION,
      bucket: env.S3_BUCKET,
      accessKeyId: env.S3_ACCESS_KEY_ID,
      secretAccessKey: env.S3_SECRET_ACCESS_KEY,
      forcePathStyle: env.S3_FORCE_PATH_STYLE,
    },
  },

  mail: {
    driver: env.MAIL_DRIVER,
    from: env.MAIL_FROM,
    smtp: {
      host: env.SMTP_HOST,
      port: env.SMTP_PORT,
      secure: env.SMTP_SECURE,
      user: env.SMTP_USER,
      password: env.SMTP_PASSWORD,
    },
    imap: {
      enabled: env.IMAP_ENABLED,
      host: env.IMAP_HOST,
      port: env.IMAP_PORT,
      user: env.IMAP_USER,
      password: env.IMAP_PASSWORD,
    },
  },

  ai: {
    defaultProvider: env.AI_DEFAULT_PROVIDER,
    embeddingDimensions: env.AI_EMBEDDING_DIMENSIONS,
    openai: { apiKey: env.OPENAI_API_KEY, baseUrl: env.OPENAI_BASE_URL },
    anthropic: { apiKey: env.ANTHROPIC_API_KEY, baseUrl: env.ANTHROPIC_BASE_URL },
    azure: {
      apiKey: env.AZURE_OPENAI_API_KEY,
      endpoint: env.AZURE_OPENAI_ENDPOINT,
      apiVersion: env.AZURE_OPENAI_API_VERSION,
    },
    gemini: { apiKey: env.GEMINI_API_KEY },
    local: { baseUrl: env.LOCAL_LLM_BASE_URL },
  },

  observability: {
    otelEnabled: env.OTEL_ENABLED,
    otelEndpoint: env.OTEL_EXPORTER_OTLP_ENDPOINT,
    serviceName: env.OTEL_SERVICE_NAME,
    metricsEnabled: env.METRICS_ENABLED,
  },

  workers: { enabled: env.WORKERS_ENABLED, concurrency: env.WORKER_CONCURRENCY },

  deployment: {
    mode: env.DEPLOYMENT_MODE,
    controlPlaneUrl: env.CONTROL_PLANE_URL,
    enrollmentToken: env.DATA_PLANE_ENROLLMENT_TOKEN,
    region: env.DATA_PLANE_REGION,
  },
});

export type AppConfig = ReturnType<typeof buildConfig>;
