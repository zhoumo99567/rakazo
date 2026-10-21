import type { TaskExecution } from "@rakazo/contracts";
import { TaskExecutionSchema } from "@rakazo/contracts";
import type { PrismaClient } from "./client.js";

/** Executor liveness, provider operation state and business progress are separate observations. */
export async function loadTaskExecutions(
  prisma: PrismaClient,
  taskIds: string[],
  scope: { userId: string; spaceId: string },
  now = new Date(),
) {
  const tasks = await prisma.task.findMany({
    where: { id: { in: taskIds }, userId: scope.userId, spaceId: scope.spaceId },
    select: {
      id: true,
      runs: {
        orderBy: [{ createdAt: "desc" }, { id: "desc" }],
        take: 1,
        select: {
          status: true,
          leaseExpiresAt: true,
          effects: {
            where: { kind: "shell", result: { path: ["operation", "version"], equals: 1 } },
            orderBy: { createdAt: "desc" },
            take: 10,
            select: { id: true, result: true, status: true },
          },
        },
      },
    },
  });
  return new Map<string, TaskExecution>(
    tasks.map((task) => {
      const run = task.runs[0];
      const executing = run?.status === "running" || run?.status === "leased";
      const operations = (run?.effects ?? []).flatMap((effect) => {
        const result = effect.result as Record<string, unknown> | null;
        if (!result) return [];
        const parsed = TaskExecutionSchema.shape.operations.element.safeParse({
          id: effect.id,
          state: result.state ?? "unknown",
          startedAt: result.startedAt ?? null,
          deadlineAt: result.deadlineAt ?? null,
          observedAt: result.observedAt ?? null,
          code: result.code ?? null,
        });
        if (!parsed.success) return [];
        const value = parsed.data;
        if (
          effect.status !== "completed" &&
          (!value.observedAt || now.getTime() - Date.parse(value.observedAt) > 90_000)
        )
          value.state = "unknown";
        return [value];
      });
      return [
        task.id,
        {
          heartbeat: executing
            ? run.leaseExpiresAt && run.leaseExpiresAt > now
              ? "current"
              : "expired"
            : "inactive",
          leaseExpiresAt: run?.leaseExpiresAt?.toISOString() ?? null,
          operations,
        },
      ];
    }),
  );
}
