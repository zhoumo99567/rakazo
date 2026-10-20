import type { SandboxProvider } from "@rakazo/adapter-kit";
import type { PrismaClient } from "@rakazo/db";
import { getLogger } from "@rakazo/logging";
import { cancelComputerRunWork } from "./computer-idle.js";
import { screenLeaseIdForRun } from "./computer-lifecycle.js";
import { toComputerRef } from "./computer-support.js";

/** Run-scoped coordinates remain usable after bot/task deletion and worker crashes. */
export async function reconcileTaskCleanup(
  deps: { prisma: PrismaClient; sandbox: SandboxProvider },
  runIds?: string[],
  take = 10,
) {
  const now = new Date();
  const rows = await deps.prisma.taskRunCleanup.findMany({
    where: {
      completedAt: null,
      ...(runIds ? { runId: { in: runIds } } : {}),
      OR: [{ claimedUntil: null }, { claimedUntil: { lt: now } }],
    },
    orderBy: { createdAt: "asc" },
    take,
  });
  for (const row of rows) {
    const claimedUntil = new Date(Date.now() + 60_000);
    const key = { runId: row.runId, computerId: row.computerId };
    const claimed = await deps.prisma.taskRunCleanup.updateMany({
      where: {
        ...key,
        completedAt: null,
        OR: [{ claimedUntil: null }, { claimedUntil: { lt: now } }],
      },
      data: { claimedUntil },
    });
    if (!claimed.count) continue;
    try {
      if (row.providerRef) {
        const context = {
          operationId: `task-cancel:${row.runId}:${row.computerId}`,
          traceId: row.runId,
          spaceId: row.spaceId,
          userId: row.userId,
          botId: row.botId,
          runId: row.runId,
          screenLeaseId: screenLeaseIdForRun(
            row.fence === null ? null : { runId: row.runId, fence: row.fence },
            row.runId,
          ),
          cancelRunWork: true,
          signal: AbortSignal.timeout(45_000),
        };
        const ref = toComputerRef(row);
        // Strict mode leaves a failed stop pending rather than freeing the screen.
        await cancelComputerRunWork(deps.sandbox, ref, row.computerId, row.runId, context, true);
        await deps.sandbox.releaseScreen?.(ref, context);
      }
      await deps.prisma.$transaction(async (tx) => {
        await tx.computerExecutionLease.updateMany({
          where: { ...key, ...(row.fence === null ? {} : { fence: row.fence }) },
          data: { expiresAt: new Date(0) },
        });
        await tx.computer.updateMany({
          where: { id: row.computerId, executionRunId: row.runId },
          data: { executionRunId: null, executionBotId: null, executionLeaseExpiresAt: null },
        });
        await tx.computer.updateMany({
          where: { id: row.computerId, controlRunId: row.runId },
          data: {
            controlRunId: null,
            controlBotId: null,
            controlHolder: "none",
            controlLeaseId: null,
            controlLeaseExpiresAt: null,
          },
        });
        await tx.taskRunCleanup.updateMany({
          where: { ...key, claimedUntil },
          data: { completedAt: new Date(), claimedUntil: null },
        });
      });
    } catch (error) {
      await deps.prisma.taskRunCleanup.updateMany({
        where: { ...key, claimedUntil },
        data: { claimedUntil: new Date(Date.now() + 5 * 60_000) },
      });
      getLogger().error("cancelled task cleanup", error);
    }
  }
}
