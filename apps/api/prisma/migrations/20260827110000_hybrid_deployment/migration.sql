
-- CreateEnum
CREATE TYPE "DataPlaneStatus" AS ENUM ('pending', 'healthy', 'degraded', 'unreachable', 'suspended');


-- CreateTable
CREATE TABLE "data_planes" (
    "id" TEXT NOT NULL,
    "name" TEXT NOT NULL,
    "region" TEXT NOT NULL,
    "enrollment_token_hash" TEXT NOT NULL,
    "enrolled_at" TIMESTAMP(3),
    "status" "DataPlaneStatus" NOT NULL DEFAULT 'pending',
    "version" TEXT,
    "contract_version" TEXT,
    "organization_ids" TEXT[] DEFAULT ARRAY[]::TEXT[],
    "config" JSONB NOT NULL DEFAULT '{}',
    "config_version" INTEGER NOT NULL DEFAULT 1,
    "last_heartbeat_at" TIMESTAMP(3),
    "last_error" TEXT,
    "created_at" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updated_at" TIMESTAMP(3) NOT NULL,

    CONSTRAINT "data_planes_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "data_plane_heartbeats" (
    "id" TEXT NOT NULL,
    "data_plane_id" TEXT NOT NULL,
    "version" TEXT,
    "status" TEXT NOT NULL,
    "metrics" JSONB NOT NULL DEFAULT '{}',
    "uptime_seconds" INTEGER,
    "reported_at" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,

    CONSTRAINT "data_plane_heartbeats_pkey" PRIMARY KEY ("id")
);

-- CreateIndex
CREATE UNIQUE INDEX "data_planes_enrollment_token_hash_key" ON "data_planes"("enrollment_token_hash");

-- CreateIndex
CREATE INDEX "data_plane_heartbeats_data_plane_id_reported_at_idx" ON "data_plane_heartbeats"("data_plane_id", "reported_at");

-- AddForeignKey
ALTER TABLE "data_plane_heartbeats" ADD CONSTRAINT "data_plane_heartbeats_data_plane_id_fkey" FOREIGN KEY ("data_plane_id") REFERENCES "data_planes"("id") ON DELETE CASCADE ON UPDATE CASCADE;

