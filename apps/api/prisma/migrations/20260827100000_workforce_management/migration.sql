
-- CreateEnum
CREATE TYPE "ShiftState" AS ENUM ('draft', 'published', 'cancelled');

-- CreateEnum
CREATE TYPE "TimeOffStatus" AS ENUM ('requested', 'approved', 'declined', 'cancelled');



-- CreateTable
CREATE TABLE "forecasts" (
    "id" TEXT NOT NULL,
    "organization_id" TEXT NOT NULL,
    "workspace_id" TEXT,
    "name" TEXT NOT NULL,
    "queue_id" TEXT,
    "channel" "ChannelType",
    "starts_at" TIMESTAMP(3) NOT NULL,
    "ends_at" TIMESTAMP(3) NOT NULL,
    "interval_minutes" INTEGER NOT NULL DEFAULT 30,
    "method" TEXT NOT NULL DEFAULT 'seasonal_average',
    "lookback_weeks" INTEGER NOT NULL DEFAULT 6,
    "growth_factor" DOUBLE PRECISION NOT NULL DEFAULT 1,
    "shrinkage" DOUBLE PRECISION NOT NULL DEFAULT 0.3,
    "target_service_level" DOUBLE PRECISION NOT NULL DEFAULT 0.8,
    "target_answer_sec" INTEGER NOT NULL DEFAULT 20,
    "max_occupancy" DOUBLE PRECISION NOT NULL DEFAULT 0.85,
    "accuracy" JSONB,
    "created_by_id" TEXT,
    "generated_at" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "created_at" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updated_at" TIMESTAMP(3) NOT NULL,

    CONSTRAINT "forecasts_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "forecast_intervals" (
    "id" TEXT NOT NULL,
    "organization_id" TEXT NOT NULL,
    "forecast_id" TEXT NOT NULL,
    "starts_at" TIMESTAMP(3) NOT NULL,
    "predicted_volume" INTEGER NOT NULL DEFAULT 0,
    "average_handle_time_sec" INTEGER NOT NULL DEFAULT 300,
    "required_agents" INTEGER NOT NULL DEFAULT 0,
    "rostered_agents" INTEGER NOT NULL DEFAULT 0,
    "service_level" DOUBLE PRECISION NOT NULL DEFAULT 0,
    "occupancy" DOUBLE PRECISION NOT NULL DEFAULT 0,
    "confidence" DOUBLE PRECISION NOT NULL DEFAULT 0,
    "samples" INTEGER NOT NULL DEFAULT 0,
    "actual_volume" INTEGER,

    CONSTRAINT "forecast_intervals_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "shift_templates" (
    "id" TEXT NOT NULL,
    "organization_id" TEXT NOT NULL,
    "name" TEXT NOT NULL,
    "start_minute" INTEGER NOT NULL,
    "duration_minutes" INTEGER NOT NULL,
    "days_of_week" INTEGER[] DEFAULT ARRAY[]::INTEGER[],
    "breaks" JSONB NOT NULL DEFAULT '[]',
    "queue_ids" TEXT[] DEFAULT ARRAY[]::TEXT[],
    "timezone" TEXT NOT NULL DEFAULT 'UTC',
    "is_active" BOOLEAN NOT NULL DEFAULT true,
    "created_at" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updated_at" TIMESTAMP(3) NOT NULL,

    CONSTRAINT "shift_templates_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "shifts" (
    "id" TEXT NOT NULL,
    "organization_id" TEXT NOT NULL,
    "workspace_id" TEXT,
    "user_id" TEXT NOT NULL,
    "template_id" TEXT,
    "starts_at" TIMESTAMP(3) NOT NULL,
    "ends_at" TIMESTAMP(3) NOT NULL,
    "state" "ShiftState" NOT NULL DEFAULT 'draft',
    "breaks" JSONB NOT NULL DEFAULT '[]',
    "queue_ids" TEXT[] DEFAULT ARRAY[]::TEXT[],
    "note" TEXT,
    "published_at" TIMESTAMP(3),
    "created_at" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updated_at" TIMESTAMP(3) NOT NULL,

    CONSTRAINT "shifts_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "time_off_requests" (
    "id" TEXT NOT NULL,
    "organization_id" TEXT NOT NULL,
    "user_id" TEXT NOT NULL,
    "starts_at" TIMESTAMP(3) NOT NULL,
    "ends_at" TIMESTAMP(3) NOT NULL,
    "type" TEXT NOT NULL DEFAULT 'holiday',
    "status" "TimeOffStatus" NOT NULL DEFAULT 'requested',
    "reason" TEXT,
    "decided_by_id" TEXT,
    "decided_at" TIMESTAMP(3),
    "decision_note" TEXT,
    "created_at" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updated_at" TIMESTAMP(3) NOT NULL,

    CONSTRAINT "time_off_requests_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "agent_state_events" (
    "id" TEXT NOT NULL,
    "organization_id" TEXT NOT NULL,
    "user_id" TEXT NOT NULL,
    "state" "AgentPresence" NOT NULL,
    "note" TEXT,
    "source" TEXT NOT NULL DEFAULT 'user',
    "occurred_at" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,

    CONSTRAINT "agent_state_events_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "adherence_records" (
    "id" TEXT NOT NULL,
    "organization_id" TEXT NOT NULL,
    "user_id" TEXT NOT NULL,
    "date" DATE NOT NULL,
    "scheduled_minutes" INTEGER NOT NULL DEFAULT 0,
    "adherent_minutes" INTEGER NOT NULL DEFAULT 0,
    "unscheduled_minutes" INTEGER NOT NULL DEFAULT 0,
    "adherence_percent" DOUBLE PRECISION NOT NULL DEFAULT 0,
    "conformance_percent" DOUBLE PRECISION NOT NULL DEFAULT 0,
    "computed_at" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,

    CONSTRAINT "adherence_records_pkey" PRIMARY KEY ("id")
);

-- CreateIndex
CREATE INDEX "forecasts_organization_id_starts_at_idx" ON "forecasts"("organization_id", "starts_at");

-- CreateIndex
CREATE UNIQUE INDEX "forecasts_organization_id_name_key" ON "forecasts"("organization_id", "name");

-- CreateIndex
CREATE INDEX "forecast_intervals_organization_id_starts_at_idx" ON "forecast_intervals"("organization_id", "starts_at");

-- CreateIndex
CREATE UNIQUE INDEX "forecast_intervals_forecast_id_starts_at_key" ON "forecast_intervals"("forecast_id", "starts_at");

-- CreateIndex
CREATE UNIQUE INDEX "shift_templates_organization_id_name_key" ON "shift_templates"("organization_id", "name");

-- CreateIndex
CREATE INDEX "shifts_organization_id_starts_at_idx" ON "shifts"("organization_id", "starts_at");

-- CreateIndex
CREATE INDEX "shifts_user_id_starts_at_idx" ON "shifts"("user_id", "starts_at");

-- CreateIndex
CREATE INDEX "time_off_requests_organization_id_starts_at_idx" ON "time_off_requests"("organization_id", "starts_at");

-- CreateIndex
CREATE INDEX "time_off_requests_user_id_starts_at_idx" ON "time_off_requests"("user_id", "starts_at");

-- CreateIndex
CREATE INDEX "agent_state_events_organization_id_occurred_at_idx" ON "agent_state_events"("organization_id", "occurred_at");

-- CreateIndex
CREATE INDEX "agent_state_events_user_id_occurred_at_idx" ON "agent_state_events"("user_id", "occurred_at");

-- CreateIndex
CREATE INDEX "adherence_records_organization_id_date_idx" ON "adherence_records"("organization_id", "date");

-- CreateIndex
CREATE UNIQUE INDEX "adherence_records_user_id_date_key" ON "adherence_records"("user_id", "date");

-- AddForeignKey
ALTER TABLE "forecasts" ADD CONSTRAINT "forecasts_organization_id_fkey" FOREIGN KEY ("organization_id") REFERENCES "organizations"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "forecast_intervals" ADD CONSTRAINT "forecast_intervals_forecast_id_fkey" FOREIGN KEY ("forecast_id") REFERENCES "forecasts"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "shift_templates" ADD CONSTRAINT "shift_templates_organization_id_fkey" FOREIGN KEY ("organization_id") REFERENCES "organizations"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "shifts" ADD CONSTRAINT "shifts_organization_id_fkey" FOREIGN KEY ("organization_id") REFERENCES "organizations"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "shifts" ADD CONSTRAINT "shifts_user_id_fkey" FOREIGN KEY ("user_id") REFERENCES "users"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "shifts" ADD CONSTRAINT "shifts_template_id_fkey" FOREIGN KEY ("template_id") REFERENCES "shift_templates"("id") ON DELETE SET NULL ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "time_off_requests" ADD CONSTRAINT "time_off_requests_organization_id_fkey" FOREIGN KEY ("organization_id") REFERENCES "organizations"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "time_off_requests" ADD CONSTRAINT "time_off_requests_user_id_fkey" FOREIGN KEY ("user_id") REFERENCES "users"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "agent_state_events" ADD CONSTRAINT "agent_state_events_user_id_fkey" FOREIGN KEY ("user_id") REFERENCES "users"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "adherence_records" ADD CONSTRAINT "adherence_records_user_id_fkey" FOREIGN KEY ("user_id") REFERENCES "users"("id") ON DELETE CASCADE ON UPDATE CASCADE;

