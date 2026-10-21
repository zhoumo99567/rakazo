import type {
  AdapterContext,
  CommandOperationSnapshot,
  ComputerRef,
  ProcessEvent,
  SandboxProvider,
} from "@rakazo/adapter-kit";
import type { PrismaClient } from "@rakazo/db";
import { appendEventInTransaction, createThreadMessageInTransaction } from "@rakazo/db";
import { redactShellStreams } from "./agent-environment.js";
import { formatFinishedShellCommand } from "./shell-command-stream.js";

export interface ShellOperation {
  version: 1;
  id: string;
  computer: ComputerRef;
}

export function shellOperationOf(result: unknown): ShellOperation | undefined {
  if (!result || typeof result !== "object" || !("operation" in result)) return;
  const operation = result.operation as ShellOperation | undefined;
  if (
    operation?.version === 1 &&
    typeof operation.id === "string" &&
    operation.computer?.id &&
    operation.computer.botId
  )
    return operation;
}

export function commandTerminal(snapshot: CommandOperationSnapshot): boolean {
  return (
    ["completed", "timed_out", "cancelled"].includes(snapshot.state) &&
    Number.isInteger(snapshot.code)
  );
}

export async function operationDelay(ms: number, signal: AbortSignal) {
  signal.throwIfAborted();
  await new Promise<void>((resolve, reject) => {
    const abort = () => {
      clearTimeout(timer);
      signal.removeEventListener("abort", abort);
      reject(signal.reason ?? new Error("Aborted"));
    };
    const timer = setTimeout(() => {
      signal.removeEventListener("abort", abort);
      resolve();
    }, ms);
    signal.addEventListener("abort", abort, { once: true });
    if (signal.aborted) abort();
  });
}

// Linear suffix/prefix overlap keeps bounded provider tails from amplifying output on each poll.
function outputOverlap(previous: string, current: string): number {
  if (!current.length || !previous.length) return 0;
  if (current.startsWith(previous)) return previous.length;
  const prefix = new Uint32Array(current.length);
  for (let i = 1, matched = 0; i < current.length; i++) {
    while (matched && current[i] !== current[matched]) matched = prefix[matched - 1]!;
    if (current[i] === current[matched]) matched++;
    prefix[i] = matched;
  }
  let matched = 0;
  for (let index = 0; index < previous.length; index++) {
    const character = previous[index];
    while (matched && (matched === current.length || character !== current[matched]))
      matched = prefix[matched - 1]!;
    if (character === current[matched]) matched++;
  }
  return matched;
}

/** A lost connection is an observation failure. It neither kills nor relaunches the operation. */
export async function* observeOperation(input: {
  sandbox: SandboxProvider;
  operation: ShellOperation;
  context: AdapterContext;
  initial?: CommandOperationSnapshot;
  onSnapshot: (snapshot: CommandOperationSnapshot) => Promise<void>;
  pollMs?: number;
}): AsyncIterable<ProcessEvent> {
  let snapshot = input.initial;
  let lastSnapshot = input.initial;
  let stdout = "";
  let stderr = "";
  for (;;) {
    input.context.signal.throwIfAborted();
    if (!snapshot) {
      try {
        snapshot = await input.sandbox.commandOperation?.(
          input.operation.computer,
          {
            action: "status",
            operationId: input.operation.id,
          },
          input.context,
        );
      } catch {
        input.context.signal.throwIfAborted();
      }
    }
    snapshot ??= {
      ...lastSnapshot,
      state: "unknown",
      stdout,
      stderr,
      code: null,
      observedAt: new Date().toISOString(),
    };
    // not_found after an intent was recorded is not permission to replay: storage may be missing.
    if (snapshot.state === "not_found")
      snapshot = {
        ...snapshot,
        state: "unknown",
        stdout,
        stderr,
        startedAt: lastSnapshot?.startedAt,
        deadlineAt: lastSnapshot?.deadlineAt,
      };
    lastSnapshot = snapshot;
    try {
      await input.onSnapshot(snapshot);
    } catch {
      input.context.signal.throwIfAborted();
      // A result is not delivered until its durable write succeeds. Re-query, never re-run.
      snapshot = undefined;
      await operationDelay(input.pollMs ?? 2_000, input.context.signal);
      continue;
    }
    for (const stream of ["stdout", "stderr"] as const) {
      const previous = stream === "stdout" ? stdout : stderr;
      const current = snapshot[stream];
      // The provider keeps bounded output tails. Avoid replaying an unchanged tail on each poll.
      if (current !== previous) {
        const data = current.slice(outputOverlap(previous, current));
        if (data) yield { type: stream, data };
      }
    }
    stdout = snapshot.stdout;
    stderr = snapshot.stderr;
    if (commandTerminal(snapshot)) {
      yield { type: "exit", code: snapshot.code! };
      return;
    }
    snapshot = undefined;
    await operationDelay(input.pollMs ?? 2_000, input.context.signal);
  }
}

/** Commit the result and its durable inbox message together, guarded by the current run fence. */
export async function saveShellOperationSnapshot(input: {
  prisma: PrismaClient;
  run: {
    id: string;
    spaceId: string;
    threadId: string;
    botId: string;
    leaseOwner: string;
    leaseFence: number;
  };
  operation: ShellOperation;
  snapshot: CommandOperationSnapshot;
  secrets: string[];
}) {
  const { prisma, run, operation, snapshot } = input;
  const terminal = commandTerminal(snapshot);
  const safe = {
    ...snapshot,
    ...redactShellStreams(snapshot, input.secrets, { withholdPartial: !terminal }),
  };
  return prisma.$transaction(async (tx) => {
    await tx.$queryRaw`SELECT id FROM threads WHERE id = ${run.threadId} FOR UPDATE`;
    const held = await tx.$queryRaw<
      Array<{ id: string }>
    >`SELECT id FROM runs WHERE id = ${run.id} AND status = 'running' AND "leaseOwner" = ${run.leaseOwner} AND "leaseFence" = ${run.leaseFence} FOR UPDATE`;
    if (!held.length) throw new Error("Run lease lost while observing command");
    const updated = await tx.externalEffect.updateMany({
      where: { id: operation.id, runId: run.id, spaceId: run.spaceId, status: "executing" },
      data: {
        status: terminal ? "completed" : "executing",
        result: { ...safe, operation } as never,
      },
    });
    if (!updated.count || !terminal) return;
    const text = formatFinishedShellCommand({
      stdout: safe.stdout,
      stderr: safe.stderr,
      code: safe.code!,
    });
    const message = await createThreadMessageInTransaction(tx, {
      threadId: run.threadId,
      botId: run.botId,
      runId: run.id,
      role: "system",
      blocks: [{ kind: "text", text }],
      clientNonce: `shell-result:${operation.id}`,
      markUnread: false,
    });
    const event = await appendEventInTransaction(tx, {
      spaceId: run.spaceId,
      threadId: run.threadId,
      botId: run.botId,
      runId: run.id,
      type: "thread.message.created",
      payload: { messageId: message.id, role: "system", blocks: [{ kind: "text", text }] },
    });
    return event.seq;
  });
}
