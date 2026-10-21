import { randomUUID } from "node:crypto";
import type { CommandOperationSnapshot } from "@rakazo/adapter-kit";
import type { PrismaClient } from "@rakazo/db";
import { createDb, loadTaskExecutions, provisionMessagingIdentity } from "@rakazo/db";
import { afterAll, beforeAll, beforeEach, describe, expect, it } from "vitest";
import { saveShellOperationSnapshot } from "./shell-operations.js";

const postgres =
  process.env.VERIFY_DATABASE && process.env.DATABASE_URL ? describe.sequential : describe.skip;
postgres("durable command result delivery", () => {
  const db = createDb(process.env.DATABASE_URL ?? "postgresql://unused");
  const prisma = db.prisma;
  let owner: { userId: string; spaceId: string; botId: string };
  let run: {
    id: string;
    threadId: string;
    botId: string;
    spaceId: string;
    leaseOwner: string;
    leaseFence: number;
  };
  let taskId: string;
  let effectId: string;
  const completed: CommandOperationSnapshot = {
    state: "completed",
    stdout: "verified result",
    stderr: "",
    code: 0,
    observedAt: new Date().toISOString(),
  };
  const operation = () => ({
    version: 1 as const,
    id: effectId,
    computer: {
      id: "test-computer",
      botId: owner.botId,
      providerRef: "test-computer",
      kind: "docker" as const,
    },
  });
  const save = (snapshot = completed, client = prisma) =>
    saveShellOperationSnapshot({
      prisma: client,
      run,
      operation: operation(),
      snapshot,
      secrets: [],
    });
  beforeAll(async () => {
    const identity = await provisionMessagingIdentity(
      prisma,
      { provider: "sendblue", address: "+15550008991" },
      { signupsEnabled: undefined, signupAllowlist: undefined },
    );
    owner = { userId: identity.userId, spaceId: identity.spaceId, botId: identity.botId };
  });
  beforeEach(async () => {
    const thread = await prisma.thread.findFirstOrThrow({ where: { botId: owner.botId } });
    const task = await prisma.task.create({
      data: {
        ...owner,
        threadId: thread.id,
        status: "running",
        prompt: "Verify a long operation",
        protocol: "coordination_v1",
      },
    });
    taskId = task.id;
    const row = await prisma.run.create({
      data: {
        ...owner,
        threadId: thread.id,
        taskId,
        status: "running",
        trigger: "user",
        leaseOwner: "worker",
        leaseFence: 1,
        leaseExpiresAt: new Date(Date.now() + 300_000),
      },
    });
    run = { ...row, leaseOwner: "worker" };
    const effect = await prisma.externalEffect.create({
      data: {
        spaceId: owner.spaceId,
        runId: run.id,
        kind: "shell",
        status: "executing",
        idempotencyKey: randomUUID(),
        request: { command: "test" },
      },
    });
    effectId = effect.id;
  });
  afterAll(async () => {
    if (owner) {
      const space = await prisma.space.findUniqueOrThrow({ where: { id: owner.spaceId } });
      await prisma.organization.delete({ where: { id: space.organizationId } });
      await prisma.user.delete({ where: { id: owner.userId } });
    }
    await prisma.$disconnect();
    await db.pool.end();
  });

  it("commits one result message under concurrent completion retries", async () => {
    await Promise.all([save(), save(), save()]);
    expect(await prisma.message.count({ where: { clientNonce: `shell-result:${effectId}` } })).toBe(
      1,
    );
    expect(
      (await prisma.externalEffect.findUniqueOrThrow({ where: { id: effectId } })).status,
    ).toBe("completed");
    expect(
      (await prisma.task.findUniqueOrThrow({ where: { id: taskId } })).lastProgressAt,
    ).toBeNull();
  });

  it("rolls back result completion when durable message delivery fails, then retries once", async () => {
    const failing = new Proxy(prisma, {
      get(target, key) {
        if (key !== "$transaction") return Reflect.get(target, key);
        return (work: (tx: unknown) => Promise<unknown>) =>
          prisma.$transaction(async (tx) =>
            work(
              new Proxy(tx, {
                get(inner, field) {
                  if (field !== "message") return Reflect.get(inner, field);
                  return {
                    ...tx.message,
                    create: async () => {
                      throw new Error("injected message write failure");
                    },
                  };
                },
              }),
            ),
          );
      },
    }) as PrismaClient;
    await expect(save(completed, failing)).rejects.toThrow("injected message write failure");
    expect(
      (await prisma.externalEffect.findUniqueOrThrow({ where: { id: effectId } })).status,
    ).toBe("executing");
    expect(await prisma.message.count({ where: { clientNonce: `shell-result:${effectId}` } })).toBe(
      0,
    );
    await save();
    await save();
    expect(await prisma.message.count({ where: { clientNonce: `shell-result:${effectId}` } })).toBe(
      1,
    );
  });

  it("rejects the previous executor fence without losing the result", async () => {
    await prisma.run.update({ where: { id: run.id }, data: { leaseFence: 2 } });
    await expect(save()).rejects.toThrow("lease lost");
    run.leaseFence = 2;
    await save();
    expect(await prisma.message.count({ where: { clientNonce: `shell-result:${effectId}` } })).toBe(
      1,
    );
  });

  it("separates a healthy executor from an unknown operation and business progress", async () => {
    await save({ ...completed, state: "unknown", code: null });
    const activity = (await loadTaskExecutions(prisma, [taskId], owner)).get(taskId)!;
    expect(activity.heartbeat).toBe("current");
    expect(activity.operations[0]!.state).toBe("unknown");
    expect(
      (await prisma.task.findUniqueOrThrow({ where: { id: taskId } })).lastProgressAt,
    ).toBeNull();
    expect(await prisma.message.count({ where: { clientNonce: `shell-result:${effectId}` } })).toBe(
      0,
    );
  });
});
