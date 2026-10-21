import { randomUUID } from "node:crypto";
import { TASK_PROTOCOL } from "@rakazo/contracts";
import { afterAll, beforeAll, describe, expect, it, vi } from "vitest";
import type { PrismaClient, Run } from "./client.js";
import { createDb } from "./client.js";
import { finalizeRun } from "./events.js";
import { createGroupRepos } from "./groups.js";
import { provisionMessagingIdentity } from "./messaging.js";
import {
  cancelCoordinatedTask,
  coordinatedRootData,
  delegateTask,
  markTaskMessagesDelivered,
  reconcileTaskContinuations,
  sendTaskMessage,
  taskRunContext,
} from "./task-coordination.js";
import { claimThreadRun } from "./task-run-claim.js";

const postgres =
  process.env.VERIFY_DATABASE && process.env.DATABASE_URL ? describe.sequential : describe.skip;
postgres("group governance and durable child tasks", () => {
  let prisma: PrismaClient;
  let close: () => Promise<void>;
  const queryCounters: Array<() => number> = [];
  const queryCount = () => queryCounters.reduce((sum, count) => sum + count(), 0);
  let owner: { userId: string; spaceId: string; botId: string };
  const actor = () => ({ ...owner, email: "owner@example.test", isDeploymentOwner: false });
  beforeAll(async () => {
    const db = createDb(process.env.DATABASE_URL!);
    prisma = db.prisma;
    db.pool.on("connect", (client) => {
      const spy = vi.spyOn(client, "query");
      queryCounters.push(() => spy.mock.calls.length);
    });
    close = async () => {
      await prisma.$disconnect();
      await db.pool.end();
    };
    owner = await provisionMessagingIdentity(
      prisma,
      { provider: "sendblue", address: "+15550008892" },
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
  async function bot(managementRole = "member") {
    return prisma.bot.create({
      data: {
        spaceId: owner.spaceId,
        userId: owner.userId,
        name: randomUUID(),
        color: "blue",
        managementRole,
        thread: { create: { spaceId: owner.spaceId, userId: owner.userId } },
      },
    });
  }
  async function setup() {
    const chief = await bot("chief");
    const worker = await bot();
    const group = await createGroupRepos(prisma).createGroup(
      actor(),
      { name: "Project", botIds: [worker.id] },
      chief.id,
    );
    return { chief, worker, group };
  }
  async function start(runId: string) {
    const queued = await prisma.run.findUniqueOrThrow({ where: { id: runId } });
    expect(
      await claimThreadRun(prisma, queued.threadId, runId, {
        where: {
          id: runId,
          ...(queued.status === "leased"
            ? { status: "leased", leaseExpiresAt: { lte: new Date() } }
            : { status: "queued" }),
        },
        data: {
          status: "leased",
          leaseOwner: "test-worker",
          leaseFence: { increment: 1 },
          leaseExpiresAt: new Date(Date.now() + 60_000),
        },
      }),
    ).toEqual({ count: 1 });
    const run = await prisma.run.update({ where: { id: runId }, data: { status: "running" } });
    await prisma.attempt.create({ data: { runId, fence: run.leaseFence, status: "running" } });
    const context = await taskRunContext(prisma, run);
    await markTaskMessagesDelivered(prisma, run, context?.messageIds ?? []);
    return run;
  }
  async function root(group: { threadId: string }, botId: string) {
    const task = await prisma.task.create({
      data: {
        spaceId: owner.spaceId,
        userId: owner.userId,
        threadId: group.threadId,
        botId,
        status: "queued",
        prompt: "Deliver work",
        ...coordinatedRootData({ prompt: "Deliver work", ownerAuthorized: true }),
      },
    });
    const run = await prisma.run.create({
      data: {
        spaceId: owner.spaceId,
        userId: owner.userId,
        threadId: group.threadId,
        botId,
        taskId: task.id,
        trigger: "user",
        status: "queued",
      },
    });
    return start(run.id);
  }
  async function finish(run: Run) {
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
      outcome: "completed",
      blocks: [{ kind: "text", text: "Delivered" }],
    });
  }
  it("cancels 3000 overlapping tasks with bounded queries in the default transaction timeout", async () => {
    const { chief, worker, group } = await setup();
    const rootId = randomUUID();
    const scope = {
      spaceId: owner.spaceId,
      userId: owner.userId,
      threadId: group.threadId,
      protocol: TASK_PROTOCOL,
      prompt: "Work",
      status: "waiting_children",
    };
    await prisma.task.create({ data: { ...scope, id: rootId, botId: chief.id } });
    const children = Array.from({ length: 2999 }, () => ({
      ...scope,
      id: randomUUID(),
      botId: worker.id,
      rootTaskId: rootId,
      parentTaskId: rootId,
    }));
    await prisma.task.createMany({ data: children });
    await prisma.run.createMany({
      data: [{ id: rootId, botId: chief.id }, ...children].map((task) => ({
        spaceId: owner.spaceId,
        userId: owner.userId,
        threadId: group.threadId,
        botId: task.botId,
        taskId: task.id,
        trigger: "user",
        status: "queued",
      })),
    });
    await prisma.taskMessage.create({
      data: {
        taskId: rootId,
        fromTaskId: children[0]!.id,
        fromBotId: worker.id,
        fromBotName: "Worker",
        kind: "question",
        text: "Continue?",
        deliveryKey: randomUUID(),
      },
    });
    const before = queryCount();
    const startedAt = performance.now();
    await createGroupRepos(prisma).archiveGroup(actor(), group.id);
    const queries = queryCount() - before;
    const elapsedMs = performance.now() - startedAt;
    expect(queries).toBeGreaterThan(0);
    expect(queries).toBeLessThan(80);
    expect(
      await prisma.run.count({ where: { threadId: group.threadId, status: "cancelled" } }),
    ).toBe(3000);
    expect(
      await prisma.task.count({ where: { threadId: group.threadId, status: "cancelled" } }),
    ).toBe(3000);
    expect(
      await prisma.taskMessage.count({
        where: { taskId: rootId, kind: "question", answeredAt: null },
      }),
    ).toBe(0);
    process.stdout.write(
      `Group cancellation: 3000 tasks, ${queries} SQL calls, ${elapsedMs.toFixed(0)} ms\n`,
    );
  });

  it("still cleans up live descendants of an already terminal parent", async () => {
    const { chief, worker, group } = await setup();
    const parent = await root(group, chief.id);
    const child = await delegateTask(prisma, parent, {
      botId: worker.id,
      prompt: "Work",
      deliveryKey: randomUUID(),
    });
    await prisma.task.update({ where: { id: parent.taskId }, data: { status: "failed" } });
    await prisma.$transaction((tx) =>
      cancelCoordinatedTask(tx, parent.taskId, "Repair orphaned work"),
    );
    expect(await prisma.task.findUnique({ where: { id: child.taskId } })).toMatchObject({
      status: "cancelled",
    });
  });

  it("allows only one real claimant and recovers the remaining group work", async () => {
    const { chief, worker, group } = await setup();
    const other = await bot();
    await createGroupRepos(prisma).updateGroup(actor(), {
      groupId: group.id,
      botIds: [chief.id, worker.id, other.id],
    });
    const parent = await root(group, chief.id);
    const first = await delegateTask(prisma, parent, {
      botId: worker.id,
      prompt: "First",
      deliveryKey: randomUUID(),
    });
    const second = await delegateTask(prisma, parent, {
      botId: other.id,
      prompt: "Second",
      deliveryKey: randomUUID(),
    });
    const claim = (id: string) =>
      claimThreadRun(prisma, group.threadId, id, {
        where: { id, status: "queued" },
        data: {
          status: "leased",
          leaseOwner: "competing-worker",
          leaseFence: { increment: 1 },
          leaseExpiresAt: new Date(0),
        },
      });
    expect(await claim(first.runId!)).toEqual({ count: 0 });
    await finish(parent);
    const results = await Promise.all([claim(first.runId!), claim(second.runId!)]);
    expect(results.map((result) => result.count).sort()).toEqual([0, 1]);
    const leased = await prisma.run.findFirstOrThrow({
      where: { threadId: group.threadId, status: "leased" },
    });
    // Reclaim an expired lease through the production claim path with a new fence.
    const recovered = await start(leased.id);
    expect(recovered.leaseFence).toBeGreaterThan(leased.leaseFence);
    await finish(recovered);
    await finish(await start(leased.id === first.runId ? second.runId! : first.runId!));
    await Promise.all([
      reconcileTaskContinuations(prisma, 100, parent.taskId),
      reconcileTaskContinuations(prisma, 100, parent.taskId),
    ]);
    const continuations = await prisma.run.findMany({
      where: { taskId: parent.taskId, status: "queued" },
    });
    expect(continuations).toHaveLength(1);
    await finish(await start(continuations[0]!.id));
    expect(await prisma.task.findUnique({ where: { id: parent.taskId } })).toMatchObject({
      status: "completed",
    });
  });

  it("does not resurrect group tasks when recovery races with archive", async () => {
    const { chief, worker, group } = await setup();
    const parent = await root(group, chief.id);
    const child = await delegateTask(prisma, parent, {
      botId: worker.id,
      prompt: "Work",
      deliveryKey: randomUUID(),
    });
    await finish(parent);
    await finish(await start(child.runId!));
    await Promise.all([
      reconcileTaskContinuations(prisma, 100, parent.taskId),
      createGroupRepos(prisma).archiveGroup(actor(), group.id),
    ]);
    expect(await reconcileTaskContinuations(prisma, 100, parent.taskId)).toEqual([]);
    expect(
      await prisma.run.count({
        where: { threadId: group.threadId, status: { in: ["queued", "leased", "running"] } },
      }),
    ).toBe(0);
    expect(await prisma.task.findUnique({ where: { id: parent.taskId } })).toMatchObject({
      status: "cancelled",
    });
  });

  it("only permits a Chief creator, auto-joins them, and deduplicates concurrent retries", async () => {
    const chief = await bot("chief");
    const worker = await bot();
    const repos = createGroupRepos(prisma);
    await expect(
      repos.createGroup(actor(), { name: "No", botIds: [chief.id] }, worker.id),
    ).rejects.toThrow("Only a Chief");
    const key = randomUUID();
    const groups = await Promise.all(
      [1, 2].map(() =>
        repos.createGroup(actor(), { name: "Crew", botIds: [worker.id] }, chief.id, key),
      ),
    );
    expect(groups[0]!.id).toBe(groups[1]!.id);
    expect(groups[0]).toMatchObject({ adminBotId: chief.id, createdByBotId: chief.id });
    expect(groups[0]!.members.map((m) => m.botId)).toEqual([chief.id, worker.id]);
    await prisma.bot.update({ where: { id: chief.id }, data: { managementRole: "member" } });
    await expect(
      repos.createGroup(actor(), { name: "No", botIds: [worker.id] }, chief.id),
    ).rejects.toThrow("Only a Chief");
  });
  it("enforces group administration separately from Chief role and transfers it atomically", async () => {
    const { chief, worker, group } = await setup();
    const other = await bot("chief");
    const repos = createGroupRepos(prisma);
    await expect(
      repos.updateGroup(actor(), { groupId: group.id, name: "Hijack" }, other.id),
    ).rejects.toThrow("administrator");
    await expect(
      repos.updateGroup(actor(), { groupId: group.id, botIds: [worker.id, other.id] }, chief.id),
    ).rejects.toThrow("administrator");
    const moved = await repos.updateGroup(
      actor(),
      { groupId: group.id, botIds: [worker.id, other.id], adminBotId: worker.id },
      chief.id,
    );
    expect(moved.group.adminBotId).toBe(worker.id);
    await expect(
      repos.updateGroup(actor(), { groupId: group.id, name: "Old admin" }, chief.id),
    ).rejects.toThrow("administrator");
    expect(
      (await repos.updateGroup(actor(), { groupId: group.id, name: "Managed" }, worker.id)).group
        .name,
    ).toBe("Managed");
  });
  it("keeps children in the group, recovers parent results, and preserves task owner after admin transfer", async () => {
    const { chief, worker, group } = await setup();
    const parent = await root(group, chief.id);
    const key = randomUUID();
    const child = await delegateTask(prisma, parent, {
      botId: worker.id,
      prompt: "Build",
      deliveryKey: key,
    });
    expect(
      (await delegateTask(prisma, parent, { botId: worker.id, prompt: "Build", deliveryKey: key }))
        .taskId,
    ).toBe(child.taskId);
    expect(await prisma.task.findUnique({ where: { id: child.taskId } })).toMatchObject({
      threadId: group.threadId,
      parentTaskId: parent.taskId,
      ownerAuthorized: false,
    });
    await finish(parent);
    expect(await prisma.task.findUnique({ where: { id: parent.taskId } })).toMatchObject({
      status: "waiting_children",
    });
    await createGroupRepos(prisma).updateGroup(actor(), {
      groupId: group.id,
      adminBotId: worker.id,
    });
    const runningChild = await start(child.runId!);
    await sendTaskMessage(prisma, runningChild, {
      taskId: parent.taskId,
      kind: "status",
      text: "Building",
      deliveryKey: randomUUID(),
    });
    await finish(runningChild);
    // A fresh recovery scan, without an in-memory worker or successful enqueue.
    const recovered = await reconcileTaskContinuations(prisma);
    const continuation = await prisma.run.findFirstOrThrow({
      where: { taskId: parent.taskId, status: "queued" },
    });
    expect(recovered).toContain(continuation.id);
    expect(continuation.botId).toBe(chief.id);
    const resumed = await start(continuation.id);
    await finish(resumed);
    expect(await prisma.task.findUnique({ where: { id: parent.taskId } })).toMatchObject({
      status: "completed",
    });
  });
  it("starts group work from its administrator's private task and returns to the original conversation", async () => {
    const { chief, worker, group } = await setup();
    const privateThread = await prisma.thread.findUniqueOrThrow({ where: { botId: chief.id } });
    const parent = await root({ threadId: privateThread.id }, chief.id);
    const child = await delegateTask(prisma, parent, {
      botId: chief.id,
      destinationGroupId: group.id,
      prompt: "Coordinate the team",
      deliveryKey: randomUUID(),
    });
    await finish(parent);
    const groupRun = await start(child.runId!);
    const specialist = await delegateTask(prisma, groupRun, {
      botId: worker.id,
      prompt: "Build",
      deliveryKey: randomUUID(),
    });
    await finish(groupRun);
    await finish(await start(specialist.runId!));
    await reconcileTaskContinuations(prisma, 100, child.taskId);
    const groupContinuation = await prisma.run.findFirstOrThrow({
      where: { taskId: child.taskId, status: "queued" },
    });
    await finish(await start(groupContinuation.id));
    await reconcileTaskContinuations(prisma, 100, parent.taskId);
    const privateContinuation = await prisma.run.findFirstOrThrow({
      where: { taskId: parent.taskId, status: "queued" },
    });
    expect(privateContinuation.threadId).toBe(privateThread.id);
    await finish(await start(privateContinuation.id));
    expect(await prisma.task.findUnique({ where: { id: parent.taskId } })).toMatchObject({
      status: "completed",
    });
  });
  it("refuses nonmembers and cancels an idle departed member's task tree", async () => {
    const { chief, worker, group } = await setup();
    const outsider = await bot();
    const repos = createGroupRepos(prisma);
    const parent = await root(group, chief.id);
    await expect(
      delegateTask(prisma, parent, { botId: outsider.id, prompt: "No", deliveryKey: randomUUID() }),
    ).rejects.toThrow("current members");
    await repos.updateGroup(actor(), {
      groupId: group.id,
      botIds: [chief.id, worker.id, outsider.id],
    });
    const child = await delegateTask(prisma, parent, {
      botId: worker.id,
      prompt: "Build",
      deliveryKey: randomUUID(),
    });
    await finish(parent);
    const runningChild = await start(child.runId!);
    const grandchild = await delegateTask(prisma, runningChild, {
      botId: outsider.id,
      prompt: "Help",
      deliveryKey: randomUUID(),
    });
    await finish(runningChild);
    const removed = await repos.updateGroup(actor(), {
      groupId: group.id,
      botIds: [chief.id, outsider.id],
    });
    expect(removed.cancelledRunIds).toContain(grandchild.runId);
    expect(await prisma.task.findUnique({ where: { id: child.taskId } })).toMatchObject({
      status: "cancelled",
    });
    expect(await prisma.task.findUnique({ where: { id: grandchild.taskId } })).toMatchObject({
      status: "cancelled",
    });
    expect(
      await claimThreadRun(prisma, group.threadId, grandchild.runId!, {
        where: { id: grandchild.runId! },
        data: { status: "leased" },
      }),
    ).toEqual({ count: 0 });
  });
  it("serializes member removal against concurrent delegation", async () => {
    const { chief, worker, group } = await setup();
    const replacement = await bot();
    const parent = await root(group, chief.id);
    const results = await Promise.allSettled([
      delegateTask(prisma, parent, {
        botId: worker.id,
        prompt: "Build",
        deliveryKey: randomUUID(),
      }),
      createGroupRepos(prisma).updateGroup(actor(), {
        groupId: group.id,
        botIds: [chief.id, replacement.id],
      }),
    ]);
    expect(results[1]!.status).toBe("fulfilled");
    expect(
      await prisma.task.count({
        where: {
          threadId: group.threadId,
          botId: worker.id,
          status: { notIn: ["completed", "cancelled", "failed"] },
        },
      }),
    ).toBe(0);
  });

  it("keeps user-created legacy routing and cancels waiting tasks on archive", async () => {
    const { chief, worker, group } = await setup();
    const repos = createGroupRepos(prisma);
    const legacy = await repos.createGroup(actor(), {
      name: "Legacy",
      botIds: [worker.id, chief.id],
    });
    expect(legacy.adminBotId).toBeNull();
    const parent = await root(group, chief.id);
    const child = await delegateTask(prisma, parent, {
      botId: worker.id,
      prompt: "Build",
      deliveryKey: randomUUID(),
    });
    await finish(parent);
    await repos.archiveGroup(actor(), group.id);
    expect(await prisma.task.findUnique({ where: { id: parent.taskId } })).toMatchObject({
      status: "cancelled",
    });
    expect(await prisma.task.findUnique({ where: { id: child.taskId } })).toMatchObject({
      status: "cancelled",
    });
    expect(await reconcileTaskContinuations(prisma, 100, parent.taskId)).toEqual([]);
  });
});
