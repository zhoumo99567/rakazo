import type { ProcessEvent } from "@rakazo/adapter-kit";
import { redactSecrets } from "@rakazo/core";
import { redactShellStreams } from "./agent-environment.js";
import { automated } from "./automated-messages.js";
import { clipToolResultText } from "./pi-runtime-limits.js";

/**
 * Device-code logins print a code and then wait. Once that output goes quiet,
 * return it while the process is still running so the bot can show the code.
 * Fast commands that exit inside this window are unchanged.
 */
export const SHELL_STREAM_IDLE_MS = 1_000;

export const SHELL_STILL_RUNNING_NOTICE =
  "Still running. Wait for the existing operation; do not launch it again. Relay any one-time code or sign-in URL if present.";

export interface ShellCommandSnapshot {
  stdout: string;
  stderr: string;
}

export interface FinishedShellCommand extends ShellCommandSnapshot {
  code: number;
}

export interface RunningShellCommand extends ShellCommandSnapshot {
  code: null;
  running: true;
}

export type ShellCommandResult = FinishedShellCommand | RunningShellCommand;

export function isRunningShellCommand(result: unknown): result is RunningShellCommand {
  return (
    !!result &&
    typeof result === "object" &&
    (result as { running?: unknown }).running === true &&
    (result as { code?: unknown }).code === null
  );
}

export function formatFinishedShellCommand(result: FinishedShellCommand): string {
  // Delivered in the user's role after the turn, so marked as automated: models took
  // finished console output for the user replying.
  const parts = [automated("Shell command finished."), `exit code: ${result.code}`];
  if (result.stdout) parts.push(`stdout:\n${clipToolResultText(result.stdout)}`);
  if (result.stderr) parts.push(`stderr:\n${clipToolResultText(result.stderr)}`);
  return parts.join("\n");
}

/**
 * After the turn that first saw a still-running shell, wait for those commands
 * to exit and hand the bot the final output. The turn that received the live
 * output is skipped so the bot can relay a device code before the process ends.
 */
export async function deliverFinishedShells(
  followUp: (text: string) => void,
  pending: Array<Promise<FinishedShellCommand>>,
  turn: { toolResults: Array<{ toolName?: string; details?: unknown }> },
  signal?: AbortSignal,
  waitControl?: { wakeIfNeeded: () => Promise<boolean>; pollIntervalMs?: number },
): Promise<void> {
  if (pending.length === 0 || turnReturnedRunningShell(turn) || signal?.aborted) return;
  // Keep commands tracked until their output is delivered. An inbox wake is not cancellation.
  const batch = [...pending];
  const completed = Promise.all(
    batch.map((completion) =>
      completion.catch((error: unknown) => ({
        stdout: "",
        stderr: error instanceof Error ? error.message : "command failed",
        code: 1,
      })),
    ),
  );
  let abort: (() => void) | undefined;
  const aborted = new Promise<undefined>((resolve) => {
    abort = () => resolve(undefined);
    signal?.addEventListener("abort", abort, { once: true });
    if (signal?.aborted) abort();
  });
  try {
    for (;;) {
      let timer: ReturnType<typeof setTimeout> | undefined;
      const tick = waitControl
        ? new Promise<"tick">((resolve) => {
            timer = setTimeout(() => resolve("tick"), waitControl.pollIntervalMs ?? 2_000);
          })
        : new Promise<never>(() => undefined);
      let result: FinishedShellCommand[] | "tick" | undefined;
      try {
        result = await Promise.race([completed, aborted, tick]);
      } finally {
        if (timer) clearTimeout(timer);
      }
      if (!result) return;
      if (result === "tick") {
        if (await waitControl!.wakeIfNeeded()) return;
        continue;
      }
      followUp(result.map(formatFinishedShellCommand).join("\n\n"));
      for (const command of batch) {
        const index = pending.indexOf(command);
        if (index !== -1) pending.splice(index, 1);
      }
      return;
    }
  } finally {
    if (abort) signal?.removeEventListener("abort", abort);
  }
}

function turnReturnedRunningShell(turn: {
  toolResults: Array<{ toolName?: string; details?: unknown }>;
}): boolean {
  return turn.toolResults.some(
    (result) => result.toolName === "shell" && isRunningShellCommand(result.details),
  );
}

/**
 * Read a command stream. When output arrives and then stays quiet, return it
 * before exit and keep collecting the rest on `completion`.
 */
export async function observeShellCommand(
  events: AsyncIterable<ProcessEvent>,
  options: {
    secrets: string[];
    idleMs?: number;
    onOutput?: (snapshot: ShellCommandSnapshot) => void;
  },
): Promise<{
  result: ShellCommandResult;
  completion?: Promise<FinishedShellCommand>;
}> {
  const idleMs = options.idleMs ?? SHELL_STREAM_IDLE_MS;
  let stdout = "";
  let stderr = "";
  let code: number | undefined;
  let finished = false;
  let timer: ReturnType<typeof setTimeout> | undefined;
  let resolveIdle: ((reason: "idle" | "done") => void) | undefined;
  const idlePromise = new Promise<"idle" | "done">((resolve) => {
    resolveIdle = resolve;
  });

  const redact = (snapshot: ShellCommandSnapshot, withholdPartial: boolean): ShellCommandSnapshot =>
    redactShellStreams(snapshot, options.secrets, { withholdPartial });

  const clearIdle = () => {
    if (timer) clearTimeout(timer);
    timer = undefined;
  };

  const armIdle = () => {
    clearIdle();
    if (idleMs <= 0) {
      resolveIdle?.("idle");
      return;
    }
    timer = setTimeout(() => resolveIdle?.("idle"), idleMs);
  };

  armIdle();
  const done = (async (): Promise<FinishedShellCommand> => {
    try {
      for await (const event of events) {
        if (event.type === "stdout") stdout = (stdout + event.data).slice(-131072);
        else if (event.type === "stderr") stderr = (stderr + event.data).slice(-131072);
        else if (event.type === "exit") {
          code = event.code;
          break;
        } else continue;
        const published = redact({ stdout, stderr }, true);
        try {
          options.onOutput?.(published);
        } catch {
          // Live output is a view. A failed update must not kill the command.
        }
        if (stdout.length > 0 || stderr.length > 0) armIdle();
      }
    } catch (error) {
      // Providers may include command environment values in errors. Never expose the raw
      // error or its cause to runtime tool handling or a background completion observer.
      throw new Error(
        redactSecrets(error instanceof Error ? error.message : String(error), options.secrets),
      );
    } finally {
      clearIdle();
      finished = true;
      resolveIdle?.("done");
    }
    if (code === undefined)
      throw new Error(
        "Command stream ended without an exit result; verify the operation before retrying.",
      );
    return { ...redact({ stdout, stderr }, false), code };
  })();

  const reason = await Promise.race([
    idlePromise,
    done.then(
      () => "done" as const,
      () => "done" as const,
    ),
  ]);
  if (reason === "done" || finished || code !== undefined) {
    return { result: await done };
  }
  return {
    // The process is still running, so an unfinished secret prefix stays out of the
    // tool result. The completion publishes the rest once the command exits.
    result: { ...redact({ stdout, stderr }, true), code: null, running: true },
    completion: done,
  };
}
