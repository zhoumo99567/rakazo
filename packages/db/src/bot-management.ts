import { TASK_PROTOCOL } from "@rakazo/contracts";
import { isOwnerStartedRun } from "@rakazo/core";
import type { Prisma } from "./client.js";
import { IsolationError } from "./scope.js";
import { lockTaskTree } from "./task-coordination.js";

export interface BotManager {
  botId: string;
  userId: string;
  runId: string;
  leaseOwner?: string | null;
  leaseFence?: number;
}

/** Hold caller and target rows until the management write commits. */
export async function requireBotManager(
  tx: Prisma.TransactionClient,
  spaceId: string,
  manager: BotManager,
  targetBotId?: string,
) {
  for (const id of [...new Set([manager.botId, ...(targetBotId ? [targetBotId] : [])])].sort()) {
    await tx.$queryRaw`SELECT id FROM bots WHERE id = ${id} FOR UPDATE`;
  }
  const caller = await tx.bot.findFirst({
    where: {
      id: manager.botId,
      spaceId,
      userId: manager.userId,
      managementRole: "chief",
      archivedAt: null,
    },
  });
  const run = await tx.run.findFirst({
    where: {
      id: manager.runId,
      botId: manager.botId,
      spaceId,
      userId: manager.userId,
      status: "running",
      ...(manager.leaseOwner
        ? { leaseOwner: manager.leaseOwner, leaseFence: manager.leaseFence }
        : {}),
    },
    include: { task: true, sourceMessage: true },
  });
  const ownerAuthorized =
    run?.task.protocol === TASK_PROTOCOL
      ? run.task.ownerAuthorized && !run.task.externalInfluence
      : run && isOwnerStartedRun(run.trigger, run.sourceMessage?.role === "user");
  if (!caller || !run || !ownerAuthorized) {
    throw new IsolationError("Bot management requires a Chief and an authorized owner task.");
  }
  const externalSteering = await tx.steeringMessage.findFirst({
    where: {
      runId: manager.runId,
      OR: [
        { originTrigger: { not: null } },
        { message: { blocks: { array_contains: [{ kind: "channel_message" }] } } },
      ],
    },
    select: { id: true },
  });
  if (externalSteering)
    throw new IsolationError("External messages cannot authorize bot management.");
  if (targetBotId) {
    const target = await tx.bot.findFirst({
      where: {
        id: targetBotId,
        spaceId,
        userId: manager.userId,
        managementRole: "member",
        archivedAt: null,
      },
    });
    if (!target || target.id === manager.botId) {
      throw new IsolationError("A Chief can manage only ordinary bots in its own space.");
    }
  }
}

/** Lock the caller's authorization context before the target and the management write. */
export async function lockBotManagement(
  tx: Prisma.TransactionClient,
  spaceId: string,
  manager: BotManager,
  options: { threadIds?: string[]; taskIds?: string[]; targetBotId?: string } = {},
) {
  const source = await tx.run.findFirst({
    where: {
      id: manager.runId,
      spaceId,
      userId: manager.userId,
      botId: manager.botId,
      status: "running",
    },
    select: { threadId: true, taskId: true },
  });
  if (!source) throw new IsolationError();
  for (const id of [...new Set([source.threadId, ...(options.threadIds ?? [])])].sort()) {
    await tx.$queryRaw`SELECT id FROM threads WHERE id = ${id} FOR UPDATE`;
  }
  const tasks = await tx.task.findMany({
    where: {
      id: { in: [source.taskId, ...(options.taskIds ?? [])] },
      spaceId,
      userId: manager.userId,
    },
  });
  for (const task of tasks.sort((a, b) =>
    (a.rootTaskId ?? a.id).localeCompare(b.rootTaskId ?? b.id),
  )) {
    await lockTaskTree(tx, task.id);
  }
  await requireBotManager(tx, spaceId, manager, options.targetBotId);
}
