import type { JobPublisher, SandboxProvider } from "@rakazo/adapter-kit";
import { runContinueJob, runJobKey } from "@rakazo/adapter-kit";
import type { BotMessageIntent } from "@rakazo/contracts";
import { TASK_PROTOCOL } from "@rakazo/contracts";
import { BOT_MESSAGE_MAX_LENGTH, resolveBotAddress } from "@rakazo/core";
import type { PrismaClient, TaskDelegationOptions, TaskRunScope } from "@rakazo/db";
import {
  activeTaskRunWhere,
  cancelCoordinatedTask,
  delegateTask,
  IsolationError,
  lockBotManagement,
  reconcileTaskContinuations,
  requireBotManager,
  sendTaskMessage,
  TaskDelegationConflict,
  withTransactionRetry,
} from "@rakazo/db";

import { reconcileTaskCleanup } from "./task-cleanup.js";

type Deps = {
  sandbox: SandboxProvider;
  prisma: PrismaClient;
  jobs: Pick<JobPublisher, "enqueue" | "cancel">;
};

async function targetBot(
  prisma: PrismaClient,
  run: TaskRunScope,
  input: { bot_id?: string; confirm_name?: string },
) {
  const candidates = await prisma.bot.findMany({
    where: { spaceId: run.spaceId, userId: run.userId, archivedAt: null },
    select: { id: true, name: true },
  });
  const target = resolveBotAddress(candidates, { botId: input.bot_id, name: input.confirm_name });
  if (!target) throw new IsolationError("No available bot with that id or name.");
  return target;
}

export async function handoffToTaskBot(
  deps: Deps,
  run: TaskRunScope,
  input: Omit<TaskDelegationOptions, "botId" | "prompt"> & {
    bot_id?: string;
    confirm_name?: string;
    message: string;
  },
) {
  if (input.message.length > BOT_MESSAGE_MAX_LENGTH)
    throw new Error("Task description is too long.");
  const target = await targetBot(deps.prisma, run, input);
  let child: Awaited<ReturnType<typeof delegateTask>>;
  try {
    child = await delegateTask(deps.prisma, run, {
      ...input,
      botId: target.id,
      prompt: input.message,
      deliveryKey: input.deliveryKey,
    });
  } catch (error) {
    if (error instanceof TaskDelegationConflict) return error.detail;
    throw error;
  }
  // The queued Run is durable; the existing reconciler repairs a lost enqueue.
  if (child.runId) await deps.jobs.enqueue(runContinueJob(child.runId)).catch(() => undefined);
  return {
    ok: true,
    ...child,
    note: "The child task will return its result automatically. Keep working or end this turn to wait. Your parent task remains open.",
  };
}

export async function messageTaskBot(
  deps: Deps,
  run: TaskRunScope,
  input: {
    bot_id?: string;
    confirm_name?: string;
    task_id?: string;
    reply_to?: string;
    progressChanged?: boolean;
    message: string;
    intent?: BotMessageIntent;
    deliveryKey: string;
  },
) {
  if (!input.message.trim() || input.message.length > BOT_MESSAGE_MAX_LENGTH) {
    throw new Error("Provide a nonempty task message within the message length limit.");
  }
  const current = await deps.prisma.task.findUniqueOrThrow({ where: { id: run.taskId } });
  if (current.protocol !== TASK_PROTOCOL) throw new Error("This task uses legacy messaging.");
  let targetTaskId = input.task_id;
  if (!targetTaskId) {
    const target = await targetBot(deps.prisma, run, input);
    const related = await deps.prisma.task.findMany({
      where: {
        spaceId: run.spaceId,
        userId: run.userId,
        botId: target.id,
        protocol: TASK_PROTOCOL,
        status: { notIn: ["completed", "failed", "cancelled"] },
        OR: [{ id: current.parentTaskId ?? "" }, { parentTaskId: current.id }],
      },
      select: { id: true },
      take: 2,
    });
    if (related.length !== 1) {
      throw new Error(
        "Use task_id for an existing parent or child task. Use handoff_to_bot to assign new work.",
      );
    }
    targetTaskId = related[0]!.id;
  }
  const message = await sendTaskMessage(deps.prisma, run, {
    taskId: targetTaskId,
    text: input.message,
    kind: input.intent ?? "request",
    replyToId: input.reply_to,
    progressChanged: input.progressChanged,
    deliveryKey: input.deliveryKey,
  });
  const ready = await reconcileTaskContinuations(deps.prisma, 1, targetTaskId).catch(() => []);
  await Promise.all(
    ready.map((id) => deps.jobs.enqueue(runContinueJob(id)).catch(() => undefined)),
  );
  return { ok: true, taskId: targetTaskId, messageId: message.id, kind: message.kind };
}

async function ownsTaskTree(
  prisma: PrismaClient,
  currentTaskId: string,
  targetTaskId: string,
  run: TaskRunScope,
) {
  let id: string | null = targetTaskId;
  const seen = new Set<string>();
  while (id && !seen.has(id)) {
    if (id === currentTaskId) return true;
    seen.add(id);
    const task: { parentTaskId: string | null } | null = await prisma.task.findFirst({
      where: { id, spaceId: run.spaceId, userId: run.userId, protocol: TASK_PROTOCOL },
      select: { parentTaskId: true },
    });
    id = task?.parentTaskId ?? null;
  }
  return false;
}

export async function taskStatus(deps: Deps, run: TaskRunScope, taskId = run.taskId) {
  const owned = await ownsTaskTree(deps.prisma, run.taskId, taskId, run);
  const target = await deps.prisma.task.findFirst({
    where: { id: taskId, spaceId: run.spaceId, userId: run.userId, protocol: TASK_PROTOCOL },
    include: { children: { orderBy: { createdAt: "asc" } } },
  });
  if (!target) throw new IsolationError();
  if (!owned) {
    await deps.prisma.$transaction((tx) =>
      requireBotManager(
        tx,
        run.spaceId,
        {
          botId: run.botId,
          userId: run.userId,
          runId: run.id,
          leaseOwner: run.leaseOwner,
          leaseFence: run.leaseFence,
        },
        target.botId,
      ),
    );
  }
  const summary = (task: typeof target) => ({
    id: task.id,
    botId: task.botId,
    parentTaskId: task.parentTaskId,
    status: task.status,
    prompt: task.originalPrompt ?? task.prompt,
    completedAt: task.completedAt?.toISOString() ?? null,
    workKey: task.workKey,
    revisionOfTaskId: task.revisionOfTaskId,
    reportIntervalMs: task.reportIntervalMs,
    reportDueAt: task.reportDueAt?.toISOString() ?? null,
    lastReportedAt: task.lastReportedAt?.toISOString() ?? null,
    lastProgressAt: task.lastProgressAt?.toISOString() ?? null,
    latestReport: task.latestReport,
    reportOverdue: task.status === "running" && Boolean(task.reportDueAt && task.reportOverdueAt),
  });
  return {
    task: summary(target),
    children: target.children.map((child) => summary({ ...child, children: [] })),
  };
}

export async function cancelTask(deps: Deps, run: TaskRunScope, taskId: string, reason: string) {
  if (taskId === run.taskId) throw new Error("End your own turn; task_cancel is for other tasks.");
  const owned = await ownsTaskTree(deps.prisma, run.taskId, taskId, run);
  const cancelled = await withTransactionRetry(() =>
    deps.prisma.$transaction(async (tx) => {
      const target = await tx.task.findFirst({
        where: { id: taskId, spaceId: run.spaceId, userId: run.userId, protocol: TASK_PROTOCOL },
      });
      if (!target) throw new IsolationError();
      // The root lock serializes cancellation with terminal delivery and delegation.
      if (!owned) {
        await lockBotManagement(
          tx,
          run.spaceId,
          {
            botId: run.botId,
            userId: run.userId,
            runId: run.id,
            leaseOwner: run.leaseOwner,
            leaseFence: run.leaseFence,
          },
          { targetBotId: target.botId, taskIds: [target.id] },
        );
      } else {
        await tx.$queryRaw`SELECT id FROM threads WHERE id = ${run.threadId} FOR UPDATE`;
      }
      const active = await tx.run.findFirst({ where: activeTaskRunWhere(run) });
      if (!active) throw new IsolationError();
      return cancelCoordinatedTask(tx, target.id, reason || "Cancelled by the coordinating bot.");
    }),
  );
  if (cancelled)
    await Promise.all(
      cancelled.cancelledRunIds.map((id) => deps.jobs.cancel(runJobKey(id)).catch(() => undefined)),
    );
  if (cancelled) await reconcileTaskCleanup(deps, cancelled.cancelledRunIds);
  return { ok: true, taskId };
}
