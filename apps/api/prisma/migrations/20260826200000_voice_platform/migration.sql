
-- CreateEnum
CREATE TYPE "CallDirection" AS ENUM ('inbound', 'outbound');

-- CreateEnum
CREATE TYPE "CallStatus" AS ENUM ('initiating', 'ringing', 'answered', 'queued', 'on_hold', 'transferring', 'completed', 'failed', 'no_answer', 'busy', 'canceled');

-- CreateEnum
CREATE TYPE "CallDisposition" AS ENUM ('handled_by_ai', 'handled_by_agent', 'abandoned_in_queue', 'abandoned_in_ivr', 'voicemail', 'transferred_external', 'failed');

-- CreateEnum
CREATE TYPE "CallParticipantRole" AS ENUM ('caller', 'agent', 'ai_agent', 'ivr', 'external');



-- CreateTable
CREATE TABLE "phone_numbers" (
    "id" TEXT NOT NULL,
    "organization_id" TEXT NOT NULL,
    "workspace_id" TEXT,
    "number" TEXT NOT NULL,
    "label" TEXT,
    "provider" TEXT NOT NULL,
    "external_id" TEXT,
    "capabilities" TEXT[] DEFAULT ARRAY[]::TEXT[],
    "route_type" TEXT NOT NULL DEFAULT 'ivr',
    "route_id" TEXT,
    "after_hours_route_type" TEXT,
    "after_hours_route_id" TEXT,
    "business_hours_id" TEXT,
    "record_calls" BOOLEAN NOT NULL DEFAULT false,
    "channel_account_id" TEXT,
    "is_active" BOOLEAN NOT NULL DEFAULT true,
    "created_at" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updated_at" TIMESTAMP(3) NOT NULL,

    CONSTRAINT "phone_numbers_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "ivr_flows" (
    "id" TEXT NOT NULL,
    "organization_id" TEXT NOT NULL,
    "name" TEXT NOT NULL,
    "description" TEXT,
    "definition" JSONB NOT NULL DEFAULT '{}',
    "locale" TEXT NOT NULL DEFAULT 'en',
    "is_active" BOOLEAN NOT NULL DEFAULT false,
    "version" INTEGER NOT NULL DEFAULT 1,
    "created_at" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updated_at" TIMESTAMP(3) NOT NULL,

    CONSTRAINT "ivr_flows_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "calls" (
    "id" TEXT NOT NULL,
    "organization_id" TEXT NOT NULL,
    "workspace_id" TEXT,
    "conversation_id" TEXT,
    "phone_number_id" TEXT,
    "channel_account_id" TEXT,
    "customer_id" TEXT,
    "provider" TEXT NOT NULL,
    "provider_call_id" TEXT NOT NULL,
    "direction" "CallDirection" NOT NULL,
    "status" "CallStatus" NOT NULL DEFAULT 'initiating',
    "disposition" "CallDisposition",
    "from_number" TEXT NOT NULL,
    "to_number" TEXT NOT NULL,
    "queue_id" TEXT,
    "assignee_id" TEXT,
    "ai_agent_id" TEXT,
    "ivr_path" TEXT[] DEFAULT ARRAY[]::TEXT[],
    "ivr_flow_id" TEXT,
    "digits" TEXT,
    "hangup_cause" TEXT,
    "hangup_by" TEXT,
    "is_recorded" BOOLEAN NOT NULL DEFAULT false,
    "started_at" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "answered_at" TIMESTAMP(3),
    "queued_at" TIMESTAMP(3),
    "connected_at" TIMESTAMP(3),
    "ended_at" TIMESTAMP(3),
    "duration_sec" INTEGER,
    "talk_time_sec" INTEGER,
    "wait_time_sec" INTEGER,
    "cost_usd" DECIMAL(12,6) NOT NULL DEFAULT 0,
    "metadata" JSONB NOT NULL DEFAULT '{}',
    "created_at" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updated_at" TIMESTAMP(3) NOT NULL,

    CONSTRAINT "calls_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "call_participants" (
    "id" TEXT NOT NULL,
    "organization_id" TEXT NOT NULL,
    "call_id" TEXT NOT NULL,
    "role" "CallParticipantRole" NOT NULL,
    "actor_id" TEXT,
    "label" TEXT,
    "joined_at" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "left_at" TIMESTAMP(3),

    CONSTRAINT "call_participants_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "call_events" (
    "id" TEXT NOT NULL,
    "organization_id" TEXT NOT NULL,
    "call_id" TEXT NOT NULL,
    "sequence" INTEGER NOT NULL,
    "type" TEXT NOT NULL,
    "payload" JSONB NOT NULL DEFAULT '{}',
    "created_at" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,

    CONSTRAINT "call_events_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "call_recordings" (
    "id" TEXT NOT NULL,
    "organization_id" TEXT NOT NULL,
    "call_id" TEXT NOT NULL,
    "storage_key" TEXT NOT NULL,
    "content_type" TEXT NOT NULL DEFAULT 'audio/wav',
    "duration_sec" INTEGER NOT NULL DEFAULT 0,
    "size_bytes" INTEGER NOT NULL DEFAULT 0,
    "consent_at" TIMESTAMP(3),
    "expires_at" TIMESTAMP(3),
    "created_at" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,

    CONSTRAINT "call_recordings_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "call_transcript_segments" (
    "id" TEXT NOT NULL,
    "organization_id" TEXT NOT NULL,
    "call_id" TEXT NOT NULL,
    "sequence" INTEGER NOT NULL,
    "speaker" "CallParticipantRole" NOT NULL,
    "text" TEXT NOT NULL,
    "confidence" DOUBLE PRECISION,
    "start_ms" INTEGER NOT NULL DEFAULT 0,
    "end_ms" INTEGER NOT NULL DEFAULT 0,
    "is_final" BOOLEAN NOT NULL DEFAULT true,
    "created_at" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,

    CONSTRAINT "call_transcript_segments_pkey" PRIMARY KEY ("id")
);

-- CreateIndex
CREATE INDEX "phone_numbers_organization_id_idx" ON "phone_numbers"("organization_id");

-- CreateIndex
CREATE UNIQUE INDEX "phone_numbers_organization_id_number_key" ON "phone_numbers"("organization_id", "number");

-- CreateIndex
CREATE UNIQUE INDEX "ivr_flows_organization_id_name_key" ON "ivr_flows"("organization_id", "name");

-- CreateIndex
CREATE UNIQUE INDEX "calls_conversation_id_key" ON "calls"("conversation_id");

-- CreateIndex
CREATE INDEX "calls_organization_id_started_at_idx" ON "calls"("organization_id", "started_at");

-- CreateIndex
CREATE INDEX "calls_organization_id_status_idx" ON "calls"("organization_id", "status");

-- CreateIndex
CREATE INDEX "calls_queue_id_status_idx" ON "calls"("queue_id", "status");

-- CreateIndex
CREATE UNIQUE INDEX "calls_provider_provider_call_id_key" ON "calls"("provider", "provider_call_id");

-- CreateIndex
CREATE INDEX "call_participants_call_id_idx" ON "call_participants"("call_id");

-- CreateIndex
CREATE INDEX "call_events_organization_id_created_at_idx" ON "call_events"("organization_id", "created_at");

-- CreateIndex
CREATE UNIQUE INDEX "call_events_call_id_sequence_key" ON "call_events"("call_id", "sequence");

-- CreateIndex
CREATE INDEX "call_recordings_organization_id_created_at_idx" ON "call_recordings"("organization_id", "created_at");

-- CreateIndex
CREATE INDEX "call_recordings_expires_at_idx" ON "call_recordings"("expires_at");

-- CreateIndex
CREATE INDEX "call_transcript_segments_organization_id_idx" ON "call_transcript_segments"("organization_id");

-- CreateIndex
CREATE UNIQUE INDEX "call_transcript_segments_call_id_sequence_key" ON "call_transcript_segments"("call_id", "sequence");

-- AddForeignKey
ALTER TABLE "phone_numbers" ADD CONSTRAINT "phone_numbers_organization_id_fkey" FOREIGN KEY ("organization_id") REFERENCES "organizations"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "ivr_flows" ADD CONSTRAINT "ivr_flows_organization_id_fkey" FOREIGN KEY ("organization_id") REFERENCES "organizations"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "calls" ADD CONSTRAINT "calls_organization_id_fkey" FOREIGN KEY ("organization_id") REFERENCES "organizations"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "calls" ADD CONSTRAINT "calls_conversation_id_fkey" FOREIGN KEY ("conversation_id") REFERENCES "conversations"("id") ON DELETE SET NULL ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "calls" ADD CONSTRAINT "calls_phone_number_id_fkey" FOREIGN KEY ("phone_number_id") REFERENCES "phone_numbers"("id") ON DELETE SET NULL ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "call_participants" ADD CONSTRAINT "call_participants_call_id_fkey" FOREIGN KEY ("call_id") REFERENCES "calls"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "call_events" ADD CONSTRAINT "call_events_call_id_fkey" FOREIGN KEY ("call_id") REFERENCES "calls"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "call_recordings" ADD CONSTRAINT "call_recordings_call_id_fkey" FOREIGN KEY ("call_id") REFERENCES "calls"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "call_transcript_segments" ADD CONSTRAINT "call_transcript_segments_call_id_fkey" FOREIGN KEY ("call_id") REFERENCES "calls"("id") ON DELETE CASCADE ON UPDATE CASCADE;

