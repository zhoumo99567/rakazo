// @vitest-environment jsdom
import type { TaskSummary } from "@rakazo/contracts";
import type * as UiWeb from "@rakazo/ui-web";
import type { ComponentProps, ReactNode } from "react";
import { act } from "react";
import type { Root } from "react-dom/client";
import { createRoot } from "react-dom/client";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { rpc } from "../../lib/rpc";
import { BotTasks } from "./bot-tasks";

vi.mock("../../lib/rpc", () => ({ rpc: { tasks: { list: vi.fn(), cancel: vi.fn() } } }));
vi.mock("@lingui/react/macro", () => ({
  useLingui: () => ({
    i18n: { locale: "en-US" },
    t: (parts: TemplateStringsArray, ...values: unknown[]) =>
      parts.reduce((text, part, index) => text + part + (values[index] ?? ""), ""),
  }),
  Trans: ({ children }: { children: ReactNode }) => children,
}));
vi.mock("@rakazo/ui-web", async (importOriginal) => ({
  ...(await importOriginal<typeof UiWeb>()),
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
  prompt: "Prepare report\nKeep the complete instructions in the expanded detail.",
  createdAt: "2026-01-01T10:00:00.000Z",
  source: { kind: "bot", botName: "Chief" },
  childCount: 0,
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
    expect(container.querySelector(`time[datetime="${task.createdAt}"]`)).not.toBeNull();
    expect(
      container.querySelector(`time[datetime="${task.latestReport!.reportedAt}"]`),
    ).not.toBeNull();
    expect(container.textContent).toContain("Assigned by Chief");
    const row = container.querySelector("li details")!;
    expect(row.hasAttribute("open")).toBe(false);
    expect(row.querySelector("summary")!.textContent).not.toContain("complete instructions");
    expect(row.textContent).toContain("complete instructions");
    expect(row.textContent).not.toContain("Subtasks");
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

  it("does not refetch when a task detail is expanded", async () => {
    await open();
    const count = vi.mocked(rpc.tasks.list).mock.calls.length;
    await act(async () => {
      const detail = container.querySelector("li details") as HTMLDetailsElement;
      detail.open = true;
      detail.dispatchEvent(new Event("toggle", { bubbles: true }));
    });
    expect(vi.mocked(rpc.tasks.list).mock.calls.length).toBe(count);
  });

  it("keeps the current timeline on a failed navigation and returns from subtasks", async () => {
    vi.mocked(rpc.tasks.list).mockResolvedValueOnce({
      tasks: [{ ...task, childCount: 1 }],
      nextCursor: null,
    });
    await open();
    const button = (label: string) =>
      Array.from(container.querySelectorAll("button")).find((item) =>
        item.textContent?.includes(label),
      )!;
    vi.mocked(rpc.tasks.list).mockRejectedValueOnce(new Error("Unavailable"));
    await act(async () => button("Subtasks").click());
    expect(container.textContent).toContain("Latest first");
    expect(button("Back")).toBeUndefined();
    vi.mocked(rpc.tasks.list).mockResolvedValueOnce({
      tasks: [
        {
          ...task,
          id: "child",
          prompt: "Check sources",
          botName: "Researcher",
          source: { kind: "bot", botName: "Worker" },
        },
      ],
      nextCursor: null,
    });
    await act(async () => button("Subtasks").click());
    expect(rpc.tasks.list).toHaveBeenLastCalledWith({ parentTaskId: task.id, cursor: undefined });
    expect(container.textContent).toContain("Assigned by Worker → Researcher");
    await act(async () => button("Back").click());
    expect(rpc.tasks.list).toHaveBeenLastCalledWith({ botId: "bot", cursor: undefined });
    expect(container.textContent).toContain("Latest first");
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
