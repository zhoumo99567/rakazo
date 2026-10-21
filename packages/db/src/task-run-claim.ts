import { TASK_PROTOCOL } from "@rakazo/contracts";
import type { Prisma, PrismaClient } from "./client.js";

/** All claim paths share the lock; legacy selection remains unchanged. */
export async function claimThreadRun(
  prisma: PrismaClient,
  threadId: string,
  runId: string,
  claim: { where: Prisma.RunWhereInput; data: Prisma.RunUpdateManyMutationInput },
) {
  return prisma.$transaction(async (tx) => {
    await tx.$queryRaw`SELECT id FROM threads WHERE id = ${threadId} FOR UPDATE`;
    const current = await tx.run.findUnique({
      where: { id: runId },
      include: { task: true, bot: true, thread: { select: { groupId: true } } },
    });
    if (!current || current.threadId !== threadId) return { count: 0 };
    if (
      current.thread.groupId &&
      !(await tx.chatGroup.findFirst({
        where: {
          id: current.thread.groupId,
          archivedAt: null,
          members: { some: { botId: current.botId, bot: { archivedAt: null } } },
        },
      }))
    )
      return { count: 0 };
    const coordinated = current.task.protocol === TASK_PROTOCOL;
    const occupying = await tx.run.findFirst({
      where: {
        threadId,
        id: { not: runId },
        status: { in: ["leased", "running", "waiting_takeover"] },
        ...(coordinated ? {} : { task: { protocol: TASK_PROTOCOL } }),
      },
      orderBy: [{ createdAt: "asc" }, { id: "asc" }],
    });
    if (occupying) return { count: 0 };
    if (coordinated) {
      if (
        current.bot.archivedAt ||
        ["completed", "failed", "cancelled"].includes(current.task.status)
      )
        return { count: 0 };
      if (current.status === "queued") {
        const queued = await tx.run.findMany({
          where: {
            threadId,
            status: "queued",
            task: { status: { notIn: ["completed", "failed", "cancelled"] } },
          },
          select: { id: true, createdAt: true, trigger: true },
        });
        // A finite advantage for continuations cannot starve older new work.
        const score = (r: (typeof queued)[number]) =>
          r.createdAt.getTime() - (r.trigger === "task_continue" ? 60_000 : 0);
        queued.sort(
          (a, b) =>
            score(a) - score(b) ||
            a.createdAt.getTime() - b.createdAt.getTime() ||
            a.id.localeCompare(b.id),
        );
        if (queued[0]?.id !== runId) return { count: 0 };
      }
    }
    return tx.run.updateMany(claim);
  });
}
