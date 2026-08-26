-- CreateExtension
CREATE EXTENSION IF NOT EXISTS "pg_trgm";

-- CreateExtension
CREATE EXTENSION IF NOT EXISTS "unaccent";

-- CreateExtension
CREATE EXTENSION IF NOT EXISTS "vector";

-- CreateEnum
CREATE TYPE "Environment" AS ENUM ('development', 'staging', 'production');

-- CreateEnum
CREATE TYPE "PlanTier" AS ENUM ('starter', 'professional', 'business', 'enterprise');

-- CreateEnum
CREATE TYPE "UserStatus" AS ENUM ('invited', 'active', 'suspended', 'deactivated');

-- CreateEnum
CREATE TYPE "AgentPresence" AS ENUM ('offline', 'available', 'busy', 'away', 'on_break');

-- CreateEnum
CREATE TYPE "ActorType" AS ENUM ('user', 'ai_agent', 'system', 'customer');

-- CreateEnum
CREATE TYPE "ChannelType" AS ENUM ('web_chat', 'email', 'voice', 'whatsapp', 'sms', 'telegram', 'messenger', 'instagram', 'teams', 'api');

-- CreateEnum
CREATE TYPE "ConversationStatus" AS ENUM ('new', 'queued', 'assigned', 'active', 'waiting', 'resolved', 'closed');

-- CreateEnum
CREATE TYPE "AssigneeType" AS ENUM ('user', 'ai_agent', 'none');

-- CreateEnum
CREATE TYPE "MessageDirection" AS ENUM ('inbound', 'outbound', 'internal');

-- CreateEnum
CREATE TYPE "MessageType" AS ENUM ('text', 'html', 'attachment', 'system', 'note', 'handoff', 'card');

-- CreateEnum
CREATE TYPE "DeliveryState" AS ENUM ('pending', 'sent', 'delivered', 'read', 'failed');

-- CreateEnum
CREATE TYPE "Priority" AS ENUM ('low', 'normal', 'high', 'urgent', 'critical');

-- CreateEnum
CREATE TYPE "TicketStatus" AS ENUM ('open', 'pending', 'on_hold', 'resolved', 'closed', 'reopened');

-- CreateEnum
CREATE TYPE "SlaTargetType" AS ENUM ('first_response', 'next_response', 'resolution', 'waiting');

-- CreateEnum
CREATE TYPE "SlaClockState" AS ENUM ('running', 'paused', 'met', 'breached', 'cancelled');

-- CreateEnum
CREATE TYPE "RoutingStrategy" AS ENUM ('round_robin', 'least_loaded', 'skill_based', 'language', 'priority', 'customer_tier', 'team', 'ai_intent', 'sentiment', 'direct');

-- CreateEnum
CREATE TYPE "PublishState" AS ENUM ('draft', 'in_review', 'published', 'archived');

-- CreateEnum
CREATE TYPE "SourceType" AS ENUM ('article', 'file', 'url', 'website', 'faq', 'api', 'cloud_storage');

-- CreateEnum
CREATE TYPE "IngestionStatus" AS ENUM ('pending', 'processing', 'indexed', 'failed', 'skipped');

-- CreateEnum
CREATE TYPE "ModelRole" AS ENUM ('chat', 'fast', 'reasoning', 'embedding', 'rerank');

-- CreateEnum
CREATE TYPE "AiProvider" AS ENUM ('local', 'openai', 'azure_openai', 'anthropic', 'gemini', 'custom');

-- CreateEnum
CREATE TYPE "ExecutionStatus" AS ENUM ('queued', 'running', 'suspended', 'succeeded', 'failed', 'cancelled', 'timed_out');

-- CreateEnum
CREATE TYPE "StepStatus" AS ENUM ('pending', 'running', 'succeeded', 'failed', 'skipped', 'retrying');

-- CreateEnum
CREATE TYPE "MemoryScope" AS ENUM ('short_term', 'long_term', 'agent');

-- CreateEnum
CREATE TYPE "GuardrailStage" AS ENUM ('input', 'retrieval', 'tool', 'output', 'decision');

-- CreateEnum
CREATE TYPE "GuardrailAction" AS ENUM ('allow', 'flag', 'mask', 'block', 'handoff');

-- CreateEnum
CREATE TYPE "AutomationTrigger" AS ENUM ('ticket_created', 'ticket_updated', 'message_received', 'conversation_created', 'conversation_resolved', 'sla_warning', 'sla_breach', 'customer_created', 'sentiment_changed', 'schedule', 'webhook');

-- CreateEnum
CREATE TYPE "EvaluationKind" AS ENUM ('ai', 'manual', 'calibration');

-- CreateEnum
CREATE TYPE "NotificationChannel" AS ENUM ('email', 'sms', 'push', 'in_app', 'webhook');

-- CreateEnum
CREATE TYPE "IntegrationKind" AS ENUM ('salesforce', 'dynamics', 'hubspot', 'rest', 'graphql', 'webhook', 'custom');

-- CreateEnum
CREATE TYPE "OutboxStatus" AS ENUM ('pending', 'published', 'failed');

-- CreateTable
CREATE TABLE "organizations" (
    "id" TEXT NOT NULL,
    "name" TEXT NOT NULL,
    "slug" TEXT NOT NULL,
    "plan" "PlanTier" NOT NULL DEFAULT 'starter',
    "logo_url" TEXT,
    "primary_color" TEXT,
    "timezone" TEXT NOT NULL DEFAULT 'UTC',
    "locale" TEXT NOT NULL DEFAULT 'en',
    "default_language" TEXT NOT NULL DEFAULT 'en',
    "support_email" TEXT,
    "settings" JSONB NOT NULL DEFAULT '{}',
    "ai_settings" JSONB NOT NULL DEFAULT '{}',
    "is_active" BOOLEAN NOT NULL DEFAULT true,
    "created_at" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updated_at" TIMESTAMP(3) NOT NULL,

    CONSTRAINT "organizations_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "workspaces" (
    "id" TEXT NOT NULL,
    "organization_id" TEXT NOT NULL,
    "name" TEXT NOT NULL,
    "slug" TEXT NOT NULL,
    "description" TEXT,
    "environment" "Environment" NOT NULL DEFAULT 'production',
    "settings" JSONB NOT NULL DEFAULT '{}',
    "is_default" BOOLEAN NOT NULL DEFAULT false,
    "created_at" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updated_at" TIMESTAMP(3) NOT NULL,

    CONSTRAINT "workspaces_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "subscriptions" (
    "id" TEXT NOT NULL,
    "organization_id" TEXT NOT NULL,
    "plan" "PlanTier" NOT NULL,
    "seats" INTEGER NOT NULL DEFAULT 5,
    "status" TEXT NOT NULL DEFAULT 'active',
    "current_period_end" TIMESTAMP(3) NOT NULL,
    "limits" JSONB NOT NULL DEFAULT '{}',
    "created_at" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updated_at" TIMESTAMP(3) NOT NULL,

    CONSTRAINT "subscriptions_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "users" (
    "id" TEXT NOT NULL,
    "email" TEXT NOT NULL,
    "email_verified_at" TIMESTAMP(3),
    "password_hash" TEXT,
    "first_name" TEXT NOT NULL,
    "last_name" TEXT NOT NULL,
    "avatar_url" TEXT,
    "locale" TEXT NOT NULL DEFAULT 'en',
    "timezone" TEXT NOT NULL DEFAULT 'UTC',
    "status" "UserStatus" NOT NULL DEFAULT 'invited',
    "presence" "AgentPresence" NOT NULL DEFAULT 'offline',
    "presence_note" TEXT,
    "mfa_enabled" BOOLEAN NOT NULL DEFAULT false,
    "mfa_secret" TEXT,
    "mfa_recovery_codes" TEXT[] DEFAULT ARRAY[]::TEXT[],
    "failed_login_count" INTEGER NOT NULL DEFAULT 0,
    "locked_until" TIMESTAMP(3),
    "last_login_at" TIMESTAMP(3),
    "skills" TEXT[] DEFAULT ARRAY[]::TEXT[],
    "languages" TEXT[] DEFAULT ARRAY[]::TEXT[],
    "max_concurrent_chats" INTEGER NOT NULL DEFAULT 5,
    "created_at" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updated_at" TIMESTAMP(3) NOT NULL,

    CONSTRAINT "users_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "memberships" (
    "id" TEXT NOT NULL,
    "organization_id" TEXT NOT NULL,
    "user_id" TEXT NOT NULL,
    "role_id" TEXT NOT NULL,
    "workspace_ids" TEXT[] DEFAULT ARRAY[]::TEXT[],
    "is_owner" BOOLEAN NOT NULL DEFAULT false,
    "invited_by_id" TEXT,
    "invited_at" TIMESTAMP(3),
    "accepted_at" TIMESTAMP(3),
    "created_at" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updated_at" TIMESTAMP(3) NOT NULL,

    CONSTRAINT "memberships_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "roles" (
    "id" TEXT NOT NULL,
    "organization_id" TEXT NOT NULL,
    "key" TEXT NOT NULL,
    "name" TEXT NOT NULL,
    "description" TEXT,
    "permissions" TEXT[] DEFAULT ARRAY[]::TEXT[],
    "is_system" BOOLEAN NOT NULL DEFAULT false,
    "created_at" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updated_at" TIMESTAMP(3) NOT NULL,

    CONSTRAINT "roles_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "sessions" (
    "id" TEXT NOT NULL,
    "user_id" TEXT NOT NULL,
    "organization_id" TEXT,
    "refresh_token_hash" TEXT NOT NULL,
    "user_agent" TEXT,
    "ip_address" TEXT,
    "mfa_verified" BOOLEAN NOT NULL DEFAULT false,
    "expires_at" TIMESTAMP(3) NOT NULL,
    "revoked_at" TIMESTAMP(3),
    "rotated_from_id" TEXT,
    "created_at" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "last_used_at" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,

    CONSTRAINT "sessions_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "verification_tokens" (
    "id" TEXT NOT NULL,
    "user_id" TEXT NOT NULL,
    "purpose" TEXT NOT NULL,
    "token_hash" TEXT NOT NULL,
    "expires_at" TIMESTAMP(3) NOT NULL,
    "used_at" TIMESTAMP(3),
    "metadata" JSONB NOT NULL DEFAULT '{}',
    "created_at" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,

    CONSTRAINT "verification_tokens_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "api_keys" (
    "id" TEXT NOT NULL,
    "organization_id" TEXT NOT NULL,
    "name" TEXT NOT NULL,
    "prefix" TEXT NOT NULL,
    "key_hash" TEXT NOT NULL,
    "permissions" TEXT[] DEFAULT ARRAY[]::TEXT[],
    "created_by_id" TEXT,
    "last_used_at" TIMESTAMP(3),
    "expires_at" TIMESTAMP(3),
    "revoked_at" TIMESTAMP(3),
    "created_at" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,

    CONSTRAINT "api_keys_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "sso_connections" (
    "id" TEXT NOT NULL,
    "organization_id" TEXT NOT NULL,
    "kind" TEXT NOT NULL,
    "domain" TEXT NOT NULL,
    "config" JSONB NOT NULL DEFAULT '{}',
    "is_enabled" BOOLEAN NOT NULL DEFAULT false,
    "created_at" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updated_at" TIMESTAMP(3) NOT NULL,

    CONSTRAINT "sso_connections_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "audit_events" (
    "id" TEXT NOT NULL,
    "organization_id" TEXT NOT NULL,
    "actor_type" "ActorType" NOT NULL DEFAULT 'user',
    "actor_id" TEXT,
    "actor_label" TEXT,
    "action" TEXT NOT NULL,
    "resource_type" TEXT NOT NULL,
    "resource_id" TEXT,
    "before" JSONB,
    "after" JSONB,
    "ip_address" TEXT,
    "user_agent" TEXT,
    "request_id" TEXT,
    "created_at" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,

    CONSTRAINT "audit_events_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "teams" (
    "id" TEXT NOT NULL,
    "organization_id" TEXT NOT NULL,
    "workspace_id" TEXT,
    "name" TEXT NOT NULL,
    "description" TEXT,
    "business_hours_id" TEXT,
    "skills" TEXT[] DEFAULT ARRAY[]::TEXT[],
    "languages" TEXT[] DEFAULT ARRAY[]::TEXT[],
    "created_at" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updated_at" TIMESTAMP(3) NOT NULL,

    CONSTRAINT "teams_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "team_members" (
    "id" TEXT NOT NULL,
    "team_id" TEXT NOT NULL,
    "user_id" TEXT NOT NULL,
    "is_lead" BOOLEAN NOT NULL DEFAULT false,

    CONSTRAINT "team_members_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "queues" (
    "id" TEXT NOT NULL,
    "organization_id" TEXT NOT NULL,
    "workspace_id" TEXT,
    "name" TEXT NOT NULL,
    "key" TEXT NOT NULL,
    "description" TEXT,
    "team_id" TEXT,
    "channels" "ChannelType"[] DEFAULT ARRAY[]::"ChannelType"[],
    "languages" TEXT[] DEFAULT ARRAY[]::TEXT[],
    "skills" TEXT[] DEFAULT ARRAY[]::TEXT[],
    "strategy" "RoutingStrategy" NOT NULL DEFAULT 'round_robin',
    "priority" "Priority" NOT NULL DEFAULT 'normal',
    "sla_policy_id" TEXT,
    "business_hours_id" TEXT,
    "ai_agent_id" TEXT,
    "ai_first" BOOLEAN NOT NULL DEFAULT false,
    "max_wait_seconds" INTEGER,
    "is_active" BOOLEAN NOT NULL DEFAULT true,
    "created_at" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updated_at" TIMESTAMP(3) NOT NULL,

    CONSTRAINT "queues_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "business_hours" (
    "id" TEXT NOT NULL,
    "organization_id" TEXT NOT NULL,
    "name" TEXT NOT NULL,
    "timezone" TEXT NOT NULL DEFAULT 'UTC',
    "rules" JSONB NOT NULL DEFAULT '[]',
    "is_default" BOOLEAN NOT NULL DEFAULT false,
    "created_at" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updated_at" TIMESTAMP(3) NOT NULL,

    CONSTRAINT "business_hours_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "holidays" (
    "id" TEXT NOT NULL,
    "organization_id" TEXT NOT NULL,
    "business_hours_id" TEXT,
    "name" TEXT NOT NULL,
    "date" DATE NOT NULL,
    "recurring" BOOLEAN NOT NULL DEFAULT false,

    CONSTRAINT "holidays_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "custom_fields" (
    "id" TEXT NOT NULL,
    "organization_id" TEXT NOT NULL,
    "entity" TEXT NOT NULL,
    "key" TEXT NOT NULL,
    "label" TEXT NOT NULL,
    "type" TEXT NOT NULL,
    "options" JSONB NOT NULL DEFAULT '[]',
    "is_required" BOOLEAN NOT NULL DEFAULT false,
    "position" INTEGER NOT NULL DEFAULT 0,
    "created_at" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,

    CONSTRAINT "custom_fields_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "tags" (
    "id" TEXT NOT NULL,
    "organization_id" TEXT NOT NULL,
    "name" TEXT NOT NULL,
    "color" TEXT NOT NULL DEFAULT '#64748b',
    "category" TEXT,
    "created_at" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,

    CONSTRAINT "tags_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "saved_replies" (
    "id" TEXT NOT NULL,
    "organization_id" TEXT NOT NULL,
    "title" TEXT NOT NULL,
    "shortcut" TEXT,
    "body" TEXT NOT NULL,
    "locale" TEXT NOT NULL DEFAULT 'en',
    "tags" TEXT[] DEFAULT ARRAY[]::TEXT[],
    "created_by_id" TEXT,
    "created_at" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updated_at" TIMESTAMP(3) NOT NULL,

    CONSTRAINT "saved_replies_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "customers" (
    "id" TEXT NOT NULL,
    "organization_id" TEXT NOT NULL,
    "workspace_id" TEXT,
    "external_id" TEXT,
    "first_name" TEXT,
    "last_name" TEXT,
    "display_name" TEXT,
    "company" TEXT,
    "job_title" TEXT,
    "avatar_url" TEXT,
    "locale" TEXT NOT NULL DEFAULT 'en',
    "timezone" TEXT,
    "tier" TEXT,
    "tags" TEXT[] DEFAULT ARRAY[]::TEXT[],
    "attributes" JSONB NOT NULL DEFAULT '{}',
    "consent_ai_memory" BOOLEAN NOT NULL DEFAULT true,
    "merged_into_id" TEXT,
    "last_seen_at" TIMESTAMP(3),
    "created_at" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updated_at" TIMESTAMP(3) NOT NULL,

    CONSTRAINT "customers_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "contact_methods" (
    "id" TEXT NOT NULL,
    "customer_id" TEXT NOT NULL,
    "organization_id" TEXT NOT NULL,
    "kind" TEXT NOT NULL,
    "value" TEXT NOT NULL,
    "normalized" TEXT NOT NULL,
    "is_primary" BOOLEAN NOT NULL DEFAULT false,
    "is_verified" BOOLEAN NOT NULL DEFAULT false,
    "created_at" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,

    CONSTRAINT "contact_methods_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "customer_notes" (
    "id" TEXT NOT NULL,
    "organization_id" TEXT NOT NULL,
    "customer_id" TEXT NOT NULL,
    "author_id" TEXT,
    "body" TEXT NOT NULL,
    "is_pinned" BOOLEAN NOT NULL DEFAULT false,
    "created_at" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,

    CONSTRAINT "customer_notes_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "customer_activities" (
    "id" TEXT NOT NULL,
    "organization_id" TEXT NOT NULL,
    "customer_id" TEXT NOT NULL,
    "kind" TEXT NOT NULL,
    "title" TEXT NOT NULL,
    "summary" TEXT,
    "ref_type" TEXT,
    "ref_id" TEXT,
    "metadata" JSONB NOT NULL DEFAULT '{}',
    "occurred_at" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,

    CONSTRAINT "customer_activities_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "customer_ai_contexts" (
    "id" TEXT NOT NULL,
    "organization_id" TEXT NOT NULL,
    "customer_id" TEXT NOT NULL,
    "summary" TEXT,
    "intent" TEXT,
    "sentiment" TEXT,
    "sentiment_score" DOUBLE PRECISION,
    "topics" TEXT[] DEFAULT ARRAY[]::TEXT[],
    "customer_type" TEXT,
    "risk_level" TEXT,
    "current_issue" TEXT,
    "previous_issues" JSONB NOT NULL DEFAULT '[]',
    "model" TEXT,
    "generated_at" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,

    CONSTRAINT "customer_ai_contexts_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "segments" (
    "id" TEXT NOT NULL,
    "organization_id" TEXT NOT NULL,
    "name" TEXT NOT NULL,
    "description" TEXT,
    "definition" JSONB NOT NULL DEFAULT '{}',
    "created_at" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updated_at" TIMESTAMP(3) NOT NULL,

    CONSTRAINT "segments_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "channel_accounts" (
    "id" TEXT NOT NULL,
    "organization_id" TEXT NOT NULL,
    "workspace_id" TEXT,
    "channel" "ChannelType" NOT NULL,
    "name" TEXT NOT NULL,
    "credentials" JSONB NOT NULL DEFAULT '{}',
    "config" JSONB NOT NULL DEFAULT '{}',
    "queue_id" TEXT,
    "is_active" BOOLEAN NOT NULL DEFAULT true,
    "created_at" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updated_at" TIMESTAMP(3) NOT NULL,

    CONSTRAINT "channel_accounts_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "conversations" (
    "id" TEXT NOT NULL,
    "organization_id" TEXT NOT NULL,
    "workspace_id" TEXT,
    "reference" TEXT NOT NULL,
    "channel" "ChannelType" NOT NULL,
    "channel_account_id" TEXT,
    "external_id" TEXT,
    "thread_key" TEXT,
    "customer_id" TEXT,
    "subject" TEXT,
    "status" "ConversationStatus" NOT NULL DEFAULT 'new',
    "priority" "Priority" NOT NULL DEFAULT 'normal',
    "queue_id" TEXT,
    "team_id" TEXT,
    "assignee_type" "AssigneeType" NOT NULL DEFAULT 'none',
    "assignee_id" TEXT,
    "ai_agent_id" TEXT,
    "ai_handled" BOOLEAN NOT NULL DEFAULT false,
    "handoff_reason" TEXT,
    "locale" TEXT NOT NULL DEFAULT 'en',
    "tags" TEXT[] DEFAULT ARRAY[]::TEXT[],
    "attributes" JSONB NOT NULL DEFAULT '{}',
    "metadata" JSONB NOT NULL DEFAULT '{}',
    "last_message_at" TIMESTAMP(3),
    "first_response_at" TIMESTAMP(3),
    "queued_at" TIMESTAMP(3),
    "assigned_at" TIMESTAMP(3),
    "resolved_at" TIMESTAMP(3),
    "closed_at" TIMESTAMP(3),
    "waiting_since" TIMESTAMP(3),
    "csat_score" INTEGER,
    "csat_comment" TEXT,
    "message_count" INTEGER NOT NULL DEFAULT 0,
    "version" INTEGER NOT NULL DEFAULT 0,
    "created_at" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updated_at" TIMESTAMP(3) NOT NULL,

    CONSTRAINT "conversations_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "messages" (
    "id" TEXT NOT NULL,
    "organization_id" TEXT NOT NULL,
    "conversation_id" TEXT NOT NULL,
    "external_id" TEXT,
    "direction" "MessageDirection" NOT NULL,
    "type" "MessageType" NOT NULL DEFAULT 'text',
    "author_type" "ActorType" NOT NULL,
    "author_id" TEXT,
    "author_name" TEXT,
    "body" TEXT NOT NULL,
    "body_html" TEXT,
    "redacted_body" TEXT,
    "language" TEXT,
    "delivery_state" "DeliveryState" NOT NULL DEFAULT 'pending',
    "delivery_error" TEXT,
    "citations" JSONB NOT NULL DEFAULT '[]',
    "metadata" JSONB NOT NULL DEFAULT '{}',
    "is_private" BOOLEAN NOT NULL DEFAULT false,
    "created_at" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,

    CONSTRAINT "messages_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "attachments" (
    "id" TEXT NOT NULL,
    "organization_id" TEXT NOT NULL,
    "message_id" TEXT,
    "ticket_id" TEXT,
    "filename" TEXT NOT NULL,
    "content_type" TEXT NOT NULL,
    "size_bytes" INTEGER NOT NULL,
    "storage_key" TEXT NOT NULL,
    "checksum" TEXT,
    "uploaded_by_id" TEXT,
    "created_at" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,

    CONSTRAINT "attachments_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "participants" (
    "id" TEXT NOT NULL,
    "organization_id" TEXT NOT NULL,
    "conversation_id" TEXT NOT NULL,
    "actor_type" "ActorType" NOT NULL,
    "actor_id" TEXT NOT NULL,
    "display_name" TEXT,
    "role" TEXT NOT NULL DEFAULT 'participant',
    "joined_at" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "left_at" TIMESTAMP(3),
    "last_read_at" TIMESTAMP(3),

    CONSTRAINT "participants_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "conversation_events" (
    "id" TEXT NOT NULL,
    "organization_id" TEXT NOT NULL,
    "conversation_id" TEXT NOT NULL,
    "type" TEXT NOT NULL,
    "actor_type" "ActorType" NOT NULL DEFAULT 'system',
    "actor_id" TEXT,
    "data" JSONB NOT NULL DEFAULT '{}',
    "created_at" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,

    CONSTRAINT "conversation_events_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "tickets" (
    "id" TEXT NOT NULL,
    "organization_id" TEXT NOT NULL,
    "workspace_id" TEXT,
    "number" INTEGER NOT NULL,
    "reference" TEXT NOT NULL,
    "subject" TEXT NOT NULL,
    "description" TEXT,
    "status" "TicketStatus" NOT NULL DEFAULT 'open',
    "priority" "Priority" NOT NULL DEFAULT 'normal',
    "category" TEXT,
    "customer_id" TEXT,
    "conversation_id" TEXT,
    "assignee_id" TEXT,
    "team_id" TEXT,
    "queue_id" TEXT,
    "sla_policy_id" TEXT,
    "labels" TEXT[] DEFAULT ARRAY[]::TEXT[],
    "custom_fields" JSONB NOT NULL DEFAULT '{}',
    "source" "ChannelType" NOT NULL DEFAULT 'api',
    "due_at" TIMESTAMP(3),
    "first_response_at" TIMESTAMP(3),
    "resolved_at" TIMESTAMP(3),
    "closed_at" TIMESTAMP(3),
    "reopen_count" INTEGER NOT NULL DEFAULT 0,
    "version" INTEGER NOT NULL DEFAULT 0,
    "created_by_id" TEXT,
    "created_at" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updated_at" TIMESTAMP(3) NOT NULL,

    CONSTRAINT "tickets_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "ticket_comments" (
    "id" TEXT NOT NULL,
    "organization_id" TEXT NOT NULL,
    "ticket_id" TEXT NOT NULL,
    "author_type" "ActorType" NOT NULL DEFAULT 'user',
    "author_id" TEXT,
    "body" TEXT NOT NULL,
    "is_internal" BOOLEAN NOT NULL DEFAULT false,
    "created_at" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,

    CONSTRAINT "ticket_comments_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "ticket_history" (
    "id" TEXT NOT NULL,
    "organization_id" TEXT NOT NULL,
    "ticket_id" TEXT NOT NULL,
    "actor_type" "ActorType" NOT NULL DEFAULT 'user',
    "actor_id" TEXT,
    "field" TEXT NOT NULL,
    "from_value" TEXT,
    "to_value" TEXT,
    "created_at" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,

    CONSTRAINT "ticket_history_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "ticket_templates" (
    "id" TEXT NOT NULL,
    "organization_id" TEXT NOT NULL,
    "name" TEXT NOT NULL,
    "subject" TEXT NOT NULL,
    "description" TEXT,
    "priority" "Priority" NOT NULL DEFAULT 'normal',
    "category" TEXT,
    "labels" TEXT[] DEFAULT ARRAY[]::TEXT[],
    "custom_fields" JSONB NOT NULL DEFAULT '{}',
    "created_at" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,

    CONSTRAINT "ticket_templates_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "ticket_counters" (
    "organization_id" TEXT NOT NULL,
    "next_number" INTEGER NOT NULL DEFAULT 1,

    CONSTRAINT "ticket_counters_pkey" PRIMARY KEY ("organization_id")
);

-- CreateTable
CREATE TABLE "sla_policies" (
    "id" TEXT NOT NULL,
    "organization_id" TEXT NOT NULL,
    "name" TEXT NOT NULL,
    "description" TEXT,
    "business_hours_id" TEXT,
    "conditions" JSONB NOT NULL DEFAULT '{}',
    "is_default" BOOLEAN NOT NULL DEFAULT false,
    "is_active" BOOLEAN NOT NULL DEFAULT true,
    "created_at" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updated_at" TIMESTAMP(3) NOT NULL,

    CONSTRAINT "sla_policies_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "sla_targets" (
    "id" TEXT NOT NULL,
    "organization_id" TEXT NOT NULL,
    "policy_id" TEXT NOT NULL,
    "type" "SlaTargetType" NOT NULL,
    "priority" "Priority" NOT NULL,
    "duration_minutes" INTEGER NOT NULL,
    "warning_percent" INTEGER NOT NULL DEFAULT 75,
    "escalate_to_team_id" TEXT,
    "escalate_to_user_id" TEXT,

    CONSTRAINT "sla_targets_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "sla_clocks" (
    "id" TEXT NOT NULL,
    "organization_id" TEXT NOT NULL,
    "policy_id" TEXT NOT NULL,
    "target_id" TEXT NOT NULL,
    "type" "SlaTargetType" NOT NULL,
    "conversation_id" TEXT,
    "ticket_id" TEXT,
    "state" "SlaClockState" NOT NULL DEFAULT 'running',
    "started_at" TIMESTAMP(3) NOT NULL,
    "due_at" TIMESTAMP(3) NOT NULL,
    "warn_at" TIMESTAMP(3) NOT NULL,
    "paused_at" TIMESTAMP(3),
    "paused_ms" INTEGER NOT NULL DEFAULT 0,
    "completed_at" TIMESTAMP(3),
    "breached_at" TIMESTAMP(3),
    "warned_at" TIMESTAMP(3),
    "escalated_at" TIMESTAMP(3),
    "elapsed_ms" INTEGER,

    CONSTRAINT "sla_clocks_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "routing_rules" (
    "id" TEXT NOT NULL,
    "organization_id" TEXT NOT NULL,
    "workspace_id" TEXT,
    "name" TEXT NOT NULL,
    "position" INTEGER NOT NULL DEFAULT 0,
    "strategy" "RoutingStrategy" NOT NULL DEFAULT 'round_robin',
    "conditions" JSONB NOT NULL DEFAULT '{}',
    "target_queue_id" TEXT,
    "target_team_id" TEXT,
    "target_user_id" TEXT,
    "target_agent_id" TEXT,
    "require_skills" TEXT[] DEFAULT ARRAY[]::TEXT[],
    "is_active" BOOLEAN NOT NULL DEFAULT true,
    "created_at" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updated_at" TIMESTAMP(3) NOT NULL,

    CONSTRAINT "routing_rules_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "round_robin_cursors" (
    "id" TEXT NOT NULL,
    "queue_id" TEXT NOT NULL,
    "last_index" INTEGER NOT NULL DEFAULT 0,

    CONSTRAINT "round_robin_cursors_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "knowledge_bases" (
    "id" TEXT NOT NULL,
    "organization_id" TEXT NOT NULL,
    "workspace_id" TEXT,
    "name" TEXT NOT NULL,
    "key" TEXT NOT NULL,
    "description" TEXT,
    "locale" TEXT NOT NULL DEFAULT 'en',
    "read_roles" TEXT[] DEFAULT ARRAY[]::TEXT[],
    "is_public" BOOLEAN NOT NULL DEFAULT false,
    "created_at" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updated_at" TIMESTAMP(3) NOT NULL,

    CONSTRAINT "knowledge_bases_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "knowledge_categories" (
    "id" TEXT NOT NULL,
    "organization_id" TEXT NOT NULL,
    "knowledge_base_id" TEXT NOT NULL,
    "parent_id" TEXT,
    "name" TEXT NOT NULL,
    "slug" TEXT NOT NULL,
    "position" INTEGER NOT NULL DEFAULT 0,

    CONSTRAINT "knowledge_categories_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "articles" (
    "id" TEXT NOT NULL,
    "organization_id" TEXT NOT NULL,
    "knowledge_base_id" TEXT NOT NULL,
    "category_id" TEXT,
    "title" TEXT NOT NULL,
    "slug" TEXT NOT NULL,
    "body" TEXT NOT NULL,
    "summary" TEXT,
    "locale" TEXT NOT NULL DEFAULT 'en',
    "state" "PublishState" NOT NULL DEFAULT 'draft',
    "version" INTEGER NOT NULL DEFAULT 1,
    "tags" TEXT[] DEFAULT ARRAY[]::TEXT[],
    "keywords" TEXT[] DEFAULT ARRAY[]::TEXT[],
    "author_id" TEXT,
    "published_at" TIMESTAMP(3),
    "view_count" INTEGER NOT NULL DEFAULT 0,
    "helpful_count" INTEGER NOT NULL DEFAULT 0,
    "created_at" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updated_at" TIMESTAMP(3) NOT NULL,

    CONSTRAINT "articles_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "article_versions" (
    "id" TEXT NOT NULL,
    "organization_id" TEXT NOT NULL,
    "article_id" TEXT NOT NULL,
    "version" INTEGER NOT NULL,
    "title" TEXT NOT NULL,
    "body" TEXT NOT NULL,
    "author_id" TEXT,
    "change_note" TEXT,
    "created_at" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,

    CONSTRAINT "article_versions_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "knowledge_sources" (
    "id" TEXT NOT NULL,
    "organization_id" TEXT NOT NULL,
    "knowledge_base_id" TEXT NOT NULL,
    "type" "SourceType" NOT NULL,
    "name" TEXT NOT NULL,
    "location" TEXT,
    "config" JSONB NOT NULL DEFAULT '{}',
    "sync_cron" TEXT,
    "last_sync_at" TIMESTAMP(3),
    "last_sync_status" TEXT,
    "is_active" BOOLEAN NOT NULL DEFAULT true,
    "created_at" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updated_at" TIMESTAMP(3) NOT NULL,

    CONSTRAINT "knowledge_sources_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "documents" (
    "id" TEXT NOT NULL,
    "organization_id" TEXT NOT NULL,
    "knowledge_base_id" TEXT NOT NULL,
    "source_id" TEXT,
    "article_id" TEXT,
    "title" TEXT NOT NULL,
    "type" "SourceType" NOT NULL DEFAULT 'file',
    "uri" TEXT,
    "content_type" TEXT,
    "storage_key" TEXT,
    "content_hash" TEXT,
    "text" TEXT,
    "locale" TEXT NOT NULL DEFAULT 'en',
    "metadata" JSONB NOT NULL DEFAULT '{}',
    "status" "IngestionStatus" NOT NULL DEFAULT 'pending',
    "status_message" TEXT,
    "chunk_count" INTEGER NOT NULL DEFAULT 0,
    "token_count" INTEGER NOT NULL DEFAULT 0,
    "version" INTEGER NOT NULL DEFAULT 1,
    "indexed_at" TIMESTAMP(3),
    "created_at" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updated_at" TIMESTAMP(3) NOT NULL,

    CONSTRAINT "documents_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "chunks" (
    "id" TEXT NOT NULL,
    "organization_id" TEXT NOT NULL,
    "knowledge_base_id" TEXT NOT NULL,
    "document_id" TEXT NOT NULL,
    "position" INTEGER NOT NULL,
    "heading" TEXT,
    "content" TEXT NOT NULL,
    "token_count" INTEGER NOT NULL DEFAULT 0,
    "locale" TEXT NOT NULL DEFAULT 'en',
    "metadata" JSONB NOT NULL DEFAULT '{}',
    "embedding_model" TEXT,
    "embedding" vector(1536),
    "created_at" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,

    CONSTRAINT "chunks_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "retrieval_logs" (
    "id" TEXT NOT NULL,
    "organization_id" TEXT NOT NULL,
    "query" TEXT NOT NULL,
    "knowledge_base_ids" TEXT[] DEFAULT ARRAY[]::TEXT[],
    "hit_count" INTEGER NOT NULL DEFAULT 0,
    "top_score" DOUBLE PRECISION,
    "latency_ms" INTEGER NOT NULL,
    "execution_id" TEXT,
    "conversation_id" TEXT,
    "created_at" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,

    CONSTRAINT "retrieval_logs_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "model_routes" (
    "id" TEXT NOT NULL,
    "organization_id" TEXT NOT NULL,
    "role" "ModelRole" NOT NULL,
    "provider" "AiProvider" NOT NULL,
    "model" TEXT NOT NULL,
    "fallbacks" JSONB NOT NULL DEFAULT '[]',
    "temperature" DOUBLE PRECISION,
    "max_tokens" INTEGER,
    "is_active" BOOLEAN NOT NULL DEFAULT true,
    "created_at" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updated_at" TIMESTAMP(3) NOT NULL,

    CONSTRAINT "model_routes_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "ai_usage" (
    "id" TEXT NOT NULL,
    "organization_id" TEXT NOT NULL,
    "workspace_id" TEXT,
    "role" "ModelRole" NOT NULL,
    "provider" "AiProvider" NOT NULL,
    "model" TEXT NOT NULL,
    "operation" TEXT NOT NULL,
    "prompt_tokens" INTEGER NOT NULL DEFAULT 0,
    "completion_tokens" INTEGER NOT NULL DEFAULT 0,
    "total_tokens" INTEGER NOT NULL DEFAULT 0,
    "cost_usd" DECIMAL(12,6) NOT NULL DEFAULT 0,
    "latency_ms" INTEGER NOT NULL,
    "cached" BOOLEAN NOT NULL DEFAULT false,
    "succeeded" BOOLEAN NOT NULL DEFAULT true,
    "error_code" TEXT,
    "agent_id" TEXT,
    "execution_id" TEXT,
    "conversation_id" TEXT,
    "user_id" TEXT,
    "created_at" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,

    CONSTRAINT "ai_usage_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "governance_policies" (
    "id" TEXT NOT NULL,
    "organization_id" TEXT NOT NULL,
    "allowed_providers" TEXT[] DEFAULT ARRAY[]::TEXT[],
    "allowed_models" TEXT[] DEFAULT ARRAY[]::TEXT[],
    "allowed_tools" TEXT[] DEFAULT ARRAY[]::TEXT[],
    "monthly_token_limit" INTEGER,
    "monthly_cost_limit_usd" DECIMAL(12,2),
    "per_execution_token_cap" INTEGER,
    "require_human_approval" BOOLEAN NOT NULL DEFAULT false,
    "data_retention_days" INTEGER NOT NULL DEFAULT 365,
    "allow_training" BOOLEAN NOT NULL DEFAULT false,
    "updated_at" TIMESTAMP(3) NOT NULL,

    CONSTRAINT "governance_policies_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "agents" (
    "id" TEXT NOT NULL,
    "organization_id" TEXT NOT NULL,
    "workspace_id" TEXT,
    "name" TEXT NOT NULL,
    "key" TEXT NOT NULL,
    "description" TEXT,
    "avatar_url" TEXT,
    "state" "PublishState" NOT NULL DEFAULT 'draft',
    "active_version_id" TEXT,
    "draft_version_id" TEXT,
    "created_by_id" TEXT,
    "created_at" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updated_at" TIMESTAMP(3) NOT NULL,

    CONSTRAINT "agents_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "agent_versions" (
    "id" TEXT NOT NULL,
    "organization_id" TEXT NOT NULL,
    "agent_id" TEXT NOT NULL,
    "version" INTEGER NOT NULL,
    "instructions" TEXT NOT NULL,
    "model_role" "ModelRole" NOT NULL DEFAULT 'chat',
    "model_override" TEXT,
    "temperature" DOUBLE PRECISION NOT NULL DEFAULT 0.3,
    "max_tokens" INTEGER NOT NULL DEFAULT 1024,
    "knowledge_base_ids" TEXT[] DEFAULT ARRAY[]::TEXT[],
    "tool_ids" TEXT[] DEFAULT ARRAY[]::TEXT[],
    "workflow_id" TEXT,
    "memory_policy" JSONB NOT NULL DEFAULT '{}',
    "guardrail_policy_id" TEXT,
    "handoff_rules" JSONB NOT NULL DEFAULT '{}',
    "greeting" TEXT,
    "fallback_message" TEXT,
    "locales" TEXT[] DEFAULT ARRAY['en']::TEXT[],
    "environment" "Environment" NOT NULL DEFAULT 'development',
    "published_at" TIMESTAMP(3),
    "published_by_id" TEXT,
    "evaluation_run_id" TEXT,
    "created_at" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,

    CONSTRAINT "agent_versions_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "workflows" (
    "id" TEXT NOT NULL,
    "organization_id" TEXT NOT NULL,
    "workspace_id" TEXT,
    "name" TEXT NOT NULL,
    "key" TEXT NOT NULL,
    "description" TEXT,
    "state" "PublishState" NOT NULL DEFAULT 'draft',
    "active_version_id" TEXT,
    "created_by_id" TEXT,
    "created_at" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updated_at" TIMESTAMP(3) NOT NULL,

    CONSTRAINT "workflows_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "workflow_versions" (
    "id" TEXT NOT NULL,
    "organization_id" TEXT NOT NULL,
    "workflow_id" TEXT NOT NULL,
    "version" INTEGER NOT NULL,
    "graph" JSONB NOT NULL,
    "input_schema" JSONB NOT NULL DEFAULT '{}',
    "variables" JSONB NOT NULL DEFAULT '{}',
    "timeout_seconds" INTEGER NOT NULL DEFAULT 300,
    "max_retries" INTEGER NOT NULL DEFAULT 2,
    "published_at" TIMESTAMP(3),
    "published_by_id" TEXT,
    "created_at" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,

    CONSTRAINT "workflow_versions_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "executions" (
    "id" TEXT NOT NULL,
    "organization_id" TEXT NOT NULL,
    "workspace_id" TEXT,
    "workflow_id" TEXT,
    "workflow_version_id" TEXT,
    "agent_id" TEXT,
    "agent_version_id" TEXT,
    "conversation_id" TEXT,
    "trigger_type" TEXT NOT NULL,
    "idempotency_key" TEXT,
    "status" "ExecutionStatus" NOT NULL DEFAULT 'queued',
    "input" JSONB NOT NULL DEFAULT '{}',
    "output" JSONB,
    "state" JSONB NOT NULL DEFAULT '{}',
    "current_node_id" TEXT,
    "resume_token" TEXT,
    "suspend_reason" TEXT,
    "resume_after" TIMESTAMP(3),
    "error" TEXT,
    "error_node_id" TEXT,
    "attempt" INTEGER NOT NULL DEFAULT 1,
    "prompt_tokens" INTEGER NOT NULL DEFAULT 0,
    "completion_tokens" INTEGER NOT NULL DEFAULT 0,
    "cost_usd" DECIMAL(12,6) NOT NULL DEFAULT 0,
    "started_at" TIMESTAMP(3),
    "finished_at" TIMESTAMP(3),
    "duration_ms" INTEGER,
    "created_at" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updated_at" TIMESTAMP(3) NOT NULL,

    CONSTRAINT "executions_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "execution_steps" (
    "id" TEXT NOT NULL,
    "organization_id" TEXT NOT NULL,
    "execution_id" TEXT NOT NULL,
    "sequence" INTEGER NOT NULL,
    "node_id" TEXT NOT NULL,
    "node_type" TEXT NOT NULL,
    "node_name" TEXT,
    "status" "StepStatus" NOT NULL DEFAULT 'pending',
    "input" JSONB NOT NULL DEFAULT '{}',
    "output" JSONB,
    "error" TEXT,
    "attempt" INTEGER NOT NULL DEFAULT 1,
    "logs" JSONB NOT NULL DEFAULT '[]',
    "prompt_tokens" INTEGER NOT NULL DEFAULT 0,
    "completion_tokens" INTEGER NOT NULL DEFAULT 0,
    "cost_usd" DECIMAL(12,6) NOT NULL DEFAULT 0,
    "model" TEXT,
    "started_at" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "finished_at" TIMESTAMP(3),
    "duration_ms" INTEGER,

    CONSTRAINT "execution_steps_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "tool_definitions" (
    "id" TEXT NOT NULL,
    "organization_id" TEXT NOT NULL,
    "workspace_id" TEXT,
    "key" TEXT NOT NULL,
    "name" TEXT NOT NULL,
    "description" TEXT NOT NULL,
    "kind" TEXT NOT NULL DEFAULT 'http',
    "handler" TEXT,
    "method" TEXT NOT NULL DEFAULT 'POST',
    "url" TEXT,
    "headers" JSONB NOT NULL DEFAULT '{}',
    "auth" JSONB NOT NULL DEFAULT '{}',
    "input_schema" JSONB NOT NULL DEFAULT '{}',
    "output_schema" JSONB NOT NULL DEFAULT '{}',
    "timeout_ms" INTEGER NOT NULL DEFAULT 10000,
    "requires_approval" BOOLEAN NOT NULL DEFAULT false,
    "is_active" BOOLEAN NOT NULL DEFAULT true,
    "created_by_id" TEXT,
    "created_at" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updated_at" TIMESTAMP(3) NOT NULL,

    CONSTRAINT "tool_definitions_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "tool_invocations" (
    "id" TEXT NOT NULL,
    "organization_id" TEXT NOT NULL,
    "tool_id" TEXT NOT NULL,
    "execution_id" TEXT,
    "step_id" TEXT,
    "input" JSONB NOT NULL DEFAULT '{}',
    "output" JSONB,
    "status" TEXT NOT NULL DEFAULT 'succeeded',
    "status_code" INTEGER,
    "error" TEXT,
    "duration_ms" INTEGER NOT NULL,
    "created_at" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,

    CONSTRAINT "tool_invocations_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "memory_entries" (
    "id" TEXT NOT NULL,
    "organization_id" TEXT NOT NULL,
    "scope" "MemoryScope" NOT NULL,
    "agent_id" TEXT,
    "customer_id" TEXT,
    "conversation_id" TEXT,
    "execution_id" TEXT,
    "key" TEXT NOT NULL,
    "value" JSONB NOT NULL,
    "importance" DOUBLE PRECISION NOT NULL DEFAULT 0.5,
    "contains_pii" BOOLEAN NOT NULL DEFAULT false,
    "consent_given" BOOLEAN NOT NULL DEFAULT true,
    "expires_at" TIMESTAMP(3),
    "created_at" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updated_at" TIMESTAMP(3) NOT NULL,

    CONSTRAINT "memory_entries_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "guardrail_policies" (
    "id" TEXT NOT NULL,
    "organization_id" TEXT NOT NULL,
    "name" TEXT NOT NULL,
    "description" TEXT,
    "rules" JSONB NOT NULL DEFAULT '[]',
    "confidence_threshold" DOUBLE PRECISION NOT NULL DEFAULT 0.7,
    "groundedness_mode" TEXT NOT NULL DEFAULT 'flag',
    "mask_pii" BOOLEAN NOT NULL DEFAULT true,
    "is_default" BOOLEAN NOT NULL DEFAULT false,
    "created_at" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updated_at" TIMESTAMP(3) NOT NULL,

    CONSTRAINT "guardrail_policies_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "guardrail_events" (
    "id" TEXT NOT NULL,
    "organization_id" TEXT NOT NULL,
    "policy_id" TEXT,
    "stage" "GuardrailStage" NOT NULL,
    "check" TEXT NOT NULL,
    "action" "GuardrailAction" NOT NULL,
    "severity" TEXT NOT NULL DEFAULT 'medium',
    "subject_type" TEXT,
    "subject_id" TEXT,
    "execution_id" TEXT,
    "conversation_id" TEXT,
    "detail" JSONB NOT NULL DEFAULT '{}',
    "created_at" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,

    CONSTRAINT "guardrail_events_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "automation_rules" (
    "id" TEXT NOT NULL,
    "organization_id" TEXT NOT NULL,
    "workspace_id" TEXT,
    "name" TEXT NOT NULL,
    "description" TEXT,
    "trigger" "AutomationTrigger" NOT NULL,
    "schedule" TEXT,
    "conditions" JSONB NOT NULL DEFAULT '{}',
    "actions" JSONB NOT NULL DEFAULT '[]',
    "position" INTEGER NOT NULL DEFAULT 0,
    "is_active" BOOLEAN NOT NULL DEFAULT true,
    "run_count" INTEGER NOT NULL DEFAULT 0,
    "last_run_at" TIMESTAMP(3),
    "created_by_id" TEXT,
    "created_at" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updated_at" TIMESTAMP(3) NOT NULL,

    CONSTRAINT "automation_rules_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "automation_runs" (
    "id" TEXT NOT NULL,
    "organization_id" TEXT NOT NULL,
    "rule_id" TEXT NOT NULL,
    "subject_type" TEXT NOT NULL,
    "subject_id" TEXT NOT NULL,
    "matched" BOOLEAN NOT NULL DEFAULT true,
    "actions_run" JSONB NOT NULL DEFAULT '[]',
    "error" TEXT,
    "duration_ms" INTEGER NOT NULL,
    "created_at" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,

    CONSTRAINT "automation_runs_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "qc_templates" (
    "id" TEXT NOT NULL,
    "organization_id" TEXT NOT NULL,
    "name" TEXT NOT NULL,
    "description" TEXT,
    "channels" "ChannelType"[] DEFAULT ARRAY[]::"ChannelType"[],
    "auto_evaluate" BOOLEAN NOT NULL DEFAULT true,
    "sample_percent" INTEGER NOT NULL DEFAULT 100,
    "passing_score" INTEGER NOT NULL DEFAULT 80,
    "is_active" BOOLEAN NOT NULL DEFAULT true,
    "created_at" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updated_at" TIMESTAMP(3) NOT NULL,

    CONSTRAINT "qc_templates_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "qc_criteria" (
    "id" TEXT NOT NULL,
    "organization_id" TEXT NOT NULL,
    "template_id" TEXT NOT NULL,
    "category" TEXT NOT NULL,
    "name" TEXT NOT NULL,
    "description" TEXT,
    "weight" INTEGER NOT NULL,
    "rubric" TEXT NOT NULL,
    "is_critical" BOOLEAN NOT NULL DEFAULT false,
    "position" INTEGER NOT NULL DEFAULT 0,

    CONSTRAINT "qc_criteria_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "qc_evaluations" (
    "id" TEXT NOT NULL,
    "organization_id" TEXT NOT NULL,
    "template_id" TEXT NOT NULL,
    "conversation_id" TEXT,
    "ticket_id" TEXT,
    "subject_type" "ActorType" NOT NULL DEFAULT 'user',
    "subject_id" TEXT,
    "kind" "EvaluationKind" NOT NULL DEFAULT 'ai',
    "score" DOUBLE PRECISION NOT NULL,
    "passed" BOOLEAN NOT NULL DEFAULT false,
    "reasoning" TEXT,
    "strengths" TEXT[] DEFAULT ARRAY[]::TEXT[],
    "improvements" TEXT[] DEFAULT ARRAY[]::TEXT[],
    "evaluator_id" TEXT,
    "model" TEXT,
    "status" TEXT NOT NULL DEFAULT 'final',
    "created_at" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,

    CONSTRAINT "qc_evaluations_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "qc_criterion_scores" (
    "id" TEXT NOT NULL,
    "organization_id" TEXT NOT NULL,
    "evaluation_id" TEXT NOT NULL,
    "criterion_id" TEXT NOT NULL,
    "score" DOUBLE PRECISION NOT NULL,
    "reasoning" TEXT,
    "evidence" JSONB NOT NULL DEFAULT '[]',

    CONSTRAINT "qc_criterion_scores_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "qc_disputes" (
    "id" TEXT NOT NULL,
    "organization_id" TEXT NOT NULL,
    "evaluation_id" TEXT NOT NULL,
    "raised_by_id" TEXT NOT NULL,
    "reason" TEXT NOT NULL,
    "status" TEXT NOT NULL DEFAULT 'open',
    "resolution" TEXT,
    "resolved_by_id" TEXT,
    "resolved_score" DOUBLE PRECISION,
    "created_at" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "resolved_at" TIMESTAMP(3),

    CONSTRAINT "qc_disputes_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "realtime_signals" (
    "id" TEXT NOT NULL,
    "organization_id" TEXT NOT NULL,
    "conversation_id" TEXT NOT NULL,
    "signal" TEXT NOT NULL,
    "severity" TEXT NOT NULL DEFAULT 'info',
    "message" TEXT NOT NULL,
    "guidance" TEXT,
    "message_id" TEXT,
    "acknowledged_by" TEXT,
    "acknowledged_at" TIMESTAMP(3),
    "created_at" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,

    CONSTRAINT "realtime_signals_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "conversation_intelligence" (
    "id" TEXT NOT NULL,
    "organization_id" TEXT NOT NULL,
    "conversation_id" TEXT NOT NULL,
    "intent" TEXT,
    "intent_confidence" DOUBLE PRECISION,
    "sentiment" TEXT,
    "sentiment_score" DOUBLE PRECISION,
    "sentiment_trend" TEXT,
    "topics" TEXT[] DEFAULT ARRAY[]::TEXT[],
    "entities" JSONB NOT NULL DEFAULT '[]',
    "products" TEXT[] DEFAULT ARRAY[]::TEXT[],
    "complaints" TEXT[] DEFAULT ARRAY[]::TEXT[],
    "reasons" TEXT[] DEFAULT ARRAY[]::TEXT[],
    "churn_risk" DOUBLE PRECISION,
    "preferences" JSONB NOT NULL DEFAULT '{}',
    "summary" TEXT,
    "resolution_type" TEXT,
    "model" TEXT,
    "created_at" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updated_at" TIMESTAMP(3) NOT NULL,

    CONSTRAINT "conversation_intelligence_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "evaluation_datasets" (
    "id" TEXT NOT NULL,
    "organization_id" TEXT NOT NULL,
    "name" TEXT NOT NULL,
    "description" TEXT,
    "agent_id" TEXT,
    "is_gate" BOOLEAN NOT NULL DEFAULT false,
    "pass_threshold" DOUBLE PRECISION NOT NULL DEFAULT 0.8,
    "created_at" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updated_at" TIMESTAMP(3) NOT NULL,

    CONSTRAINT "evaluation_datasets_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "evaluation_cases" (
    "id" TEXT NOT NULL,
    "organization_id" TEXT NOT NULL,
    "dataset_id" TEXT NOT NULL,
    "name" TEXT,
    "input" JSONB NOT NULL,
    "expected_output" TEXT,
    "expected_context" TEXT[] DEFAULT ARRAY[]::TEXT[],
    "expected_tools" TEXT[] DEFAULT ARRAY[]::TEXT[],
    "tags" TEXT[] DEFAULT ARRAY[]::TEXT[],
    "created_at" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,

    CONSTRAINT "evaluation_cases_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "evaluation_runs" (
    "id" TEXT NOT NULL,
    "organization_id" TEXT NOT NULL,
    "dataset_id" TEXT NOT NULL,
    "agent_id" TEXT,
    "agent_version_id" TEXT,
    "status" TEXT NOT NULL DEFAULT 'running',
    "case_count" INTEGER NOT NULL DEFAULT 0,
    "passed_count" INTEGER NOT NULL DEFAULT 0,
    "overall_score" DOUBLE PRECISION,
    "metrics" JSONB NOT NULL DEFAULT '{}',
    "avg_latency_ms" INTEGER,
    "total_cost_usd" DECIMAL(12,6) NOT NULL DEFAULT 0,
    "passed" BOOLEAN NOT NULL DEFAULT false,
    "triggered_by_id" TEXT,
    "started_at" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "finished_at" TIMESTAMP(3),

    CONSTRAINT "evaluation_runs_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "evaluation_results" (
    "id" TEXT NOT NULL,
    "organization_id" TEXT NOT NULL,
    "run_id" TEXT NOT NULL,
    "case_id" TEXT NOT NULL,
    "actual_output" TEXT,
    "retrieved_context" JSONB NOT NULL DEFAULT '[]',
    "tools_used" TEXT[] DEFAULT ARRAY[]::TEXT[],
    "scores" JSONB NOT NULL DEFAULT '{}',
    "overall_score" DOUBLE PRECISION NOT NULL DEFAULT 0,
    "passed" BOOLEAN NOT NULL DEFAULT false,
    "latency_ms" INTEGER NOT NULL DEFAULT 0,
    "cost_usd" DECIMAL(12,6) NOT NULL DEFAULT 0,
    "error" TEXT,
    "created_at" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,

    CONSTRAINT "evaluation_results_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "metrics_daily" (
    "id" TEXT NOT NULL,
    "organization_id" TEXT NOT NULL,
    "workspace_id" TEXT,
    "date" DATE NOT NULL,
    "metric" TEXT NOT NULL,
    "dimension" TEXT NOT NULL DEFAULT 'total',
    "dimension_value" TEXT NOT NULL DEFAULT 'all',
    "value" DOUBLE PRECISION NOT NULL DEFAULT 0,
    "count" INTEGER NOT NULL DEFAULT 0,
    "updated_at" TIMESTAMP(3) NOT NULL,

    CONSTRAINT "metrics_daily_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "saved_reports" (
    "id" TEXT NOT NULL,
    "organization_id" TEXT NOT NULL,
    "name" TEXT NOT NULL,
    "description" TEXT,
    "definition" JSONB NOT NULL DEFAULT '{}',
    "visualization" TEXT NOT NULL DEFAULT 'table',
    "schedule_cron" TEXT,
    "recipients" TEXT[] DEFAULT ARRAY[]::TEXT[],
    "format" TEXT NOT NULL DEFAULT 'csv',
    "last_run_at" TIMESTAMP(3),
    "created_by_id" TEXT,
    "created_at" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updated_at" TIMESTAMP(3) NOT NULL,

    CONSTRAINT "saved_reports_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "notification_rules" (
    "id" TEXT NOT NULL,
    "organization_id" TEXT NOT NULL,
    "event" TEXT NOT NULL,
    "name" TEXT NOT NULL,
    "channels" "NotificationChannel"[] DEFAULT ARRAY[]::"NotificationChannel"[],
    "audience" JSONB NOT NULL DEFAULT '{}',
    "template" TEXT,
    "conditions" JSONB NOT NULL DEFAULT '{}',
    "is_active" BOOLEAN NOT NULL DEFAULT true,
    "created_at" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updated_at" TIMESTAMP(3) NOT NULL,

    CONSTRAINT "notification_rules_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "notifications" (
    "id" TEXT NOT NULL,
    "organization_id" TEXT NOT NULL,
    "user_id" TEXT,
    "channel" "NotificationChannel" NOT NULL DEFAULT 'in_app',
    "event" TEXT NOT NULL,
    "title" TEXT NOT NULL,
    "body" TEXT,
    "link" TEXT,
    "data" JSONB NOT NULL DEFAULT '{}',
    "read_at" TIMESTAMP(3),
    "sent_at" TIMESTAMP(3),
    "failed_reason" TEXT,
    "created_at" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,

    CONSTRAINT "notifications_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "usage_records" (
    "id" TEXT NOT NULL,
    "organization_id" TEXT NOT NULL,
    "workspace_id" TEXT,
    "metric" TEXT NOT NULL,
    "quantity" DECIMAL(16,4) NOT NULL,
    "unit" TEXT NOT NULL,
    "period_start" TIMESTAMP(3) NOT NULL,
    "period_end" TIMESTAMP(3) NOT NULL,
    "metadata" JSONB NOT NULL DEFAULT '{}',
    "created_at" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,

    CONSTRAINT "usage_records_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "integrations" (
    "id" TEXT NOT NULL,
    "organization_id" TEXT NOT NULL,
    "workspace_id" TEXT,
    "kind" "IntegrationKind" NOT NULL,
    "name" TEXT NOT NULL,
    "credentials" JSONB NOT NULL DEFAULT '{}',
    "config" JSONB NOT NULL DEFAULT '{}',
    "field_mapping" JSONB NOT NULL DEFAULT '{}',
    "status" TEXT NOT NULL DEFAULT 'disconnected',
    "last_sync_at" TIMESTAMP(3),
    "last_error" TEXT,
    "is_active" BOOLEAN NOT NULL DEFAULT true,
    "created_at" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updated_at" TIMESTAMP(3) NOT NULL,

    CONSTRAINT "integrations_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "webhook_endpoints" (
    "id" TEXT NOT NULL,
    "organization_id" TEXT NOT NULL,
    "name" TEXT NOT NULL,
    "url" TEXT NOT NULL,
    "secret" TEXT NOT NULL,
    "events" TEXT[] DEFAULT ARRAY[]::TEXT[],
    "is_active" BOOLEAN NOT NULL DEFAULT true,
    "failure_count" INTEGER NOT NULL DEFAULT 0,
    "disabled_at" TIMESTAMP(3),
    "created_at" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updated_at" TIMESTAMP(3) NOT NULL,

    CONSTRAINT "webhook_endpoints_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "webhook_deliveries" (
    "id" TEXT NOT NULL,
    "organization_id" TEXT NOT NULL,
    "endpoint_id" TEXT NOT NULL,
    "event_id" TEXT NOT NULL,
    "event_type" TEXT NOT NULL,
    "payload" JSONB NOT NULL,
    "attempts" INTEGER NOT NULL DEFAULT 0,
    "status_code" INTEGER,
    "response_body" TEXT,
    "error" TEXT,
    "delivered_at" TIMESTAMP(3),
    "next_attempt_at" TIMESTAMP(3),
    "created_at" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,

    CONSTRAINT "webhook_deliveries_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "outbox_events" (
    "id" TEXT NOT NULL,
    "organization_id" TEXT NOT NULL,
    "workspace_id" TEXT,
    "type" TEXT NOT NULL,
    "version" INTEGER NOT NULL DEFAULT 1,
    "actor_type" "ActorType" NOT NULL DEFAULT 'system',
    "actor_id" TEXT,
    "subject_type" TEXT NOT NULL,
    "subject_id" TEXT NOT NULL,
    "data" JSONB NOT NULL DEFAULT '{}',
    "correlation_id" TEXT,
    "causation_id" TEXT,
    "status" "OutboxStatus" NOT NULL DEFAULT 'pending',
    "attempts" INTEGER NOT NULL DEFAULT 0,
    "last_error" TEXT,
    "published_at" TIMESTAMP(3),
    "occurred_at" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,

    CONSTRAINT "outbox_events_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "idempotency_keys" (
    "id" TEXT NOT NULL,
    "organization_id" TEXT NOT NULL,
    "key" TEXT NOT NULL,
    "endpoint" TEXT NOT NULL,
    "request_hash" TEXT NOT NULL,
    "status_code" INTEGER,
    "response" JSONB,
    "created_at" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "expires_at" TIMESTAMP(3) NOT NULL,

    CONSTRAINT "idempotency_keys_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "api_request_logs" (
    "id" TEXT NOT NULL,
    "organization_id" TEXT,
    "method" TEXT NOT NULL,
    "path" TEXT NOT NULL,
    "status_code" INTEGER NOT NULL,
    "duration_ms" INTEGER NOT NULL,
    "principal_type" TEXT,
    "principal_id" TEXT,
    "api_key_id" TEXT,
    "ip_address" TEXT,
    "user_agent" TEXT,
    "request_id" TEXT NOT NULL,
    "error_code" TEXT,
    "created_at" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,

    CONSTRAINT "api_request_logs_pkey" PRIMARY KEY ("id")
);

-- CreateIndex
CREATE UNIQUE INDEX "organizations_slug_key" ON "organizations"("slug");

-- CreateIndex
CREATE INDEX "workspaces_organization_id_idx" ON "workspaces"("organization_id");

-- CreateIndex
CREATE UNIQUE INDEX "workspaces_organization_id_slug_key" ON "workspaces"("organization_id", "slug");

-- CreateIndex
CREATE INDEX "subscriptions_organization_id_idx" ON "subscriptions"("organization_id");

-- CreateIndex
CREATE UNIQUE INDEX "users_email_key" ON "users"("email");

-- CreateIndex
CREATE INDEX "users_email_idx" ON "users"("email");

-- CreateIndex
CREATE INDEX "memberships_organization_id_idx" ON "memberships"("organization_id");

-- CreateIndex
CREATE INDEX "memberships_user_id_idx" ON "memberships"("user_id");

-- CreateIndex
CREATE UNIQUE INDEX "memberships_organization_id_user_id_key" ON "memberships"("organization_id", "user_id");

-- CreateIndex
CREATE INDEX "roles_organization_id_idx" ON "roles"("organization_id");

-- CreateIndex
CREATE UNIQUE INDEX "roles_organization_id_key_key" ON "roles"("organization_id", "key");

-- CreateIndex
CREATE UNIQUE INDEX "sessions_refresh_token_hash_key" ON "sessions"("refresh_token_hash");

-- CreateIndex
CREATE INDEX "sessions_user_id_idx" ON "sessions"("user_id");

-- CreateIndex
CREATE INDEX "sessions_expires_at_idx" ON "sessions"("expires_at");

-- CreateIndex
CREATE UNIQUE INDEX "verification_tokens_token_hash_key" ON "verification_tokens"("token_hash");

-- CreateIndex
CREATE INDEX "verification_tokens_user_id_purpose_idx" ON "verification_tokens"("user_id", "purpose");

-- CreateIndex
CREATE UNIQUE INDEX "api_keys_key_hash_key" ON "api_keys"("key_hash");

-- CreateIndex
CREATE INDEX "api_keys_organization_id_idx" ON "api_keys"("organization_id");

-- CreateIndex
CREATE UNIQUE INDEX "sso_connections_organization_id_domain_key" ON "sso_connections"("organization_id", "domain");

-- CreateIndex
CREATE INDEX "audit_events_organization_id_created_at_idx" ON "audit_events"("organization_id", "created_at");

-- CreateIndex
CREATE INDEX "audit_events_organization_id_resource_type_resource_id_idx" ON "audit_events"("organization_id", "resource_type", "resource_id");

-- CreateIndex
CREATE INDEX "audit_events_organization_id_actor_id_idx" ON "audit_events"("organization_id", "actor_id");

-- CreateIndex
CREATE INDEX "teams_organization_id_idx" ON "teams"("organization_id");

-- CreateIndex
CREATE INDEX "team_members_user_id_idx" ON "team_members"("user_id");

-- CreateIndex
CREATE UNIQUE INDEX "team_members_team_id_user_id_key" ON "team_members"("team_id", "user_id");

-- CreateIndex
CREATE INDEX "queues_organization_id_idx" ON "queues"("organization_id");

-- CreateIndex
CREATE UNIQUE INDEX "queues_organization_id_key_key" ON "queues"("organization_id", "key");

-- CreateIndex
CREATE INDEX "business_hours_organization_id_idx" ON "business_hours"("organization_id");

-- CreateIndex
CREATE INDEX "holidays_organization_id_date_idx" ON "holidays"("organization_id", "date");

-- CreateIndex
CREATE INDEX "custom_fields_organization_id_idx" ON "custom_fields"("organization_id");

-- CreateIndex
CREATE UNIQUE INDEX "custom_fields_organization_id_entity_key_key" ON "custom_fields"("organization_id", "entity", "key");

-- CreateIndex
CREATE INDEX "tags_organization_id_idx" ON "tags"("organization_id");

-- CreateIndex
CREATE UNIQUE INDEX "tags_organization_id_name_key" ON "tags"("organization_id", "name");

-- CreateIndex
CREATE INDEX "saved_replies_organization_id_idx" ON "saved_replies"("organization_id");

-- CreateIndex
CREATE INDEX "customers_organization_id_created_at_idx" ON "customers"("organization_id", "created_at");

-- CreateIndex
CREATE INDEX "customers_organization_id_display_name_idx" ON "customers"("organization_id", "display_name");

-- CreateIndex
CREATE UNIQUE INDEX "customers_organization_id_external_id_key" ON "customers"("organization_id", "external_id");

-- CreateIndex
CREATE INDEX "contact_methods_customer_id_idx" ON "contact_methods"("customer_id");

-- CreateIndex
CREATE UNIQUE INDEX "contact_methods_organization_id_kind_normalized_key" ON "contact_methods"("organization_id", "kind", "normalized");

-- CreateIndex
CREATE INDEX "customer_notes_customer_id_created_at_idx" ON "customer_notes"("customer_id", "created_at");

-- CreateIndex
CREATE INDEX "customer_activities_customer_id_occurred_at_idx" ON "customer_activities"("customer_id", "occurred_at");

-- CreateIndex
CREATE INDEX "customer_activities_organization_id_occurred_at_idx" ON "customer_activities"("organization_id", "occurred_at");

-- CreateIndex
CREATE UNIQUE INDEX "customer_ai_contexts_customer_id_key" ON "customer_ai_contexts"("customer_id");

-- CreateIndex
CREATE INDEX "customer_ai_contexts_organization_id_idx" ON "customer_ai_contexts"("organization_id");

-- CreateIndex
CREATE UNIQUE INDEX "segments_organization_id_name_key" ON "segments"("organization_id", "name");

-- CreateIndex
CREATE INDEX "channel_accounts_organization_id_channel_idx" ON "channel_accounts"("organization_id", "channel");

-- CreateIndex
CREATE INDEX "conversations_organization_id_status_created_at_idx" ON "conversations"("organization_id", "status", "created_at");

-- CreateIndex
CREATE INDEX "conversations_organization_id_queue_id_status_idx" ON "conversations"("organization_id", "queue_id", "status");

-- CreateIndex
CREATE INDEX "conversations_organization_id_assignee_id_status_idx" ON "conversations"("organization_id", "assignee_id", "status");

-- CreateIndex
CREATE INDEX "conversations_organization_id_customer_id_idx" ON "conversations"("organization_id", "customer_id");

-- CreateIndex
CREATE INDEX "conversations_organization_id_thread_key_idx" ON "conversations"("organization_id", "thread_key");

-- CreateIndex
CREATE UNIQUE INDEX "conversations_organization_id_reference_key" ON "conversations"("organization_id", "reference");

-- CreateIndex
CREATE INDEX "messages_conversation_id_created_at_idx" ON "messages"("conversation_id", "created_at");

-- CreateIndex
CREATE INDEX "messages_organization_id_created_at_idx" ON "messages"("organization_id", "created_at");

-- CreateIndex
CREATE INDEX "attachments_organization_id_idx" ON "attachments"("organization_id");

-- CreateIndex
CREATE INDEX "attachments_message_id_idx" ON "attachments"("message_id");

-- CreateIndex
CREATE INDEX "participants_organization_id_idx" ON "participants"("organization_id");

-- CreateIndex
CREATE UNIQUE INDEX "participants_conversation_id_actor_type_actor_id_key" ON "participants"("conversation_id", "actor_type", "actor_id");

-- CreateIndex
CREATE INDEX "conversation_events_conversation_id_created_at_idx" ON "conversation_events"("conversation_id", "created_at");

-- CreateIndex
CREATE INDEX "tickets_organization_id_status_created_at_idx" ON "tickets"("organization_id", "status", "created_at");

-- CreateIndex
CREATE INDEX "tickets_organization_id_assignee_id_status_idx" ON "tickets"("organization_id", "assignee_id", "status");

-- CreateIndex
CREATE INDEX "tickets_organization_id_customer_id_idx" ON "tickets"("organization_id", "customer_id");

-- CreateIndex
CREATE UNIQUE INDEX "tickets_organization_id_number_key" ON "tickets"("organization_id", "number");

-- CreateIndex
CREATE UNIQUE INDEX "tickets_organization_id_reference_key" ON "tickets"("organization_id", "reference");

-- CreateIndex
CREATE INDEX "ticket_comments_ticket_id_created_at_idx" ON "ticket_comments"("ticket_id", "created_at");

-- CreateIndex
CREATE INDEX "ticket_history_ticket_id_created_at_idx" ON "ticket_history"("ticket_id", "created_at");

-- CreateIndex
CREATE UNIQUE INDEX "ticket_templates_organization_id_name_key" ON "ticket_templates"("organization_id", "name");

-- CreateIndex
CREATE INDEX "sla_policies_organization_id_idx" ON "sla_policies"("organization_id");

-- CreateIndex
CREATE UNIQUE INDEX "sla_policies_organization_id_name_key" ON "sla_policies"("organization_id", "name");

-- CreateIndex
CREATE INDEX "sla_targets_organization_id_idx" ON "sla_targets"("organization_id");

-- CreateIndex
CREATE UNIQUE INDEX "sla_targets_policy_id_type_priority_key" ON "sla_targets"("policy_id", "type", "priority");

-- CreateIndex
CREATE INDEX "sla_clocks_organization_id_state_due_at_idx" ON "sla_clocks"("organization_id", "state", "due_at");

-- CreateIndex
CREATE INDEX "sla_clocks_conversation_id_idx" ON "sla_clocks"("conversation_id");

-- CreateIndex
CREATE INDEX "sla_clocks_ticket_id_idx" ON "sla_clocks"("ticket_id");

-- CreateIndex
CREATE INDEX "routing_rules_organization_id_position_idx" ON "routing_rules"("organization_id", "position");

-- CreateIndex
CREATE UNIQUE INDEX "round_robin_cursors_queue_id_key" ON "round_robin_cursors"("queue_id");

-- CreateIndex
CREATE INDEX "knowledge_bases_organization_id_idx" ON "knowledge_bases"("organization_id");

-- CreateIndex
CREATE UNIQUE INDEX "knowledge_bases_organization_id_key_key" ON "knowledge_bases"("organization_id", "key");

-- CreateIndex
CREATE INDEX "knowledge_categories_organization_id_idx" ON "knowledge_categories"("organization_id");

-- CreateIndex
CREATE UNIQUE INDEX "knowledge_categories_knowledge_base_id_slug_key" ON "knowledge_categories"("knowledge_base_id", "slug");

-- CreateIndex
CREATE INDEX "articles_organization_id_state_idx" ON "articles"("organization_id", "state");

-- CreateIndex
CREATE UNIQUE INDEX "articles_knowledge_base_id_slug_key" ON "articles"("knowledge_base_id", "slug");

-- CreateIndex
CREATE UNIQUE INDEX "article_versions_article_id_version_key" ON "article_versions"("article_id", "version");

-- CreateIndex
CREATE INDEX "knowledge_sources_organization_id_idx" ON "knowledge_sources"("organization_id");

-- CreateIndex
CREATE UNIQUE INDEX "documents_article_id_key" ON "documents"("article_id");

-- CreateIndex
CREATE INDEX "documents_organization_id_status_idx" ON "documents"("organization_id", "status");

-- CreateIndex
CREATE INDEX "documents_knowledge_base_id_idx" ON "documents"("knowledge_base_id");

-- CreateIndex
CREATE INDEX "chunks_organization_id_knowledge_base_id_idx" ON "chunks"("organization_id", "knowledge_base_id");

-- CreateIndex
CREATE UNIQUE INDEX "chunks_document_id_position_key" ON "chunks"("document_id", "position");

-- CreateIndex
CREATE INDEX "retrieval_logs_organization_id_created_at_idx" ON "retrieval_logs"("organization_id", "created_at");

-- CreateIndex
CREATE INDEX "model_routes_organization_id_idx" ON "model_routes"("organization_id");

-- CreateIndex
CREATE UNIQUE INDEX "model_routes_organization_id_role_key" ON "model_routes"("organization_id", "role");

-- CreateIndex
CREATE INDEX "ai_usage_organization_id_created_at_idx" ON "ai_usage"("organization_id", "created_at");

-- CreateIndex
CREATE INDEX "ai_usage_organization_id_model_idx" ON "ai_usage"("organization_id", "model");

-- CreateIndex
CREATE UNIQUE INDEX "governance_policies_organization_id_key" ON "governance_policies"("organization_id");

-- CreateIndex
CREATE INDEX "agents_organization_id_idx" ON "agents"("organization_id");

-- CreateIndex
CREATE UNIQUE INDEX "agents_organization_id_key_key" ON "agents"("organization_id", "key");

-- CreateIndex
CREATE INDEX "agent_versions_organization_id_idx" ON "agent_versions"("organization_id");

-- CreateIndex
CREATE UNIQUE INDEX "agent_versions_agent_id_version_key" ON "agent_versions"("agent_id", "version");

-- CreateIndex
CREATE INDEX "workflows_organization_id_idx" ON "workflows"("organization_id");

-- CreateIndex
CREATE UNIQUE INDEX "workflows_organization_id_key_key" ON "workflows"("organization_id", "key");

-- CreateIndex
CREATE INDEX "workflow_versions_organization_id_idx" ON "workflow_versions"("organization_id");

-- CreateIndex
CREATE UNIQUE INDEX "workflow_versions_workflow_id_version_key" ON "workflow_versions"("workflow_id", "version");

-- CreateIndex
CREATE UNIQUE INDEX "executions_resume_token_key" ON "executions"("resume_token");

-- CreateIndex
CREATE INDEX "executions_organization_id_status_created_at_idx" ON "executions"("organization_id", "status", "created_at");

-- CreateIndex
CREATE INDEX "executions_conversation_id_idx" ON "executions"("conversation_id");

-- CreateIndex
CREATE INDEX "executions_resume_after_idx" ON "executions"("resume_after");

-- CreateIndex
CREATE UNIQUE INDEX "executions_organization_id_idempotency_key_key" ON "executions"("organization_id", "idempotency_key");

-- CreateIndex
CREATE INDEX "execution_steps_organization_id_idx" ON "execution_steps"("organization_id");

-- CreateIndex
CREATE UNIQUE INDEX "execution_steps_execution_id_sequence_key" ON "execution_steps"("execution_id", "sequence");

-- CreateIndex
CREATE INDEX "tool_definitions_organization_id_idx" ON "tool_definitions"("organization_id");

-- CreateIndex
CREATE UNIQUE INDEX "tool_definitions_organization_id_key_key" ON "tool_definitions"("organization_id", "key");

-- CreateIndex
CREATE INDEX "tool_invocations_organization_id_created_at_idx" ON "tool_invocations"("organization_id", "created_at");

-- CreateIndex
CREATE INDEX "tool_invocations_execution_id_idx" ON "tool_invocations"("execution_id");

-- CreateIndex
CREATE INDEX "memory_entries_organization_id_scope_idx" ON "memory_entries"("organization_id", "scope");

-- CreateIndex
CREATE INDEX "memory_entries_customer_id_idx" ON "memory_entries"("customer_id");

-- CreateIndex
CREATE INDEX "memory_entries_conversation_id_idx" ON "memory_entries"("conversation_id");

-- CreateIndex
CREATE INDEX "memory_entries_expires_at_idx" ON "memory_entries"("expires_at");

-- CreateIndex
CREATE UNIQUE INDEX "memory_entries_organization_id_scope_customer_id_conversati_key" ON "memory_entries"("organization_id", "scope", "customer_id", "conversation_id", "agent_id", "key");

-- CreateIndex
CREATE UNIQUE INDEX "guardrail_policies_organization_id_name_key" ON "guardrail_policies"("organization_id", "name");

-- CreateIndex
CREATE INDEX "guardrail_events_organization_id_created_at_idx" ON "guardrail_events"("organization_id", "created_at");

-- CreateIndex
CREATE INDEX "automation_rules_organization_id_trigger_is_active_idx" ON "automation_rules"("organization_id", "trigger", "is_active");

-- CreateIndex
CREATE INDEX "automation_runs_organization_id_created_at_idx" ON "automation_runs"("organization_id", "created_at");

-- CreateIndex
CREATE INDEX "automation_runs_rule_id_created_at_idx" ON "automation_runs"("rule_id", "created_at");

-- CreateIndex
CREATE UNIQUE INDEX "qc_templates_organization_id_name_key" ON "qc_templates"("organization_id", "name");

-- CreateIndex
CREATE INDEX "qc_criteria_template_id_idx" ON "qc_criteria"("template_id");

-- CreateIndex
CREATE INDEX "qc_evaluations_organization_id_created_at_idx" ON "qc_evaluations"("organization_id", "created_at");

-- CreateIndex
CREATE INDEX "qc_evaluations_organization_id_subject_id_idx" ON "qc_evaluations"("organization_id", "subject_id");

-- CreateIndex
CREATE UNIQUE INDEX "qc_criterion_scores_evaluation_id_criterion_id_key" ON "qc_criterion_scores"("evaluation_id", "criterion_id");

-- CreateIndex
CREATE INDEX "qc_disputes_organization_id_status_idx" ON "qc_disputes"("organization_id", "status");

-- CreateIndex
CREATE INDEX "realtime_signals_organization_id_created_at_idx" ON "realtime_signals"("organization_id", "created_at");

-- CreateIndex
CREATE INDEX "realtime_signals_conversation_id_idx" ON "realtime_signals"("conversation_id");

-- CreateIndex
CREATE UNIQUE INDEX "conversation_intelligence_conversation_id_key" ON "conversation_intelligence"("conversation_id");

-- CreateIndex
CREATE INDEX "conversation_intelligence_organization_id_created_at_idx" ON "conversation_intelligence"("organization_id", "created_at");

-- CreateIndex
CREATE UNIQUE INDEX "evaluation_datasets_organization_id_name_key" ON "evaluation_datasets"("organization_id", "name");

-- CreateIndex
CREATE INDEX "evaluation_cases_dataset_id_idx" ON "evaluation_cases"("dataset_id");

-- CreateIndex
CREATE INDEX "evaluation_runs_organization_id_started_at_idx" ON "evaluation_runs"("organization_id", "started_at");

-- CreateIndex
CREATE INDEX "evaluation_results_organization_id_idx" ON "evaluation_results"("organization_id");

-- CreateIndex
CREATE UNIQUE INDEX "evaluation_results_run_id_case_id_key" ON "evaluation_results"("run_id", "case_id");

-- CreateIndex
CREATE INDEX "metrics_daily_organization_id_metric_date_idx" ON "metrics_daily"("organization_id", "metric", "date");

-- CreateIndex
CREATE UNIQUE INDEX "metrics_daily_organization_id_date_metric_dimension_dimensi_key" ON "metrics_daily"("organization_id", "date", "metric", "dimension", "dimension_value");

-- CreateIndex
CREATE UNIQUE INDEX "saved_reports_organization_id_name_key" ON "saved_reports"("organization_id", "name");

-- CreateIndex
CREATE INDEX "notification_rules_organization_id_event_idx" ON "notification_rules"("organization_id", "event");

-- CreateIndex
CREATE INDEX "notifications_organization_id_user_id_read_at_idx" ON "notifications"("organization_id", "user_id", "read_at");

-- CreateIndex
CREATE INDEX "notifications_organization_id_created_at_idx" ON "notifications"("organization_id", "created_at");

-- CreateIndex
CREATE INDEX "usage_records_organization_id_period_start_idx" ON "usage_records"("organization_id", "period_start");

-- CreateIndex
CREATE UNIQUE INDEX "usage_records_organization_id_metric_period_start_key" ON "usage_records"("organization_id", "metric", "period_start");

-- CreateIndex
CREATE INDEX "integrations_organization_id_idx" ON "integrations"("organization_id");

-- CreateIndex
CREATE INDEX "webhook_endpoints_organization_id_idx" ON "webhook_endpoints"("organization_id");

-- CreateIndex
CREATE INDEX "webhook_deliveries_organization_id_created_at_idx" ON "webhook_deliveries"("organization_id", "created_at");

-- CreateIndex
CREATE INDEX "webhook_deliveries_next_attempt_at_idx" ON "webhook_deliveries"("next_attempt_at");

-- CreateIndex
CREATE INDEX "outbox_events_status_occurred_at_idx" ON "outbox_events"("status", "occurred_at");

-- CreateIndex
CREATE INDEX "outbox_events_organization_id_type_occurred_at_idx" ON "outbox_events"("organization_id", "type", "occurred_at");

-- CreateIndex
CREATE INDEX "idempotency_keys_expires_at_idx" ON "idempotency_keys"("expires_at");

-- CreateIndex
CREATE UNIQUE INDEX "idempotency_keys_organization_id_key_endpoint_key" ON "idempotency_keys"("organization_id", "key", "endpoint");

-- CreateIndex
CREATE INDEX "api_request_logs_organization_id_created_at_idx" ON "api_request_logs"("organization_id", "created_at");

-- CreateIndex
CREATE INDEX "api_request_logs_request_id_idx" ON "api_request_logs"("request_id");

-- AddForeignKey
ALTER TABLE "workspaces" ADD CONSTRAINT "workspaces_organization_id_fkey" FOREIGN KEY ("organization_id") REFERENCES "organizations"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "subscriptions" ADD CONSTRAINT "subscriptions_organization_id_fkey" FOREIGN KEY ("organization_id") REFERENCES "organizations"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "memberships" ADD CONSTRAINT "memberships_organization_id_fkey" FOREIGN KEY ("organization_id") REFERENCES "organizations"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "memberships" ADD CONSTRAINT "memberships_user_id_fkey" FOREIGN KEY ("user_id") REFERENCES "users"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "memberships" ADD CONSTRAINT "memberships_role_id_fkey" FOREIGN KEY ("role_id") REFERENCES "roles"("id") ON DELETE RESTRICT ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "roles" ADD CONSTRAINT "roles_organization_id_fkey" FOREIGN KEY ("organization_id") REFERENCES "organizations"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "sessions" ADD CONSTRAINT "sessions_user_id_fkey" FOREIGN KEY ("user_id") REFERENCES "users"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "api_keys" ADD CONSTRAINT "api_keys_organization_id_fkey" FOREIGN KEY ("organization_id") REFERENCES "organizations"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "audit_events" ADD CONSTRAINT "audit_events_organization_id_fkey" FOREIGN KEY ("organization_id") REFERENCES "organizations"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "teams" ADD CONSTRAINT "teams_organization_id_fkey" FOREIGN KEY ("organization_id") REFERENCES "organizations"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "teams" ADD CONSTRAINT "teams_business_hours_id_fkey" FOREIGN KEY ("business_hours_id") REFERENCES "business_hours"("id") ON DELETE SET NULL ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "team_members" ADD CONSTRAINT "team_members_team_id_fkey" FOREIGN KEY ("team_id") REFERENCES "teams"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "team_members" ADD CONSTRAINT "team_members_user_id_fkey" FOREIGN KEY ("user_id") REFERENCES "users"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "queues" ADD CONSTRAINT "queues_organization_id_fkey" FOREIGN KEY ("organization_id") REFERENCES "organizations"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "queues" ADD CONSTRAINT "queues_team_id_fkey" FOREIGN KEY ("team_id") REFERENCES "teams"("id") ON DELETE SET NULL ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "queues" ADD CONSTRAINT "queues_sla_policy_id_fkey" FOREIGN KEY ("sla_policy_id") REFERENCES "sla_policies"("id") ON DELETE SET NULL ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "queues" ADD CONSTRAINT "queues_business_hours_id_fkey" FOREIGN KEY ("business_hours_id") REFERENCES "business_hours"("id") ON DELETE SET NULL ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "business_hours" ADD CONSTRAINT "business_hours_organization_id_fkey" FOREIGN KEY ("organization_id") REFERENCES "organizations"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "holidays" ADD CONSTRAINT "holidays_organization_id_fkey" FOREIGN KEY ("organization_id") REFERENCES "organizations"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "holidays" ADD CONSTRAINT "holidays_business_hours_id_fkey" FOREIGN KEY ("business_hours_id") REFERENCES "business_hours"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "custom_fields" ADD CONSTRAINT "custom_fields_organization_id_fkey" FOREIGN KEY ("organization_id") REFERENCES "organizations"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "tags" ADD CONSTRAINT "tags_organization_id_fkey" FOREIGN KEY ("organization_id") REFERENCES "organizations"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "saved_replies" ADD CONSTRAINT "saved_replies_organization_id_fkey" FOREIGN KEY ("organization_id") REFERENCES "organizations"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "customers" ADD CONSTRAINT "customers_organization_id_fkey" FOREIGN KEY ("organization_id") REFERENCES "organizations"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "contact_methods" ADD CONSTRAINT "contact_methods_customer_id_fkey" FOREIGN KEY ("customer_id") REFERENCES "customers"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "customer_notes" ADD CONSTRAINT "customer_notes_customer_id_fkey" FOREIGN KEY ("customer_id") REFERENCES "customers"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "customer_activities" ADD CONSTRAINT "customer_activities_customer_id_fkey" FOREIGN KEY ("customer_id") REFERENCES "customers"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "customer_ai_contexts" ADD CONSTRAINT "customer_ai_contexts_customer_id_fkey" FOREIGN KEY ("customer_id") REFERENCES "customers"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "segments" ADD CONSTRAINT "segments_organization_id_fkey" FOREIGN KEY ("organization_id") REFERENCES "organizations"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "channel_accounts" ADD CONSTRAINT "channel_accounts_organization_id_fkey" FOREIGN KEY ("organization_id") REFERENCES "organizations"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "conversations" ADD CONSTRAINT "conversations_organization_id_fkey" FOREIGN KEY ("organization_id") REFERENCES "organizations"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "conversations" ADD CONSTRAINT "conversations_customer_id_fkey" FOREIGN KEY ("customer_id") REFERENCES "customers"("id") ON DELETE SET NULL ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "conversations" ADD CONSTRAINT "conversations_queue_id_fkey" FOREIGN KEY ("queue_id") REFERENCES "queues"("id") ON DELETE SET NULL ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "messages" ADD CONSTRAINT "messages_organization_id_fkey" FOREIGN KEY ("organization_id") REFERENCES "organizations"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "messages" ADD CONSTRAINT "messages_conversation_id_fkey" FOREIGN KEY ("conversation_id") REFERENCES "conversations"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "attachments" ADD CONSTRAINT "attachments_message_id_fkey" FOREIGN KEY ("message_id") REFERENCES "messages"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "attachments" ADD CONSTRAINT "attachments_ticket_id_fkey" FOREIGN KEY ("ticket_id") REFERENCES "tickets"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "participants" ADD CONSTRAINT "participants_conversation_id_fkey" FOREIGN KEY ("conversation_id") REFERENCES "conversations"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "conversation_events" ADD CONSTRAINT "conversation_events_conversation_id_fkey" FOREIGN KEY ("conversation_id") REFERENCES "conversations"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "tickets" ADD CONSTRAINT "tickets_organization_id_fkey" FOREIGN KEY ("organization_id") REFERENCES "organizations"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "tickets" ADD CONSTRAINT "tickets_customer_id_fkey" FOREIGN KEY ("customer_id") REFERENCES "customers"("id") ON DELETE SET NULL ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "tickets" ADD CONSTRAINT "tickets_conversation_id_fkey" FOREIGN KEY ("conversation_id") REFERENCES "conversations"("id") ON DELETE SET NULL ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "ticket_comments" ADD CONSTRAINT "ticket_comments_ticket_id_fkey" FOREIGN KEY ("ticket_id") REFERENCES "tickets"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "ticket_history" ADD CONSTRAINT "ticket_history_ticket_id_fkey" FOREIGN KEY ("ticket_id") REFERENCES "tickets"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "ticket_templates" ADD CONSTRAINT "ticket_templates_organization_id_fkey" FOREIGN KEY ("organization_id") REFERENCES "organizations"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "sla_policies" ADD CONSTRAINT "sla_policies_organization_id_fkey" FOREIGN KEY ("organization_id") REFERENCES "organizations"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "sla_policies" ADD CONSTRAINT "sla_policies_business_hours_id_fkey" FOREIGN KEY ("business_hours_id") REFERENCES "business_hours"("id") ON DELETE SET NULL ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "sla_targets" ADD CONSTRAINT "sla_targets_policy_id_fkey" FOREIGN KEY ("policy_id") REFERENCES "sla_policies"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "sla_clocks" ADD CONSTRAINT "sla_clocks_policy_id_fkey" FOREIGN KEY ("policy_id") REFERENCES "sla_policies"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "sla_clocks" ADD CONSTRAINT "sla_clocks_conversation_id_fkey" FOREIGN KEY ("conversation_id") REFERENCES "conversations"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "sla_clocks" ADD CONSTRAINT "sla_clocks_ticket_id_fkey" FOREIGN KEY ("ticket_id") REFERENCES "tickets"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "routing_rules" ADD CONSTRAINT "routing_rules_organization_id_fkey" FOREIGN KEY ("organization_id") REFERENCES "organizations"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "knowledge_bases" ADD CONSTRAINT "knowledge_bases_organization_id_fkey" FOREIGN KEY ("organization_id") REFERENCES "organizations"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "knowledge_categories" ADD CONSTRAINT "knowledge_categories_knowledge_base_id_fkey" FOREIGN KEY ("knowledge_base_id") REFERENCES "knowledge_bases"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "articles" ADD CONSTRAINT "articles_knowledge_base_id_fkey" FOREIGN KEY ("knowledge_base_id") REFERENCES "knowledge_bases"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "articles" ADD CONSTRAINT "articles_category_id_fkey" FOREIGN KEY ("category_id") REFERENCES "knowledge_categories"("id") ON DELETE SET NULL ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "article_versions" ADD CONSTRAINT "article_versions_article_id_fkey" FOREIGN KEY ("article_id") REFERENCES "articles"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "knowledge_sources" ADD CONSTRAINT "knowledge_sources_knowledge_base_id_fkey" FOREIGN KEY ("knowledge_base_id") REFERENCES "knowledge_bases"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "documents" ADD CONSTRAINT "documents_knowledge_base_id_fkey" FOREIGN KEY ("knowledge_base_id") REFERENCES "knowledge_bases"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "documents" ADD CONSTRAINT "documents_source_id_fkey" FOREIGN KEY ("source_id") REFERENCES "knowledge_sources"("id") ON DELETE SET NULL ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "documents" ADD CONSTRAINT "documents_article_id_fkey" FOREIGN KEY ("article_id") REFERENCES "articles"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "chunks" ADD CONSTRAINT "chunks_document_id_fkey" FOREIGN KEY ("document_id") REFERENCES "documents"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "ai_usage" ADD CONSTRAINT "ai_usage_organization_id_fkey" FOREIGN KEY ("organization_id") REFERENCES "organizations"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "governance_policies" ADD CONSTRAINT "governance_policies_organization_id_fkey" FOREIGN KEY ("organization_id") REFERENCES "organizations"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "agents" ADD CONSTRAINT "agents_organization_id_fkey" FOREIGN KEY ("organization_id") REFERENCES "organizations"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "agent_versions" ADD CONSTRAINT "agent_versions_agent_id_fkey" FOREIGN KEY ("agent_id") REFERENCES "agents"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "workflows" ADD CONSTRAINT "workflows_organization_id_fkey" FOREIGN KEY ("organization_id") REFERENCES "organizations"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "workflow_versions" ADD CONSTRAINT "workflow_versions_workflow_id_fkey" FOREIGN KEY ("workflow_id") REFERENCES "workflows"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "executions" ADD CONSTRAINT "executions_organization_id_fkey" FOREIGN KEY ("organization_id") REFERENCES "organizations"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "executions" ADD CONSTRAINT "executions_workflow_id_fkey" FOREIGN KEY ("workflow_id") REFERENCES "workflows"("id") ON DELETE SET NULL ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "executions" ADD CONSTRAINT "executions_workflow_version_id_fkey" FOREIGN KEY ("workflow_version_id") REFERENCES "workflow_versions"("id") ON DELETE SET NULL ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "executions" ADD CONSTRAINT "executions_agent_id_fkey" FOREIGN KEY ("agent_id") REFERENCES "agents"("id") ON DELETE SET NULL ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "executions" ADD CONSTRAINT "executions_conversation_id_fkey" FOREIGN KEY ("conversation_id") REFERENCES "conversations"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "execution_steps" ADD CONSTRAINT "execution_steps_execution_id_fkey" FOREIGN KEY ("execution_id") REFERENCES "executions"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "tool_definitions" ADD CONSTRAINT "tool_definitions_organization_id_fkey" FOREIGN KEY ("organization_id") REFERENCES "organizations"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "tool_invocations" ADD CONSTRAINT "tool_invocations_tool_id_fkey" FOREIGN KEY ("tool_id") REFERENCES "tool_definitions"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "memory_entries" ADD CONSTRAINT "memory_entries_organization_id_fkey" FOREIGN KEY ("organization_id") REFERENCES "organizations"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "guardrail_policies" ADD CONSTRAINT "guardrail_policies_organization_id_fkey" FOREIGN KEY ("organization_id") REFERENCES "organizations"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "guardrail_events" ADD CONSTRAINT "guardrail_events_policy_id_fkey" FOREIGN KEY ("policy_id") REFERENCES "guardrail_policies"("id") ON DELETE SET NULL ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "automation_rules" ADD CONSTRAINT "automation_rules_organization_id_fkey" FOREIGN KEY ("organization_id") REFERENCES "organizations"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "automation_runs" ADD CONSTRAINT "automation_runs_rule_id_fkey" FOREIGN KEY ("rule_id") REFERENCES "automation_rules"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "qc_templates" ADD CONSTRAINT "qc_templates_organization_id_fkey" FOREIGN KEY ("organization_id") REFERENCES "organizations"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "qc_criteria" ADD CONSTRAINT "qc_criteria_template_id_fkey" FOREIGN KEY ("template_id") REFERENCES "qc_templates"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "qc_evaluations" ADD CONSTRAINT "qc_evaluations_organization_id_fkey" FOREIGN KEY ("organization_id") REFERENCES "organizations"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "qc_evaluations" ADD CONSTRAINT "qc_evaluations_template_id_fkey" FOREIGN KEY ("template_id") REFERENCES "qc_templates"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "qc_evaluations" ADD CONSTRAINT "qc_evaluations_conversation_id_fkey" FOREIGN KEY ("conversation_id") REFERENCES "conversations"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "qc_criterion_scores" ADD CONSTRAINT "qc_criterion_scores_evaluation_id_fkey" FOREIGN KEY ("evaluation_id") REFERENCES "qc_evaluations"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "qc_criterion_scores" ADD CONSTRAINT "qc_criterion_scores_criterion_id_fkey" FOREIGN KEY ("criterion_id") REFERENCES "qc_criteria"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "qc_disputes" ADD CONSTRAINT "qc_disputes_evaluation_id_fkey" FOREIGN KEY ("evaluation_id") REFERENCES "qc_evaluations"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "realtime_signals" ADD CONSTRAINT "realtime_signals_conversation_id_fkey" FOREIGN KEY ("conversation_id") REFERENCES "conversations"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "conversation_intelligence" ADD CONSTRAINT "conversation_intelligence_conversation_id_fkey" FOREIGN KEY ("conversation_id") REFERENCES "conversations"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "evaluation_datasets" ADD CONSTRAINT "evaluation_datasets_organization_id_fkey" FOREIGN KEY ("organization_id") REFERENCES "organizations"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "evaluation_cases" ADD CONSTRAINT "evaluation_cases_dataset_id_fkey" FOREIGN KEY ("dataset_id") REFERENCES "evaluation_datasets"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "evaluation_runs" ADD CONSTRAINT "evaluation_runs_dataset_id_fkey" FOREIGN KEY ("dataset_id") REFERENCES "evaluation_datasets"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "evaluation_results" ADD CONSTRAINT "evaluation_results_run_id_fkey" FOREIGN KEY ("run_id") REFERENCES "evaluation_runs"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "evaluation_results" ADD CONSTRAINT "evaluation_results_case_id_fkey" FOREIGN KEY ("case_id") REFERENCES "evaluation_cases"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "saved_reports" ADD CONSTRAINT "saved_reports_organization_id_fkey" FOREIGN KEY ("organization_id") REFERENCES "organizations"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "notification_rules" ADD CONSTRAINT "notification_rules_organization_id_fkey" FOREIGN KEY ("organization_id") REFERENCES "organizations"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "notifications" ADD CONSTRAINT "notifications_organization_id_fkey" FOREIGN KEY ("organization_id") REFERENCES "organizations"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "usage_records" ADD CONSTRAINT "usage_records_organization_id_fkey" FOREIGN KEY ("organization_id") REFERENCES "organizations"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "integrations" ADD CONSTRAINT "integrations_organization_id_fkey" FOREIGN KEY ("organization_id") REFERENCES "organizations"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "webhook_endpoints" ADD CONSTRAINT "webhook_endpoints_organization_id_fkey" FOREIGN KEY ("organization_id") REFERENCES "organizations"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "webhook_deliveries" ADD CONSTRAINT "webhook_deliveries_endpoint_id_fkey" FOREIGN KEY ("endpoint_id") REFERENCES "webhook_endpoints"("id") ON DELETE CASCADE ON UPDATE CASCADE;
