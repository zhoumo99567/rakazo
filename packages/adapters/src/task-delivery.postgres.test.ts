import { randomUUID } from "node:crypto";
import type {
  AgentHomeStore,
  JobPublisher,
  NotificationProvider,
  SandboxProvider,
} from "@rakazo/adapter-kit";
import { TASK_PROTOCOL } from "@rakazo/contracts";
import type { PrismaClient } from "@rakazo/db";
import {
  cancelCoordinatedTask,
  computerScopeKey,
  createDb,
  expireStuckRun,
  provisionMessagingIdentity,
  restoreBotUnderComputerQuota,
} from "@rakazo/db";
import { afterAll, beforeAll, describe, expect, it, vi } from "vitest";
import { destroyBot } from "./child-bots.js";
import { acquireComputerExecutionLease } from "./computer-lifecycle.js";
import { reconcileTaskCleanup } from "./task-cleanup.js";
import { deliverTaskNotification, reconcileTaskNotifications } from "./task-notifications.js";

const postgres =
  process.env.VERIFY_DATABASE && process.env.DATABASE_URL ? describe.sequential : describe.skip;

postgres("task delivery and physical cancellation", () => {
  let prisma: PrismaClient;
  let close: () => Promise<void>;
  let owner: { userId: string; spaceId: string; botId: string };
  beforeAll(async () => {
    const db = createDb(process.env.DATABASE_URL!);
    prisma = db.prisma;
    close = async () => {
      await prisma.$disconnect();
      await db.pool.end();
    };
    owner = await provisionMessagingIdentity(
      prisma,
      { provider: "sendblue", address: "+15550007772" },
      { signupsEnabled: undefined, signupAllowlist: undefined },
    );
  });
  afterAll(async () => {
    if (owner) {
      const space = await prisma.space.findUniqueOrThrow({ where: { id: owner.spaceId } });
      await prisma.organization.delete({ where: { id: space.organizationId } });
      await prisma.user.delete({ where: { id: owner.userId } });
    }
    await close?.();
  });
  async function task(status = "running", parentTaskId?: string) {
    const bot = await prisma.bot.create({
      data: {
        spaceId: owner.spaceId,
        userId: owner.userId,
        name: "Worker",
        color: "blue",
        notifyOnFinish: true,
      },
    });
    const thread = await prisma.thread.create({
      data: { spaceId: owner.spaceId, userId: owner.userId, botId: bot.id },
    });
    const task = await prisma.task.create({
      data: {
        spaceId: owner.spaceId,
        userId: owner.userId,
        botId: bot.id,
        threadId: thread.id,
        protocol: TASK_PROTOCOL,
        parentTaskId,
        rootTaskId: parentTaskId,
        prompt: "Produce evidence",
        status,
        result: status === "completed" ? { text: "Report delivered." } : undefined,
        completedAt: status === "completed" ? new Date() : undefined,
      },
    });
    return { task, bot, thread };
  }

  it("recovers a final notification after a failed send and deduplicates concurrent delivery", async () => {
    const root = await task("completed");
    const send = vi.fn().mockRejectedValueOnce(new Error("offline")).mockResolvedValue(undefined);
    const deps = { prisma, notifications: { send } as unknown as NotificationProvider };
    await expect(deliverTaskNotification(deps, root.task.id)).rejects.toThrow("offline");
    expect(
      (await prisma.task.findUniqueOrThrow({ where: { id: root.task.id } }))
        .notificationDeliveredAt,
    ).toBeNull();
    await prisma.task.update({
      where: { id: root.task.id },
      data: { notificationLeaseUntil: new Date(0) },
    });
    await Promise.all([
      reconcileTaskNotifications(deps),
      deliverTaskNotification(deps, root.task.id),
    ]);
    expect(send).toHaveBeenCalledTimes(2);
    expect(send.mock.calls[0]?.[1].operationId).toBe(send.mock.calls[1]?.[1].operationId);
    await reconcileTaskNotifications(deps);
    expect(send).toHaveBeenCalledTimes(2);
    const child = await task("completed");
    await prisma.task.update({
      where: { id: child.task.id },
      data: { delegatedByRunId: "deleted-parent-run" },
    });
    const waiting = await task("waiting_children");
    await deliverTaskNotification(deps, child.task.id);
    await deliverTaskNotification(deps, waiting.task.id);
    expect(send).toHaveBeenCalledTimes(2);
  });

  it.each(["cancel", "expire"] as const)(
    "keeps a run fenced through %s and physical cleanup retry",
    async (method) => {
      const work = await task();
      const run = await prisma.run.create({
        data: {
          spaceId: owner.spaceId,
          userId: owner.userId,
          botId: work.bot.id,
          threadId: work.thread.id,
          taskId: work.task.id,
          trigger: "user",
          status: method === "expire" ? "waiting_input" : "running",
        },
      });
      const computer = await prisma.computer.create({
        data: {
          spaceId: owner.spaceId,
          userId: owner.userId,
          scope: "team",
          scopeKey: randomUUID(),
          homeKey: randomUUID(),
          kind: "docker",
          providerRef: "fake-provider",
          state: "running",
        },
      });
      await prisma.computerExecutionLease.create({
        data: {
          computerId: computer.id,
          botId: work.bot.id,
          runId: run.id,
          fence: 4,
          expiresAt: new Date(Date.now() + 60_000),
        },
      });
      if (method === "expire") {
        await prisma.$transaction((tx) =>
          expireStuckRun(tx, {
            runId: run.id,
            threadId: run.threadId,
            status: "waiting_input",
            updatedAt: run.updatedAt,
            now: new Date(),
          }),
        );
      } else {
        await prisma.$transaction((tx) => cancelCoordinatedTask(tx, work.task.id, "Stop"));
      }
      const lease = await prisma.computerExecutionLease.findFirstOrThrow({
        where: { runId: run.id },
      });
      expect(lease.expiresAt.getTime()).toBeGreaterThan(Date.now());
      const cancelRunWork = vi
        .fn()
        .mockRejectedValueOnce(new Error("offline"))
        .mockResolvedValue(undefined);
      const releaseScreen = vi.fn().mockResolvedValue(undefined);
      const deps = {
        prisma,
        sandbox: { cancelRunWork, releaseScreen } as unknown as SandboxProvider,
      };
      await reconcileTaskCleanup(deps, [run.id]);
      expect(releaseScreen).not.toHaveBeenCalled();
      // Even an old worker's finally-release cannot make the pending screen reusable.
      await prisma.computerExecutionLease.updateMany({
        where: { runId: run.id },
        data: { expiresAt: new Date(0) },
      });
      await expect(
        acquireComputerExecutionLease(prisma, {
          computerId: computer.id,
          botId: work.bot.id,
          runId: "replacement",
        }),
      ).rejects.toThrow();
      await prisma.taskRunCleanup.updateMany({
        where: { runId: run.id },
        data: { claimedUntil: new Date(0) },
      });
      await reconcileTaskCleanup(deps, [run.id]);
      expect(cancelRunWork).toHaveBeenCalledTimes(2);
      expect(releaseScreen).toHaveBeenCalledOnce();
      expect(
        (await prisma.taskRunCleanup.findFirstOrThrow({ where: { runId: run.id } })).completedAt,
      ).not.toBeNull();
      expect(
        await acquireComputerExecutionLease(prisma, {
          computerId: computer.id,
          botId: work.bot.id,
          runId: "replacement",
        }),
      ).toMatchObject({ fence: 5 });
      await reconcileTaskCleanup(deps, [run.id]);
      expect(cancelRunWork).toHaveBeenCalledTimes(2);
    },
  );

  it("does not restore a bot while its archive cleanup can still stop the computer", async () => {
    const work = await task();
    await prisma.bot.update({
      where: { id: work.bot.id },
      data: { archivedAt: new Date(), archiveCleanupPending: true },
    });
    await expect(
      restoreBotUnderComputerQuota(prisma, {
        botId: work.bot.id,
        userId: owner.userId,
        computerId: "unused",
      }),
    ).rejects.toThrow();
    await prisma.bot.update({ where: { id: work.bot.id }, data: { archiveCleanupPending: false } });
    await restoreBotUnderComputerQuota(prisma, {
      botId: work.bot.id,
      userId: owner.userId,
      computerId: "unused",
    });
    expect(
      (await prisma.bot.findUniqueOrThrow({ where: { id: work.bot.id } })).archivedAt,
    ).toBeNull();
  });

  it("delivers cancellation to the parent even when deleting the child's computer fails", async () => {
    const parent = await task("waiting_children");
    const child = await task("running", parent.task.id);
    const run = await prisma.run.create({
      data: {
        spaceId: owner.spaceId,
        userId: owner.userId,
        botId: child.bot.id,
        threadId: child.thread.id,
        taskId: child.task.id,
        trigger: "task_delegation",
        status: "running",
      },
    });
    const computer = await prisma.computer.create({
      data: {
        spaceId: owner.spaceId,
        userId: owner.userId,
        scope: "dedicated",
        scopeKey: computerScopeKey("dedicated", owner.spaceId, child.bot.id),
        homeKey: randomUUID(),
        kind: "docker",
        providerRef: "fake-provider",
        state: "running",
      },
    });
    await prisma.computerExecutionLease.create({
      data: {
        computerId: computer.id,
        botId: child.bot.id,
        runId: run.id,
        fence: 1,
        expiresAt: new Date(Date.now() + 60_000),
      },
    });
    const sandbox = {
      cancelRunWork: vi.fn(async () => {
        throw new Error("offline");
      }),
      destroy: vi.fn(async () => {
        throw new Error("destroy unavailable");
      }),
      releaseScreen: vi.fn(),
    } as unknown as SandboxProvider;
    await expect(
      destroyBot(
        {
          prisma,
          sandbox,
          home: {} as AgentHomeStore,
          jobs: { cancel: vi.fn() } as unknown as JobPublisher,
        },
        child.bot,
        {
          operationId: "delete-test",
          traceId: "delete-test",
          spaceId: owner.spaceId,
          userId: owner.userId,
          signal: new AbortController().signal,
        },
        { deleteMemories: true },
      ),
    ).rejects.toThrow("destroy unavailable");
    expect(await prisma.task.findUnique({ where: { id: child.task.id } })).toMatchObject({
      status: "cancelled",
    });
    expect(
      await prisma.taskMessage.count({
        where: { taskId: parent.task.id, fromTaskId: child.task.id },
      }),
    ).toBe(1);
    expect(await prisma.taskRunCleanup.findFirst({ where: { runId: run.id } })).toMatchObject({
      completedAt: null,
    });
    expect(await prisma.bot.findUnique({ where: { id: child.bot.id } })).not.toBeNull();
  });
});
