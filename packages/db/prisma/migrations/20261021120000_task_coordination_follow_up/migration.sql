ALTER TABLE "tasks"
  ADD COLUMN "workKey" TEXT,
  ADD COLUMN "revisionOfTaskId" TEXT,
  ADD COLUMN "reportIntervalMs" INTEGER NOT NULL DEFAULT 300000,
  ADD COLUMN "reportDueAt" TIMESTAMP(3),
  ADD COLUMN "reportRemainingMs" INTEGER,
  ADD COLUMN "reportReminderAt" TIMESTAMP(3),
  ADD COLUMN "reportOverdueAt" TIMESTAMP(3),
  ADD COLUMN "lastReportedAt" TIMESTAMP(3),
  ADD COLUMN "lastProgressAt" TIMESTAMP(3),
  ADD COLUMN "latestReport" JSONB,
  ADD COLUMN "nextProgressWakeAt" TIMESTAMP(3);
CREATE UNIQUE INDEX "tasks_parentTaskId_workKey_key" ON "tasks"("parentTaskId", "workKey");
CREATE INDEX "tasks_reportDueAt_idx" ON "tasks"("reportDueAt");
ALTER TABLE "task_messages"
  ADD COLUMN "deliveryClass" TEXT NOT NULL DEFAULT 'actionable',
  ADD COLUMN "deliveredAt" TIMESTAMP(3);
