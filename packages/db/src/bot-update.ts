import { getLogger } from "@rakazo/logging";
import { writeBotInstructions } from "./bot-instructions.js";
import type { BotManager } from "./bot-management.js";
import { lockBotManagement } from "./bot-management.js";
import type { Prisma, PrismaClient } from "./client.js";
import { appendEventInTransaction } from "./events.js";

type AppendEvent = typeof appendEventInTransaction;

/**
 * Persist a bot row. When profile labels or instructions change, write `bot.updated`
 * in the same transaction so clients can refresh after every successful write.
 * Realtime notify stays best-effort after commit.
 */
export async function commitBotUpdate(
  options: {
    prisma: PrismaClient;
    notify: (threadId: string, seq: number) => Promise<void>;
    spaceId: string;
    threadId: string;
    botId: string;
    data: Omit<Prisma.BotUncheckedUpdateInput, "instructions"> & { instructions?: string };
    emitBotUpdated: boolean;
    manager?: BotManager;
    expectedUpdatedAt?: Date;
    sectionName?: string;
    expectedInstructions?: string;
    expectedModel?: {
      modelProvider: string | null;
      modelId: string | null;
      thinkingLevel: string | null;
    };
    instructionRestore?: { versionId: string; undo?: boolean };
    reason?: string;
  },
  appendEvent: AppendEvent = appendEventInTransaction,
): Promise<{ id: string; name: string; title: string; description: string }> {
  if (
    !options.manager &&
    !options.expectedUpdatedAt &&
    !options.sectionName &&
    options.data.managementRole === undefined &&
    !options.emitBotUpdated &&
    options.data.instructions === undefined &&
    !options.instructionRestore
  ) {
    return options.prisma.bot.update({
      where: { id: options.botId, ...options.expectedModel },
      data: options.data,
      select: { id: true, name: true, title: true, description: true },
    });
  }

  const { instructions, ...data } = options.data;
  const committed = await options.prisma.$transaction(async (tx) => {
    // Event appends also lock the thread; all writers take it before the bot row.
    if (options.manager) {
      if (
        Object.keys(data).some(
          (key) =>
            ![
              "name",
              "title",
              "description",
              "color",
              "notifyOnFinish",
              "modelProvider",
              "modelId",
              "thinkingLevel",
              "pinned",
              "sectionId",
            ].includes(key),
        )
      )
        throw new Error("Bot management cannot change roles or ownership.");
      await lockBotManagement(tx, options.spaceId, options.manager, {
        threadIds: [options.threadId],
        targetBotId: options.botId,
      });
    } else {
      await tx.$queryRaw`SELECT id FROM threads WHERE id = ${options.threadId} FOR UPDATE`;
    }
    if (options.expectedUpdatedAt) {
      await tx.bot.findUniqueOrThrow({
        where: { id: options.botId, updatedAt: options.expectedUpdatedAt },
      });
    }
    if (options.sectionName && options.manager) {
      const scope = { spaceId: options.spaceId, userId: options.manager.userId };
      const position = await tx.botSection.aggregate({ where: scope, _max: { position: true } });
      const section = await tx.botSection.upsert({
        where: { spaceId_userId_name: { ...scope, name: options.sectionName } },
        create: {
          ...scope,
          name: options.sectionName,
          position: (position._max.position ?? -1) + 1,
        },
        update: {},
      });
      data.sectionId = section.id;
    }
    if (typeof instructions === "string" || options.instructionRestore) {
      await writeBotInstructions(tx, {
        botId: options.botId,
        instructions,
        reason: options.instructionRestore ? "Restore" : (options.reason ?? "Manual edit"),
        expectedInstructions: options.expectedInstructions,
        ...options.instructionRestore,
      });
    }
    const updated = await tx.bot.update({
      where: {
        id: options.botId,
        ...options.expectedModel,
      },
      data,
      select: { id: true, name: true, title: true, description: true },
    });
    const event = await appendEvent(tx, {
      spaceId: options.spaceId,
      threadId: options.threadId,
      botId: options.botId,
      type: "bot.updated",
      payload: {
        botId: updated.id,
        name: updated.name,
        title: updated.title,
        description: updated.description,
      },
    });
    return { updated, seq: event.seq };
  });

  await options.notify(options.threadId, committed.seq).catch((error) => {
    getLogger().error("bot.updated realtime notification", error);
  });
  return committed.updated;
}

export function botProfileLabelsChanged(input: {
  name?: unknown;
  title?: unknown;
  description?: unknown;
  color?: unknown;
}): boolean {
  return (
    input.name !== undefined ||
    input.title !== undefined ||
    input.description !== undefined ||
    input.color !== undefined
  );
}
