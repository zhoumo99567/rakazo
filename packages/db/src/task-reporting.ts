import { TASK_PROTOCOL } from "@rakazo/contracts";
import type { PrismaClient } from "./client.js";
import { lockTaskTree, pauseTaskReport } from "./task-coordination.js";

/** A lease is activity evidence, never evidence of business progress. */
export async function reconcileTaskReports(prisma: PrismaClient, take = 100, now = new Date()) {
  const rows = await prisma.task.findMany({
    where: {
      protocol: TASK_PROTOCOL,
      parentTaskId: { not: null },
      status: { notIn: ["completed", "failed", "cancelled"] },
      reportDueAt: { not: null },
      OR: [
        { reportDueAt: { lte: now }, reportOverdueAt: null },
        { runs: { none: { status: "running" } } },
      ],
    },
    orderBy: [{ reportDueAt: "asc" }, { id: "asc" }],
    take,
    select: { id: true, threadId: true },
  });
  for (const row of rows)
    await prisma.$transaction(async (tx) => {
      await tx.$queryRaw`SELECT id FROM threads WHERE id = ${row.threadId} FOR UPDATE`;
      const task = await lockTaskTree(tx, row.id);
      if (
        !task?.parentTaskId ||
        !task.reportDueAt ||
        ["completed", "failed", "cancelled"].includes(task.status)
      )
        return;
      const running = await tx.run.findFirst({ where: { taskId: task.id, status: "running" } });
      if (!running) {
        const latest = await tx.run.findFirst({
          where: { taskId: task.id },
          orderBy: { updatedAt: "desc" },
        });
        await pauseTaskReport(tx, task.id, latest?.updatedAt ?? now);
        return;
      }
      // One further interval beyond the reminder, not a timer that generates fake progress.
      if (
        task.reportOverdueAt ||
        now.getTime() < task.reportDueAt.getTime() + task.reportIntervalMs
      )
        return;
      const parent = await tx.task.findFirst({
        where: {
          id: task.parentTaskId,
          userId: task.userId,
          spaceId: task.spaceId,
          status: { notIn: ["completed", "failed", "cancelled"] },
        },
      });
      if (!parent) return;
      const bot = await tx.bot.findUnique({ where: { id: task.botId }, select: { name: true } });
      await tx.taskMessage.upsert({
        where: { deliveryKey: `report-overdue:${task.id}:${task.reportDueAt.toISOString()}` },
        update: {},
        create: {
          taskId: parent.id,
          fromTaskId: task.id,
          fromBotId: task.botId,
          fromBotName: bot?.name ?? "Bot",
          kind: "fyi",
          deliveryClass: "actionable",
          text: "System observation: this child task has not supplied its scheduled report. This is a soft inspection reminder, not an execution deadline. Check task_status: executor heartbeat, operation state and last business progress are independent. A long model or command operation may still be healthy. Do not cancel, fail, restart or duplicate work merely because a report is late.",
          deliveryKey: `report-overdue:${task.id}:${task.reportDueAt.toISOString()}`,
        },
      });
      await tx.task.update({ where: { id: task.id }, data: { reportOverdueAt: now } });
    });
}
