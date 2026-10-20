ALTER TABLE "bots" ADD COLUMN "archiveCleanupPending" BOOLEAN NOT NULL DEFAULT false;
ALTER TABLE "bots" ADD COLUMN "archiveCleanupClaimUntil" TIMESTAMP(3);
ALTER TABLE "bots" ADD COLUMN "archiveOperationKey" TEXT;
ALTER TABLE "bots" ADD COLUMN "managementRole" TEXT NOT NULL DEFAULT 'member';
ALTER TABLE "bots" ADD CONSTRAINT "bots_managementRole_check" CHECK ("managementRole" IN ('member', 'chief'));

ALTER TABLE "tasks"
  ADD COLUMN "protocol" TEXT NOT NULL DEFAULT 'legacy',
  ADD COLUMN "parentTaskId" TEXT,
  ADD COLUMN "rootTaskId" TEXT,
  ADD COLUMN "delegatedByRunId" TEXT,
  ADD COLUMN "delegationKey" TEXT,
  ADD COLUMN "originalPrompt" TEXT,
  ADD COLUMN "sourceMessageId" TEXT,
  ADD COLUMN "ownerAuthorized" BOOLEAN NOT NULL DEFAULT false,
  ADD COLUMN "externalInfluence" BOOLEAN NOT NULL DEFAULT false,
  ADD COLUMN "result" JSONB,
  ADD COLUMN "finalRunId" TEXT,
  ADD COLUMN "completedAt" TIMESTAMP(3),
  ADD COLUMN "notificationDeliveredAt" TIMESTAMP(3),
  ADD COLUMN "notificationLeaseUntil" TIMESTAMP(3);
ALTER TABLE "tasks" ADD CONSTRAINT "tasks_parentTaskId_fkey"
  FOREIGN KEY ("parentTaskId") REFERENCES "tasks"("id") ON DELETE SET NULL ON UPDATE CASCADE;
ALTER TABLE "tasks" ADD CONSTRAINT "tasks_protocol_check" CHECK ("protocol" IN ('legacy', 'coordination_v1'));
CREATE UNIQUE INDEX "tasks_delegationKey_key" ON "tasks"("delegationKey");
CREATE INDEX "tasks_parentTaskId_status_idx" ON "tasks"("parentTaskId", "status");
CREATE INDEX "tasks_protocol_status_updatedAt_idx" ON "tasks"("protocol", "status", "updatedAt");
CREATE INDEX "tasks_rootTaskId_idx" ON "tasks"("rootTaskId");

-- A model-supplied task id must never join different privacy boundaries.
CREATE FUNCTION check_task_parent_scope() RETURNS trigger LANGUAGE plpgsql AS $$
BEGIN
  IF NEW."parentTaskId" IS NOT NULL AND NOT EXISTS (
    SELECT 1 FROM "tasks" p
    WHERE p.id = NEW."parentTaskId" AND p."spaceId" = NEW."spaceId"
      AND p."userId" = NEW."userId" AND p.protocol = 'coordination_v1'
      AND NEW.protocol = 'coordination_v1' AND p.id <> NEW.id
  ) THEN
    RAISE EXCEPTION 'Invalid task parent scope' USING ERRCODE = '23514';
  END IF;
  IF TG_OP = 'UPDATE' AND NEW."parentTaskId" IS NOT NULL
      AND NEW."parentTaskId" IS DISTINCT FROM OLD."parentTaskId" THEN
    RAISE EXCEPTION 'Task parent cannot change' USING ERRCODE = '23514';
  END IF;
  RETURN NEW;
END;
$$;
CREATE TRIGGER "tasks_parent_scope" BEFORE INSERT OR UPDATE OF "parentTaskId", "spaceId", "userId", "protocol"
  ON "tasks" FOR EACH ROW EXECUTE FUNCTION check_task_parent_scope();

CREATE TABLE "task_messages" (
  "id" TEXT NOT NULL PRIMARY KEY,
  "taskId" TEXT NOT NULL REFERENCES "tasks"("id") ON DELETE CASCADE ON UPDATE CASCADE,
  "fromTaskId" TEXT NOT NULL,
  "fromBotId" TEXT NOT NULL,
  "fromBotName" TEXT NOT NULL,
  "kind" TEXT NOT NULL,
  "text" TEXT NOT NULL,
  "payload" JSONB,
  "replyToId" TEXT,
  "answeredAt" TIMESTAMP(3),
  "deliveryKey" TEXT NOT NULL,
  "claimedByRunId" TEXT,
  "consumedAt" TIMESTAMP(3),
  "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP
);
CREATE UNIQUE INDEX "task_messages_deliveryKey_key" ON "task_messages"("deliveryKey");
CREATE INDEX "task_messages_taskId_consumedAt_createdAt_idx" ON "task_messages"("taskId", "consumedAt", "createdAt");
CREATE INDEX "task_messages_fromTaskId_kind_answeredAt_idx" ON "task_messages"("fromTaskId", "kind", "answeredAt");
CREATE INDEX "task_messages_claimedByRunId_idx" ON "task_messages"("claimedByRunId");
CREATE TABLE "task_artifacts" (
  "taskId" TEXT NOT NULL REFERENCES "tasks"("id") ON DELETE CASCADE ON UPDATE CASCADE,
  "artifactId" TEXT NOT NULL REFERENCES "artifacts"("id") ON DELETE CASCADE ON UPDATE CASCADE,
  PRIMARY KEY ("taskId", "artifactId")
);
CREATE INDEX "task_artifacts_artifactId_idx" ON "task_artifacts"("artifactId");

CREATE TABLE "task_run_cleanups" (
 "runId" TEXT NOT NULL, "computerId" TEXT NOT NULL REFERENCES "computers"("id") ON DELETE CASCADE ON UPDATE CASCADE,
 "botId" TEXT NOT NULL, "userId" TEXT NOT NULL, "spaceId" TEXT NOT NULL,
 "homeKey" TEXT NOT NULL, "kind" TEXT NOT NULL, "providerRef" TEXT, "fence" INTEGER,
 "claimedUntil" TIMESTAMP(3), "completedAt" TIMESTAMP(3), "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
 PRIMARY KEY ("runId", "computerId")
);
CREATE INDEX "task_run_cleanups_completedAt_createdAt_idx" ON "task_run_cleanups" ("completedAt", "createdAt");
CREATE INDEX "task_run_cleanups_computerId_botId_completedAt_idx" ON "task_run_cleanups" ("computerId", "botId", "completedAt");
