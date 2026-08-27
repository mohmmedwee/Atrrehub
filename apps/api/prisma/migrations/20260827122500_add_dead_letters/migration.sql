-- CreateTable
CREATE TABLE "dead_letters" (
    "id" TEXT NOT NULL,
    "organization_id" TEXT NOT NULL,
    "queue" TEXT NOT NULL,
    "job_name" TEXT NOT NULL,
    "job_id" TEXT,
    "payload" JSONB NOT NULL,
    "attempts" INTEGER NOT NULL DEFAULT 0,
    "error" TEXT NOT NULL,
    "stack" TEXT,
    "failed_at" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "replayed_at" TIMESTAMP(3),
    "replayed_by_id" TEXT,
    "discarded_at" TIMESTAMP(3),
    "note" TEXT,

    CONSTRAINT "dead_letters_pkey" PRIMARY KEY ("id")
);

-- CreateIndex
CREATE INDEX "dead_letters_organization_id_failed_at_idx" ON "dead_letters"("organization_id", "failed_at");

-- CreateIndex
CREATE INDEX "dead_letters_queue_failed_at_idx" ON "dead_letters"("queue", "failed_at");

-- AddForeignKey
ALTER TABLE "dead_letters" ADD CONSTRAINT "dead_letters_organization_id_fkey" FOREIGN KEY ("organization_id") REFERENCES "organizations"("id") ON DELETE CASCADE ON UPDATE CASCADE;
