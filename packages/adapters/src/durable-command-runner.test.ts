import { execFile } from "node:child_process";
import { mkdtemp, readFile, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import path from "node:path";
import { promisify } from "node:util";
import type { CommandOperationSnapshot } from "@rakazo/adapter-kit";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { DURABLE_COMMAND_RUNNER } from "./durable-command-runner.js";

const execute = promisify(execFile);
const linux = process.platform === "linux" ? describe : describe.skip;
linux("detached command runner", () => {
  let root: string;
  let source: string;
  let operations: Set<string>;
  beforeEach(async () => {
    operations = new Set();
    root = await mkdtemp(path.join(tmpdir(), "command-operation-test-"));
    source = DURABLE_COMMAND_RUNNER.replace(
      "Path.home() / '.local' / 'state' / 'rakazo-command-operations'",
      `Path(${JSON.stringify(root)})`,
    );
  });
  afterEach(async () => {
    for (const id of operations) {
      await query("cancel", id).catch(() => undefined);
      await completed(id).catch(() => undefined);
    }
    await rm(root, { recursive: true, force: true });
  });
  async function query(
    action: string,
    operationId: string,
    command?: { argv: string[]; timeoutMs: number },
  ) {
    if (action === "start") operations.add(operationId);
    const result = await execute(
      "python3",
      [
        "-c",
        source,
        JSON.stringify({
          action,
          operationId,
          command,
          scope: "space/bot/run",
          fingerprint: operationId,
        }),
      ],
      { timeout: 10_000 },
    );
    return JSON.parse(result.stdout) as CommandOperationSnapshot;
  }
  async function completed(id: string) {
    for (let index = 0; index < 100; index++) {
      const status = await query("status", id);
      if (status.state !== "running") return status;
      await new Promise((resolve) => setTimeout(resolve, 20));
    }
    throw new Error("Test operation did not finish");
  }
  it("starts once for concurrent clients and retains output for a new client", async () => {
    const counter = path.join(root, "counter");
    const command = {
      argv: [
        "python3",
        "-c",
        `import pathlib,time; p=pathlib.Path(${JSON.stringify(counter)}); p.write_text('x'+(p.read_text() if p.exists() else '')); time.sleep(.2); print('verified')`,
      ],
      timeoutMs: 1_800_000,
    };
    await Promise.all([
      query("start", "same-operation", command),
      query("start", "same-operation", command),
    ]);
    expect(await completed("same-operation")).toMatchObject({
      state: "completed",
      code: 0,
      stdout: "verified\n",
    });
    expect(await readFile(counter, "utf8")).toBe("x");
    expect(await query("status", "same-operation")).toMatchObject({
      state: "completed",
      stdout: "verified\n",
    });
  });
  it("enforces its own deadline rather than the connection or report deadline", async () => {
    await query("start", "deadline", { argv: ["sleep", "5"], timeoutMs: 100 });
    expect(await completed("deadline")).toMatchObject({ state: "timed_out", code: 124 });
  });
  it("queries missing operations without launching and supports explicit cancellation", async () => {
    expect(await query("status", "absent")).toMatchObject({ state: "not_found", code: null });
    await query("start", "cancel", { argv: ["sleep", "5"], timeoutMs: 1_800_000 });
    await query("cancel", "cancel");
    expect(await completed("cancel")).toMatchObject({ state: "cancelled", code: 130 });
  });
});
