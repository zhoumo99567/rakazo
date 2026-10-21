// @vitest-environment jsdom
import type { TaskSummary } from "@rakazo/contracts";
import type { ComponentProps, ReactNode } from "react";
import { act } from "react";
import type { Root } from "react-dom/client";
import { createRoot } from "react-dom/client";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { rpc } from "../../lib/rpc";
import { BotTasks } from "./bot-tasks";

vi.mock("../../lib/rpc", () => ({ rpc: { tasks: { list: vi.fn(), cancel: vi.fn() } } }));
vi.mock("@lingui/react/macro", () => ({
  useLingui: () => ({ t: (parts: TemplateStringsArray) => parts.join("") }),
  Trans: ({ children }: { children: ReactNode }) => children,
}));
vi.mock("@rakazo/ui-web", () => ({
  Button: ({
    size: _size,
    variant: _variant,
    ...props
  }: ComponentProps<"button"> & { size?: string; variant?: string }) => (
    <button type="button" {...props} />
  ),
}));

const task: TaskSummary = {
  id: "task",
  botId: "bot",
  parentTaskId: null,
  status: "running",
  prompt: "Prepare report",
  completedAt: null,
  latestReport: { text: "Inputs verified", reportedAt: "2026-01-01T12:00:00.000Z", kind: "status" },
  pendingMessageCount: 2,
  reportOverdue: true,
};

describe("task reports", () => {
  let root: Root;
  let container: HTMLDivElement;
  beforeEach(async () => {
    vi.useFakeTimers();
    vi.mocked(rpc.tasks.list)
      .mockReset()
      .mockResolvedValue({ tasks: [task], nextCursor: null });
    container = document.createElement("div");
    document.body.append(container);
    root = createRoot(container);
    await act(async () => root.render(<BotTasks botId="bot" />));
  });
  afterEach(async () => {
    await act(async () => root.unmount());
    container.remove();
    vi.useRealTimers();
    vi.restoreAllMocks();
  });
  async function open() {
    await act(async () => {
      const details = container.querySelector("details")!;
      details.open = true;
      details.dispatchEvent(new Event("toggle"));
    });
  }

  it("renders actual reports and conditional state instead of empty progress copy", async () => {
    await open();
    expect(container.textContent).toContain("Inputs verified");
    expect(container.textContent).toContain("Pending messages: 2");
    expect(container.textContent).toContain("Report overdue");
    expect(container.querySelector("time")?.dateTime).toBe(task.latestReport!.reportedAt);
  });

  it("refreshes only while expanded and visible and does not overlap pending requests", async () => {
    await open();
    vi.spyOn(document, "visibilityState", "get").mockReturnValue("hidden");
    await act(async () => {
      await vi.advanceTimersByTimeAsync(30_000);
    });
    const before = vi.mocked(rpc.tasks.list).mock.calls.length;
    vi.spyOn(document, "visibilityState", "get").mockReturnValue("visible");
    let resolve!: (page: { tasks: TaskSummary[]; nextCursor: string | null }) => void;
    vi.mocked(rpc.tasks.list).mockReturnValueOnce(
      new Promise((done) => {
        resolve = done;
      }),
    );
    await act(async () => {
      await vi.advanceTimersByTimeAsync(30_000);
    });
    await act(async () => {
      await vi.advanceTimersByTimeAsync(60_000);
    });
    expect(vi.mocked(rpc.tasks.list).mock.calls.length).toBe(before + 1);
    await act(async () => {
      resolve({ tasks: [task], nextCursor: null });
    });
    await act(async () => {
      const details = container.querySelector("details")!;
      details.open = false;
      details.dispatchEvent(new Event("toggle"));
    });
    const closedCount = vi.mocked(rpc.tasks.list).mock.calls.length;
    await act(async () => {
      await vi.advanceTimersByTimeAsync(30_000);
    });
    expect(vi.mocked(rpc.tasks.list).mock.calls.length).toBe(closedCount);
  });

  it("discards responses from a previous bot", async () => {
    let resolve!: (page: { tasks: TaskSummary[]; nextCursor: string | null }) => void;
    vi.mocked(rpc.tasks.list).mockReturnValueOnce(
      new Promise((done) => {
        resolve = done;
      }),
    );
    await open();
    vi.mocked(rpc.tasks.list).mockResolvedValueOnce({ tasks: [], nextCursor: null });
    await act(async () => root.render(<BotTasks botId="other-bot" />));
    await act(async () => {
      resolve({ tasks: [task], nextCursor: null });
    });
    expect(container.textContent).not.toContain("Inputs verified");
  });
});
