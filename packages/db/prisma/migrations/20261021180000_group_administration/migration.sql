ALTER TABLE "chat_groups" ADD COLUMN "adminBotId" TEXT, ADD COLUMN "createdByBotId" TEXT;
ALTER TABLE "chat_groups" ADD COLUMN "creationKey" TEXT;
CREATE UNIQUE INDEX "chat_groups_creationKey_key" ON "chat_groups"("creationKey");
