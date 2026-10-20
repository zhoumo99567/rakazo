import { randomUUID } from "node:crypto";
import { TASK_PROTOCOL } from "@rakazo/contracts";
import { afterAll, beforeAll, beforeEach, describe, expect, it } from "vitest";
import { commitBotUpdate } from "./bot-update.js";
import type { PrismaClient, Run } from "./client.js";
import { createDb } from "./client.js";
import { clearThread, finalizeRun, pauseRunForInput } from "./events.js";
import { loadRunHistoryMessages } from "./messages.js";
import { provisionMessagingIdentity } from "./messaging.js";
import {
  cancelCoordinatedTask,
  coordinatedRootData,
  delegateTask,
  reconcileTaskContinuations,
  sendTaskMessage,
  taskRunContext,
} from "./task-coordination.js";
import { cancelOwnedTask, listOwnedTasks } from "./task-management.js";

const databaseUrl = process.env.DATABASE_URL;
const postgres = process.env.VERIFY_DATABASE && databaseUrl ? describe.sequential : describe.skip;

postgres("durable bot coordination", () => {
  let prisma: PrismaClient;
  let close: () => Promise<void>;
  let owner: { userId: string; spaceId: string; botId: string };
  let chief: { id: string; threadId: string };
  let worker: { id: string; threadId: string };
  const address = "+15550007771";

  beforeAll(async () => {
    const db = createDb(databaseUrl!);
    prisma = db.prisma;
    close = async () => {
      await prisma.$disconnect();
      await db.pool.end();
    };
    owner = await provisionMessagingIdentity(
      prisma,
      { provider: "sendblue", address },
      { signupsEnabled: undefined, signupAllowlist: undefined },
    );
  });

  beforeEach(async () => {
    await prisma.bot.deleteMany({ where: { spaceId: owner.spaceId, id: { not: owner.botId } } });
    chief = await bot("Chief", "chief");
    worker = await bot("Worker");
  });

  afterAll(async () => {
    if (owner) {
      const space = await prisma.space.findUniqueOrThrow({ where: { id: owner.spaceId } });
      await prisma.organization.delete({ where: { id: space.organizationId } });
      await prisma.user.delete({ where: { id: owner.userId } });
    }
    await close?.();
  });

  async function bot(name: string, managementRole = "member", spaceId = owner.spaceId) {
    const row = await prisma.bot.create({
      data: { spaceId, userId: owner.userId, name, color: "blue", managementRole },
    });
    const thread = await prisma.thread.create({
      data: { spaceId, userId: owner.userId, botId: row.id },
    });
    return { id: row.id, threadId: thread.id };
  }

  async function root(target = chief, protocol = TASK_PROTOCOL as string) {
    const task = await prisma.task.create({
      data: {
        spaceId: owner.spaceId,
        userId: owner.userId,
        botId: target.id,
        threadId: target.threadId,
        prompt: "Deliver a report",
        status: "queued",
        ...(protocol === TASK_PROTOCOL
          ? coordinatedRootData({ prompt: "Deliver a report", ownerAuthorized: true })
          : {}),
      },
    });
    const queued = await prisma.run.create({
      data: {
        spaceId: owner.spaceId,
        userId: owner.userId,
        botId: target.id,
        threadId: target.threadId,
        taskId: task.id,
        trigger: "user",
        status: "queued",
      },
    });
    return start(queued.id);
  }

  async function start(id: string) {
    const run = await prisma.run.update({
      where: { id },
      data: { status: "running", leaseOwner: "test-worker", leaseFence: { increment: 1 } },
    });
    await prisma.attempt.create({
      data: { runId: id, fence: run.leaseFence, status: "running" },
    });
    if (
      (await prisma.task.findUniqueOrThrow({ where: { id: run.taskId } })).protocol ===
      TASK_PROTOCOL
    ) {
      // Pass a complete Prisma Run: extra timestamps must never become query predicates.
      const fullRun = { ...run, updatedAt: new Date(0), startedAt: null };
      await taskRunContext(prisma, fullRun);
    }
    return run;
  }

  async function finish(run: Run, outcome: "completed" | "failed" = "completed") {
    const attempt = await prisma.attempt.findFirstOrThrow({
      where: { runId: run.id, fence: run.leaseFence },
    });
    return finalizeRun(prisma, {
      spaceId: run.spaceId,
      threadId: run.threadId,
      botId: run.botId,
      runId: run.id,
      taskId: run.taskId,
      taskProtocol: TASK_PROTOCOL,
      attemptId: attempt.id,
      leaseOwner: run.leaseOwner!,
      leaseFence: run.leaseFence,
      ...(outcome === "completed"
        ? { outcome, blocks: [{ kind: "text", text: "Report delivered." }] }
        : { outcome, error: "Source unavailable." }),
    });
  }

  async function delegate(run: Run, key = randomUUID(), target = worker) {
    return delegateTask(prisma, run, {
      botId: target.id,
      prompt: "Find evidence",
      deliveryKey: key,
    });
  }

  it("creates one child on concurrent replay and preserves the parent owner", async () => {
    const parent = await root();
    const key = randomUUID();
    const [one, two] = await Promise.all([delegate(parent, key), delegate(parent, key)]);
    expect(one.taskId).toBe(two.taskId);
    expect(await prisma.task.count({ where: { parentTaskId: parent.taskId } })).toBe(1);
    expect(await prisma.task.findUnique({ where: { id: parent.taskId } })).toMatchObject({
      botId: chief.id,
      originalPrompt: "Deliver a report",
    });
    expect(await prisma.task.findUnique({ where: { id: one.taskId } })).toMatchObject({
      ownerAuthorized: false,
      parentTaskId: parent.taskId,
      rootTaskId: parent.taskId,
    });
    expect(await finish(parent)).toMatchObject({ taskCompleted: false });
    expect(await prisma.task.findUnique({ where: { id: parent.taskId } })).toMatchObject({
      status: "waiting_children",
    });
  });

  it("completes a delegation chain longer than the legacy hop limit", async () => {
    const runs = [await root(worker)];
    for (let i = 0; i < 8; i++) {
      const target = await bot(`Nested ${i}`);
      const parent = runs.at(-1)!;
      const delegated = await delegate(parent, randomUUID(), target);
      await finish(parent);
      runs.push(await start(delegated.runId!));
    }
    await finish(runs.pop()!);
    for (const parent of runs.reverse()) {
      const continuations = await reconcileTaskContinuations(prisma);
      expect(continuations).toHaveLength(1);
      const continued = await start(continuations[0]!);
      expect(continued.taskId).toBe(parent.taskId);
      await finish(continued);
    }
    expect(
      await prisma.task.count({
        where: {
          spaceId: owner.spaceId,
          status: { in: ["waiting_children", "running", "queued"] },
          botId: { not: owner.botId },
        },
      }),
    ).toBe(0);
  });

  it("scopes task lists and rejects cancellation and cursors from another space or owner", async () => {
    const run = await root();
    const actor = { ...owner, email: "owner@example.com", isDeploymentOwner: false };
    const foreignSpace = { ...actor, spaceId: "another-space" };
    const foreignUser = { ...actor, userId: "another-owner" };
    expect((await listOwnedTasks(prisma, actor, { botId: chief.id })).tasks).toHaveLength(1);
    for (const other of [foreignSpace, foreignUser]) {
      expect((await listOwnedTasks(prisma, other, { botId: chief.id })).tasks).toEqual([]);
      await expect(listOwnedTasks(prisma, other, { cursor: run.taskId })).rejects.toThrow();
      await expect(cancelOwnedTask(prisma, other, run.taskId)).rejects.toThrow();
    }
    expect(await prisma.task.findUnique({ where: { id: run.taskId } })).toMatchObject({
      status: "running",
    });
  });

  it("serializes a child asking the owner against parent cancellation", async () => {
    const parent = await root();
    const delegated = await delegate(parent);
    const child = await start(delegated.runId!);
    const attempt = await prisma.attempt.findFirstOrThrow({ where: { runId: child.id } });
    await Promise.all([
      pauseRunForInput(prisma, {
        spaceId: child.spaceId,
        threadId: child.threadId,
        botId: child.botId,
        runId: child.id,
        attemptId: attempt.id,
        leaseOwner: child.leaseOwner!,
        leaseFence: child.leaseFence,
        blocks: [{ kind: "text", text: "Need a decision" }],
      }),
      prisma.$transaction((tx) => cancelCoordinatedTask(tx, parent.taskId, "Stop")),
    ]);
    expect(await prisma.run.findUnique({ where: { id: child.id } })).toMatchObject({
      status: "cancelled",
    });
    expect(await prisma.task.findUnique({ where: { id: child.taskId } })).toMatchObject({
      status: "cancelled",
    });
    expect(await reconcileTaskContinuations(prisma)).toEqual([]);
  });

  it("merges concurrent child results into one continuation of the same task", async () => {
    const parent = await root();
    const a = await delegate(parent);
    const other = await bot("Other");
    const b = await delegate(parent, randomUUID(), other);
    await finish(parent);
    const first = await start(a.runId!);
    const second = await start(b.runId!);
    await Promise.all([finish(first), finish(second)]);
    const [one, two] = await Promise.all([
      reconcileTaskContinuations(prisma),
      reconcileTaskContinuations(prisma),
    ]);
    const continuationIds = [...one, ...two];
    expect(continuationIds).toHaveLength(1);
    const resumed = await start(continuationIds[0]!);
    expect(resumed.taskId).toBe(parent.taskId);
    const context = await taskRunContext(prisma, resumed);
    expect(context?.text).toContain(a.taskId);
    expect(context?.text).toContain(b.taskId);
    expect(await finish(resumed)).toMatchObject({ taskCompleted: true });
    expect(await reconcileTaskContinuations(prisma)).toEqual([]);
    expect(
      await prisma.taskMessage.count({ where: { taskId: parent.taskId, kind: "outcome" } }),
    ).toBe(2);
  });

  it("does not lose a result arriving while the parent continuation is running", async () => {
    const parent = await root();
    const a = await delegate(parent);
    const b = await delegate(parent);
    await finish(parent);
    await finish(await start(a.runId!));
    const [next] = await reconcileTaskContinuations(prisma);
    const resumed = await start(next!);
    await finish(await start(b.runId!));
    expect(await reconcileTaskContinuations(prisma)).toEqual([]);
    const result = await finish(resumed);
    expect(result).toMatchObject({ taskCompleted: false });
    if (result === false) throw new Error("Expected finalized run");
    expect(result.continuationRunId).toBeTruthy();
    if (!result.continuationRunId) throw new Error("Expected continuation");
    const last = await start(result.continuationRunId);
    expect((await taskRunContext(prisma, last))?.text).toContain(b.taskId);
    expect(await finish(last)).toMatchObject({ taskCompleted: true });
  });

  it("keeps unanswered questions visible and supports more than six exchanges", async () => {
    const parent = await root();
    const child = await delegate(parent);
    const runningChild = await start(child.runId!);
    for (let index = 0; index < 8; index++) {
      const question = await sendTaskMessage(prisma, runningChild, {
        taskId: parent.taskId,
        kind: "question",
        text: `Question ${index}`,
        deliveryKey: randomUUID(),
      });
      await taskRunContext(prisma, parent);
      await sendTaskMessage(prisma, parent, {
        taskId: child.taskId,
        kind: "result",
        text: "Answer",
        replyToId: question.id,
        deliveryKey: randomUUID(),
      });
    }
    const pending = await sendTaskMessage(prisma, runningChild, {
      taskId: parent.taskId,
      kind: "question",
      text: "Still unanswered",
      deliveryKey: randomUUID(),
    });
    await taskRunContext(prisma, parent);
    const awaitingAnswer = await finish(parent);
    expect(await prisma.taskMessage.findUnique({ where: { id: pending.id } })).toMatchObject({
      answeredAt: null,
    });
    // An unanswered incoming question resumes without needing another child update.
    if (awaitingAnswer === false) throw new Error("Expected finalized run");
    if (!awaitingAnswer.continuationRunId) throw new Error("Expected question continuation");
    const resumed = await start(awaitingAnswer.continuationRunId);
    expect((await taskRunContext(prisma, resumed))?.text).toContain("Still unanswered");
    await finish(runningChild, "failed");
    expect(await prisma.taskMessage.findUnique({ where: { id: pending.id } })).toMatchObject({
      answeredAt: expect.any(Date),
    });
  });

  it("rejects legacy tasks, stale leases, cross-space targets and delegation cycles", async () => {
    const parent = await root();
    await expect(delegate({ ...parent, leaseFence: parent.leaseFence - 1 })).rejects.toThrow();
    const child = await delegate(parent);
    await expect(delegate(await start(child.runId!), randomUUID(), chief)).rejects.toThrow(
      /waiting/,
    );
    const legacyBot = await bot("Legacy");
    await expect(delegate(await root(legacyBot, "legacy"))).rejects.toThrow();
    const original = await prisma.space.findUniqueOrThrow({ where: { id: owner.spaceId } });
    const space = await prisma.space.create({
      data: { id: randomUUID(), organizationId: original.organizationId, name: "Separate" },
    });
    const outside = await bot("Outside", "member", space.id);
    await expect(delegate(parent, randomUUID(), outside)).rejects.toThrow();
    await prisma.space.delete({ where: { id: space.id } });
  });

  it("cancels the whole subtree while leaving unrelated tasks on the same bot alone", async () => {
    const parent = await root();
    const child = await delegate(parent);
    const unrelated = await root(worker);
    await finish(parent);
    await prisma.$transaction(async (tx) => {
      await tx.$queryRaw`SELECT id FROM threads WHERE id = ${parent.threadId} FOR UPDATE`;
      await cancelCoordinatedTask(tx, parent.taskId, "Stopped");
    });
    expect(await prisma.task.findUnique({ where: { id: child.taskId } })).toMatchObject({
      status: "cancelled",
    });
    expect(await prisma.run.findUnique({ where: { id: unrelated.id } })).toMatchObject({
      status: "running",
    });
    expect(await reconcileTaskContinuations(prisma)).toEqual([]);
  });

  it("clearThread cancels waiting tasks that have no active run", async () => {
    const parent = await root();
    const child = await delegate(parent);
    await finish(parent);
    await clearThread(prisma, {
      spaceId: owner.spaceId,
      botId: chief.id,
      threadId: chief.threadId,
    });
    expect(await prisma.task.findUnique({ where: { id: child.taskId } })).toMatchObject({
      status: "cancelled",
    });
    expect(await reconcileTaskContinuations(prisma)).toEqual([]);
  });

  it("retains artifacts from early stages and copies child references to the parent", async () => {
    const parent = await root();
    const child = await delegate(parent);
    const artifact = await prisma.artifact.create({
      data: {
        spaceId: owner.spaceId,
        userId: owner.userId,
        botId: chief.id,
        runId: parent.id,
        name: "draft.txt",
        mimeType: "text/plain",
        size: 1,
        hash: "test",
        storageKey: "test/draft",
      },
    });
    await finish(parent);
    expect(
      await prisma.taskArtifact.findUnique({
        where: { taskId_artifactId: { taskId: parent.taskId, artifactId: artifact.id } },
      }),
    ).toBeTruthy();
    const childRun = await start(child.runId!);
    const output = await prisma.artifact.create({
      data: {
        spaceId: owner.spaceId,
        userId: owner.userId,
        botId: worker.id,
        runId: childRun.id,
        name: "evidence.txt",
        mimeType: "text/plain",
        size: 1,
        hash: "test-child",
        storageKey: "test/evidence",
      },
    });
    await finish(childRun);
    expect(
      await prisma.taskArtifact.findUnique({
        where: { taskId_artifactId: { taskId: parent.taskId, artifactId: output.id } },
      }),
    ).toBeTruthy();
  });

  it("allows multiple Chiefs, but enforces current role and task authorization at the write", async () => {
    const anotherChief = await bot("Second Chief", "chief");
    const run = await root();
    const update = (botId: string, threadId: string, managerRun = run) =>
      commitBotUpdate({
        prisma,
        spaceId: owner.spaceId,
        botId,
        threadId,
        emitBotUpdated: true,
        notify: async () => undefined,
        data: { title: "Updated" },
        manager: {
          botId: managerRun.botId,
          userId: owner.userId,
          runId: managerRun.id,
          leaseOwner: managerRun.leaseOwner,
          leaseFence: managerRun.leaseFence,
        },
      });
    await expect(update(worker.id, worker.threadId)).resolves.toMatchObject({ title: "Updated" });
    await expect(update(anotherChief.id, anotherChief.threadId)).rejects.toThrow();
    const delegated = await delegate(run, randomUUID(), anotherChief);
    await expect(
      update(worker.id, worker.threadId, await start(delegated.runId!)),
    ).rejects.toThrow();
    await prisma.task.update({ where: { id: run.taskId }, data: { externalInfluence: true } });
    await expect(update(worker.id, worker.threadId)).rejects.toThrow();
    await prisma.task.update({ where: { id: run.taskId }, data: { externalInfluence: false } });
    await prisma.bot.update({ where: { id: chief.id }, data: { managementRole: "member" } });
    await expect(update(worker.id, worker.threadId)).rejects.toThrow();
    // No invariant requires any Chief, or permits only one Chief, in a space.
    await prisma.bot.update({ where: { id: anotherChief.id }, data: { managementRole: "member" } });
    expect(
      await prisma.bot.count({ where: { spaceId: owner.spaceId, managementRole: "chief" } }),
    ).toBe(0);
  });
  it("retains ordinary conversation history while isolating work delegated by another bot", async () => {
    const earlier = await root(worker);
    await finish(earlier);
    const parent = await root();
    const delegated = await delegate(parent);
    const child = await start(delegated.runId!);
    await finish(child);
    const current = await root(worker);
    const messages = [
      { id: randomUUID(), seq: 0, role: "user", runId: null },
      { id: randomUUID(), seq: 1, role: "bot", runId: earlier.id },
      { id: randomUUID(), seq: 2, role: "bot", runId: child.id },
      { id: randomUUID(), seq: 3, role: "user", runId: current.id },
      { id: randomUUID(), seq: 4, role: "bot", runId: current.id },
      { id: randomUUID(), seq: 5, role: "user", runId: null },
    ];
    // Finalization already emitted messages, so use a separate monotonically increasing range.
    await prisma.message.deleteMany({ where: { threadId: worker.threadId } });
    await prisma.message.createMany({
      data: messages.map((row) => ({
        ...row,
        threadId: worker.threadId,
        botId: row.role === "bot" ? worker.id : null,
        blocks: [{ kind: "text", text: row.id }],
      })),
    });
    const history = await loadRunHistoryMessages(
      prisma,
      { ...current, sourceMessageId: messages[3]!.id },
      40,
      undefined,
      current.taskId,
      true,
    );
    expect(history.map((message) => message.id).sort()).toEqual(
      [0, 1, 3, 4].map((index) => messages[index]!.id).sort(),
    );
    const childHistory = await loadRunHistoryMessages(prisma, child, 40, undefined, child.taskId);
    expect(childHistory.map((message) => message.id)).toEqual([messages[2]!.id]);
  });
});
