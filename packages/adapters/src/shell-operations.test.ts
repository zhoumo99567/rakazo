import type { CommandOperationSnapshot, ProcessEvent, SandboxProvider } from "@rakazo/adapter-kit";
import { afterEach, describe, expect, it, vi } from "vitest";
import { observeShellCommand } from "./shell-command-stream.js";
import { observeOperation, shellOperationOf } from "./shell-operations.js";

const operation = {
  version: 1 as const,
  id: "effect",
  computer: { id: "computer", botId: "bot", providerRef: "test-computer", kind: "docker" as const },
};
const context = (signal = new AbortController().signal) => ({
  signal,
  operationId: "run",
  traceId: "run",
  runId: "run",
  botId: "bot",
  userId: "owner",
  spaceId: "space",
});
const snapshot = (
  state: CommandOperationSnapshot["state"],
  code: number | null = null,
): CommandOperationSnapshot => ({
  state,
  code,
  stdout: "",
  stderr: "",
  observedAt: new Date().toISOString(),
});

afterEach(() => vi.useRealTimers());

describe("durable shell observation", () => {
  it("keeps a silent 30 minute operation alive and reports its real exit", async () => {
    vi.useFakeTimers();
    const start = Date.now();
    const query = vi.fn(async () =>
      Date.now() - start >= 1_800_000
        ? { ...snapshot("completed", 0), stdout: "verified result" }
        : snapshot("running"),
    );
    const onSnapshot = vi.fn(async () => undefined);
    const result = observeShellCommand(
      observeOperation({
        sandbox: { commandOperation: query } as unknown as SandboxProvider,
        operation,
        context: context(),
        onSnapshot,
        pollMs: 30_000,
      }),
      { secrets: [] },
    );
    await vi.advanceTimersByTimeAsync(1_000);
    const observed = await result;
    expect(observed.result).toMatchObject({ code: null, running: true });
    const done = vi.fn();
    observed.completion!.then(done);
    await vi.advanceTimersByTimeAsync(1_798_999);
    expect(done).not.toHaveBeenCalled();
    await vi.advanceTimersByTimeAsync(1);
    expect(await observed.completion).toEqual({ stdout: "verified result", stderr: "", code: 0 });
    expect(query.mock.calls.length).toBeGreaterThan(10);
    expect(
      query.mock.calls.every(
        (args) =>
          (args as unknown[])[1] &&
          ((args as unknown[])[1] as { action: string }).action === "status",
      ),
    ).toBe(true);
  });

  it("reconnects by status without restarting or duplicating partial output", async () => {
    vi.useFakeTimers();
    const query = vi
      .fn()
      .mockResolvedValueOnce({ ...snapshot("running"), stdout: "first\n" })
      .mockRejectedValueOnce(new Error("connection lost"))
      .mockResolvedValueOnce({ ...snapshot("completed", 7), stdout: "first\nlast\n" });
    const states: string[] = [];
    const events: ProcessEvent[] = [];
    const drain = (async () => {
      for await (const e of observeOperation({
        sandbox: { commandOperation: query } as unknown as SandboxProvider,
        operation,
        context: context(),
        onSnapshot: async (s) => {
          states.push(s.state);
        },
      }))
        events.push(e);
    })();
    await vi.advanceTimersByTimeAsync(4_000);
    await drain;
    expect(states).toEqual(["running", "unknown", "completed"]);
    expect(events).toEqual([
      { type: "stdout", data: "first\n" },
      { type: "stdout", data: "last\n" },
      { type: "exit", code: 7 },
    ]);
    expect(query.mock.calls.every((args) => args[1].action === "status")).toBe(true);
  });

  it("keeps a missing operation unconfirmed until cancellation; never fabricates exit zero", async () => {
    vi.useFakeTimers();
    const abort = new AbortController();
    const query = vi.fn(async () => snapshot("not_found"));
    const events: ProcessEvent[] = [];
    const drain = (async () => {
      for await (const e of observeOperation({
        sandbox: { commandOperation: query } as unknown as SandboxProvider,
        operation,
        context: context(abort.signal),
        onSnapshot: async () => undefined,
      }))
        events.push(e);
    })();
    const rejected = expect(drain).rejects.toThrow();
    await vi.advanceTimersByTimeAsync(600_000);
    expect(events).toEqual([]);
    abort.abort(new Error("cancelled"));
    await rejected;
    expect(
      query.mock.calls.every(
        (args) => ((args as unknown[])[1] as { action: string }).action === "status",
      ),
    ).toBe(true);
  });

  it("retries result persistence before exposing a successful exit", async () => {
    vi.useFakeTimers();
    const query = vi.fn(async () => ({ ...snapshot("completed", 0), stdout: "durable result" }));
    const persist = vi
      .fn()
      .mockRejectedValueOnce(new Error("database unavailable"))
      .mockResolvedValue(undefined);
    const events: ProcessEvent[] = [];
    const drain = (async () => {
      for await (const event of observeOperation({
        sandbox: { commandOperation: query } as unknown as SandboxProvider,
        operation,
        context: context(),
        onSnapshot: persist,
      }))
        events.push(event);
    })();
    await vi.advanceTimersByTimeAsync(1_999);
    expect(events).toEqual([]);
    await vi.advanceTimersByTimeAsync(1);
    await drain;
    expect(events).toEqual([
      { type: "stdout", data: "durable result" },
      { type: "exit", code: 0 },
    ]);
    expect(persist).toHaveBeenCalledTimes(2);
  });

  it("does not interpret an incomplete stream as command success", async () => {
    await expect(
      observeShellCommand(
        (async function* () {
          yield { type: "stdout" as const, data: "partial" };
        })(),
        { secrets: [] },
      ),
    ).rejects.toThrow("without an exit result");
  });

  it("only recognizes versioned operation identities", () => {
    expect(shellOperationOf({ operation })).toEqual(operation);
    expect(shellOperationOf({ operation: { id: "effect" } })).toBeUndefined();
  });
});
