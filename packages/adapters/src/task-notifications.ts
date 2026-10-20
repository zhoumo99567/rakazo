import type { NotificationProvider } from "@rakazo/adapter-kit";
import { TASK_PROTOCOL } from "@rakazo/contracts";
import { truncatedPlainText } from "@rakazo/core";
import type { PrismaClient } from "@rakazo/db";
import { getLogger } from "@rakazo/logging";

/** The terminal Task is the durable outbox record; a lease permits crash recovery. */
export async function deliverTaskNotification(
  deps: { prisma: PrismaClient; notifications?: NotificationProvider },
  taskId: string,
) {
  if (!deps.notifications) return;
  const now = new Date();
  const leaseUntil = new Date(now.getTime() + 60_000);
  const claimed = await deps.prisma.task.updateMany({
    where: {
      id: taskId,
      protocol: TASK_PROTOCOL,
      parentTaskId: null,
      delegatedByRunId: null,
      status: { in: ["completed", "failed"] },
      notificationDeliveredAt: null,
      OR: [{ notificationLeaseUntil: null }, { notificationLeaseUntil: { lt: now } }],
    },
    data: { notificationLeaseUntil: leaseUntil },
  });
  if (!claimed.count) return;
  try {
    const task = await deps.prisma.task.findUniqueOrThrow({
      where: { id: taskId },
      include: { bot: true },
    });
    const result = task.result as { text?: string } | null;
    const body = truncatedPlainText(result?.text ?? "", 180);
    if (task.bot.notifyOnFinish && !task.bot.archivedAt && body) {
      const kind = task.status === "failed" ? "failure" : "completion";
      await deps.notifications.send(
        {
          kind,
          title: `${task.bot.name} ${kind === "failure" ? "failed" : "finished"}`,
          body,
          botId: task.botId,
          threadId: task.threadId,
        },
        {
          operationId: `task:${task.id}:notification:${kind}`,
          traceId: task.id,
          spaceId: task.spaceId,
          userId: task.userId,
          botId: task.botId,
          signal: AbortSignal.timeout(45_000),
        },
      );
    }
    await deps.prisma.task.updateMany({
      where: { id: taskId, notificationLeaseUntil: leaseUntil },
      data: { notificationDeliveredAt: new Date(), notificationLeaseUntil: null },
    });
  } catch (error) {
    await deps.prisma.task.updateMany({
      where: { id: taskId, notificationLeaseUntil: leaseUntil },
      data: { notificationLeaseUntil: new Date(Date.now() + 5 * 60_000) },
    });
    throw error;
  }
}

export async function reconcileTaskNotifications(
  deps: { prisma: PrismaClient; notifications?: NotificationProvider },
  take = 100,
) {
  if (!deps.notifications) return;
  const tasks = await deps.prisma.task.findMany({
    where: {
      protocol: TASK_PROTOCOL,
      parentTaskId: null,
      delegatedByRunId: null,
      status: { in: ["completed", "failed"] },
      notificationDeliveredAt: null,
      OR: [{ notificationLeaseUntil: null }, { notificationLeaseUntil: { lt: new Date() } }],
    },
    orderBy: [{ completedAt: "asc" }, { id: "asc" }],
    take,
    select: { id: true },
  });
  for (const task of tasks) {
    await deliverTaskNotification(deps, task.id).catch((error) =>
      getLogger().error("task notification delivery", error),
    );
  }
}
