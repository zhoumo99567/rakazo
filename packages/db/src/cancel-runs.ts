import type { Prisma } from "./client.js";
import { cancelCoordinatedTask } from "./task-coordination.js";

/** The caller selects authorized runs and owns the surrounding transaction and cleanup. */
export async function cancelRunsInTransaction(
  tx: Prisma.TransactionClient,
  runs: ReadonlyArray<{ id: string; taskId: string }>,
  cancelledAt: Date,
): Promise<void> {
  if (runs.length === 0) return;
  const tasks = await tx.task.findMany({
    where: { id: { in: runs.map((run) => run.taskId) }, protocol: "coordination_v1" },
  });
  for (const task of tasks.sort((a, b) =>
    (a.rootTaskId ?? a.id).localeCompare(b.rootTaskId ?? b.id),
  )) {
    await cancelCoordinatedTask(tx, task.id, "Cancelled by the user.");
  }
  const runIds = runs.map((run) => run.id);
  await tx.run.updateMany({
    where: { id: { in: runIds } },
    data: {
      status: "cancelled",
      completedAt: cancelledAt,
      leaseOwner: null,
      leaseExpiresAt: null,
    },
  });
  await tx.attempt.updateMany({
    where: { runId: { in: runIds }, status: "running" },
    data: { status: "cancelled", finishedAt: cancelledAt },
  });
  await tx.task.updateMany({
    where: { id: { in: runs.map((run) => run.taskId) } },
    data: { status: "cancelled" },
  });
}
