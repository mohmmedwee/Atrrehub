-- CreateEnum
CREATE TYPE "BackupStatus" AS ENUM ('running', 'completed', 'failed', 'verified', 'unrestorable');

-- CreateTable
CREATE TABLE "backup_records" (
    "id" TEXT NOT NULL,
    "kind" TEXT NOT NULL DEFAULT 'full',
    "organization_id" TEXT,
    "storage_key" TEXT NOT NULL,
    "size_bytes" BIGINT NOT NULL DEFAULT 0,
    "checksum" TEXT,
    "status" "BackupStatus" NOT NULL DEFAULT 'running',
    "migration_name" TEXT,
    "started_at" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "finished_at" TIMESTAMP(3),
    "duration_ms" INTEGER,
    "verified_at" TIMESTAMP(3),
    "verification" JSONB,
    "error" TEXT,
    "expires_at" TIMESTAMP(3),

    CONSTRAINT "backup_records_pkey" PRIMARY KEY ("id")
);

-- CreateIndex
CREATE INDEX "backup_records_status_started_at_idx" ON "backup_records"("status", "started_at");

-- CreateIndex
CREATE INDEX "backup_records_organization_id_idx" ON "backup_records"("organization_id");
