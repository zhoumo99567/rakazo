import type { Actor, TaskSummary } from "@rakazo/contracts";
import { TASK_PROTOCOL, TaskSummarySchema } from "@rakazo/contracts";
import type { PrismaClient } from "./client.js";
import { appendEventInTransaction } from "./events.js";
import { IsolationError } from "./scope.js";
import { cancelCoordinatedTask } from "./task-coordination.js";
import { withTransactionRetry } from "./transaction-retry.js";

export async function listOwnedTasks(
  prisma: PrismaClient,
  actor: Actor,
  input: { botId?: string; parentTaskId?: string; cursor?: string },
): Promise<{ tasks: TaskSummary[]; nextCursor: string | null }> {
  const after = input.cursor
    ? await prisma.task.findFirst({
        where: {
          id: input.cursor,
          userId: actor.userId,
          spaceId: actor.spaceId,
          protocol: TASK_PROTOCOL,
        },
        select: { id: true, createdAt: true },
      })
    : null;
  if (input.cursor && !after) throw new IsolationError();
  const rows = await prisma.task.findMany({
    where: {
      spaceId: actor.spaceId,
      userId: actor.userId,
      protocol: TASK_PROTOCOL,
      ...(input.botId ? { botId: input.botId } : {}),
      ...(input.parentTaskId ? { parentTaskId: input.parentTaskId } : {}),
      ...(after
        ? {
            OR: [
              { createdAt: { lt: after.createdAt } },
              { createdAt: after.createdAt, id: { lt: after.id } },
            ],
          }
        : {}),
    },
    orderBy: [{ createdAt: "desc" }, { id: "desc" }],
    take: 41,
    include: {
      bot: { select: { name: true } },
      parent: { select: { userId: true, spaceId: true, bot: { select: { name: true } } } },
      runs: { orderBy: [{ createdAt: "asc" }, { id: "asc" }], take: 1, select: { trigger: true } },
      _count: {
        select: {
          inbox: { where: { consumedAt: null, deliveryClass: "actionable" } },
          children: { where: { userId: actor.userId, spaceId: actor.spaceId } },
        },
      },
    },
  });
  const page = rows.slice(0, 40);
  return {
    tasks: page.map((task) =>
      TaskSummarySchema.parse({
        id: task.id,
        botId: task.botId,
        parentTaskId: task.parentTaskId,
        status: task.status,
        prompt: task.originalPrompt ?? task.prompt,
        completedAt: task.completedAt?.toISOString() ?? null,
        createdAt: task.createdAt.toISOString(),
        botName: task.bot.name,
        source:
          task.parentTaskId || task.delegatedByRunId
            ? {
                kind: "bot",
                botName:
                  task.parent?.userId === actor.userId && task.parent.spaceId === actor.spaceId
                    ? task.parent.bot.name
                    : null,
              }
            : {
                kind: ["user", "follow_up"].includes(task.runs[0]?.trigger ?? "")
                  ? "user"
                  : task.runs[0]?.trigger === "routine"
                    ? "routine"
                    : "system",
              },
        childCount: task._count.children,
        latestReport: task.latestReport ?? null,
        pendingMessageCount: ["completed", "failed", "cancelled"].includes(task.status)
          ? 0
          : task._count.inbox,
        reportOverdue:
          task.status === "running" && Boolean(task.reportDueAt && task.reportOverdueAt),
      }),
    ),
    nextCursor: rows.length > 40 ? page.at(-1)!.id : null,
  };
}

export async function cancelOwnedTask(prisma: PrismaClient, actor: Actor, taskId: string) {
  return withTransactionRetry(() =>
    prisma.$transaction(async (tx) => {
      const task = await tx.task.findFirst({
        where: {
          id: taskId,
          spaceId: actor.spaceId,
          userId: actor.userId,
          protocol: TASK_PROTOCOL,
        },
      });
      if (!task) throw new IsolationError();
      await tx.$queryRaw`SELECT id FROM threads WHERE id = ${task.threadId} FOR UPDATE`;
      const cancelled = await cancelCoordinatedTask(tx, task.id, "Cancelled by the user.");
      const event = await appendEventInTransaction(tx, {
        spaceId: actor.spaceId,
        threadId: task.threadId,
        botId: task.botId,
        type: "bot.updated",
        payload: { botId: task.botId, taskId: task.id },
      });
      return {
        threadId: task.threadId,
        seq: event.seq,
        cancelledRunIds: cancelled ? cancelled.cancelledRunIds : [],
      };
    }),
  );
}
