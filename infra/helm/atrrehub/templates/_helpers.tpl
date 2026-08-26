{{- define "atrrehub.name" -}}
{{- default .Chart.Name .Values.nameOverride | trunc 63 | trimSuffix "-" -}}
{{- end -}}

{{- define "atrrehub.fullname" -}}
{{- printf "%s-%s" .Release.Name (include "atrrehub.name" .) | trunc 63 | trimSuffix "-" -}}
{{- end -}}

{{- define "atrrehub.labels" -}}
app.kubernetes.io/name: {{ include "atrrehub.name" . }}
app.kubernetes.io/instance: {{ .Release.Name }}
app.kubernetes.io/version: {{ .Chart.AppVersion | quote }}
app.kubernetes.io/managed-by: {{ .Release.Service }}
{{- end -}}

{{- define "atrrehub.secretName" -}}
{{- if .Values.secrets.existingSecret -}}
{{ .Values.secrets.existingSecret }}
{{- else -}}
{{ include "atrrehub.fullname" . }}-secrets
{{- end -}}
{{- end -}}

{{/* Environment shared by the API and worker deployments. */}}
{{- define "atrrehub.env" -}}
- name: NODE_ENV
  value: production
- name: LOG_LEVEL
  value: {{ .Values.config.logLevel | quote }}
- name: CORS_ORIGINS
  value: {{ .Values.config.corsOrigins | quote }}
- name: PUBLIC_API_URL
  value: {{ .Values.config.publicApiUrl | quote }}
- name: PUBLIC_WEB_URL
  value: {{ .Values.config.publicWebUrl | quote }}
- name: AI_DEFAULT_PROVIDER
  value: {{ .Values.config.aiDefaultProvider | quote }}
- name: OTEL_ENABLED
  value: {{ .Values.config.otelEnabled | quote }}
- name: OTEL_EXPORTER_OTLP_ENDPOINT
  value: {{ .Values.config.otelEndpoint | quote }}
- name: STORAGE_DRIVER
  value: {{ .Values.config.storageDriver | quote }}
- name: S3_BUCKET
  value: {{ .Values.config.s3Bucket | quote }}
- name: S3_REGION
  value: {{ .Values.config.s3Region | quote }}
{{- range $key, $env := dict "databaseUrl" "DATABASE_URL" "redisUrl" "REDIS_URL" "jwtSecret" "JWT_SECRET" "encryptionKey" "ENCRYPTION_KEY" "widgetTokenSecret" "WIDGET_TOKEN_SECRET" "openaiApiKey" "OPENAI_API_KEY" "anthropicApiKey" "ANTHROPIC_API_KEY" }}
- name: {{ $env }}
  valueFrom:
    secretKeyRef:
      name: {{ include "atrrehub.secretName" $ }}
      key: {{ $key }}
      optional: true
{{- end }}
{{- end -}}
