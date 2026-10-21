import { Trans, useLingui } from "@lingui/react/macro";
import type { TaskSummary } from "@rakazo/contracts";
import { formatMessageTime, taskTitle } from "@rakazo/core";
import { Button, Disclosure, Skeleton } from "@rakazo/ui-web";
import { ArrowLeft, ChevronDown, ListTodo, RefreshCw } from "lucide-react";
import { useEffect, useRef, useState } from "react";
import { rpc } from "../../lib/rpc";
import { errorText } from "../../lib/user-error";

export function BotTasks({ botId }: { botId: string }) {
  const { t, i18n } = useLingui();
  const [tasks, setTasks] = useState<TaskSummary[]>([]);
  const [parentTaskId, setParentTaskId] = useState<string>();
  const [cursor, setCursor] = useState<string | null>(null);
  const [pending, setPending] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [open, setOpen] = useState(false);
  const [trail, setTrail] = useState<TaskSummary[]>([]);
  const requestGeneration = useRef(0);
  const loading = useRef(false);
  useEffect(() => {
    requestGeneration.current += 1;
    loading.current = false;
    setTasks([]);
    setParentTaskId(undefined);
    setCursor(null);
    setTrail([]);
    setPending(false);
    if (open) void load();
    return () => {
      requestGeneration.current += 1;
    };
  }, [botId]);
  useEffect(() => {
    if (
      !open ||
      pending ||
      !tasks.some((task) => !["completed", "failed", "cancelled"].includes(task.status))
    )
      return;
    const timer = setInterval(() => {
      if (document.visibilityState === "visible") void load(parentTaskId, undefined, true);
    }, 30_000);
    return () => clearInterval(timer);
  }, [open, pending, tasks, botId, parentTaskId]);
  async function load(parent?: string, next?: string, refresh = false, nextTrail?: TaskSummary[]) {
    if (loading.current) return;
    loading.current = true;
    const generation = ++requestGeneration.current;
    setPending(true);
    setError(null);
    try {
      let page = await rpc.tasks.list({
        ...(parent ? { parentTaskId: parent } : { botId }),
        cursor: next,
      });
      const collected = [...page.tasks];
      while (refresh && page.nextCursor && collected.length < tasks.length) {
        page = await rpc.tasks.list({
          ...(parent ? { parentTaskId: parent } : { botId }),
          cursor: page.nextCursor,
        });
        collected.push(...page.tasks);
      }
      if (generation !== requestGeneration.current) return;
      setParentTaskId(parent);
      if (nextTrail) setTrail(nextTrail);
      setTasks((previous) => (next ? [...previous, ...collected] : collected));
      setCursor(page.nextCursor);
    } catch (err) {
      if (generation === requestGeneration.current)
        setError(errorText(err, t`Could not load tasks`));
    } finally {
      if (generation === requestGeneration.current) {
        loading.current = false;
        setPending(false);
      }
    }
  }
  const labels = {
    queued: t`Queued`,
    running: t`Working`,
    waiting_children: t`Waiting for bots`,
    waiting_input: t`Waiting for an answer`,
    completed: t`Completed`,
    failed: t`Failed`,
    cancelled: t`Cancelled`,
  };
  function sourceLabel(task: TaskSummary) {
    if (task.source?.kind === "bot") {
      const name = task.source.botName;
      return name ? t`Assigned by ${name}` : t`Assigned by a bot`;
    }
    if (task.source?.kind === "user") return t`Started by you`;
    if (task.source?.kind === "routine") return t`Scheduled task`;
    return task.source?.kind === "system" ? t`System task` : "";
  }
  return (
    <Disclosure
      data-testid="bot-tasks"
      className="mt-5"
      summaryClassName="min-h-11 w-full justify-between gap-3 border border-border px-3 py-2.5 text-sm font-medium hover:bg-muted/50"
      summary={
        <span className="flex items-center gap-2">
          <ListTodo aria-hidden="true" className="size-4 text-muted-foreground" />
          <Trans>Tasks</Trans>
        </span>
      }
      onToggle={(event) => {
        if (event.target !== event.currentTarget) return;
        setOpen(event.currentTarget.open);
        if (event.currentTarget.open) void load(parentTaskId, undefined, true);
      }}
    >
      {open ? (
        <div className="pt-3" aria-busy={pending}>
          <div className="mb-3 flex min-h-9 items-center justify-between gap-2">
            {parentTaskId ? (
              <Button
                size="sm"
                variant="ghost"
                disabled={pending}
                onClick={() => {
                  const previous = trail.slice(0, -1);
                  void load(previous.at(-1)?.id, undefined, false, previous);
                }}
              >
                <ArrowLeft aria-hidden="true" className="size-3.5" />
                <Trans>Back</Trans>
              </Button>
            ) : (
              <span className="text-xs text-muted-foreground">
                <Trans>Latest first</Trans>
              </span>
            )}
            <Button
              size="icon-sm"
              variant="ghost"
              disabled={pending}
              aria-label={t`Refresh`}
              onClick={() => void load(parentTaskId, undefined, true)}
            >
              <RefreshCw aria-hidden="true" className="size-3.5" />
            </Button>
          </div>
          {trail.length ? (
            <p className="mb-4 line-clamp-2 text-sm font-medium">
              {taskTitle(trail.at(-1)!.prompt)}
            </p>
          ) : null}
          {error ? (
            <p role="alert" className="mb-3 text-sm text-destructive">
              {error}
            </p>
          ) : null}
          {pending && tasks.length === 0 ? (
            <div role="status" aria-label={t`Loading tasks`} className="space-y-5 py-2">
              {[0, 1, 2].map((row) => (
                <div key={row} className="space-y-2 ps-6">
                  <Skeleton className="h-3 w-28" />
                  <Skeleton className="h-4 w-4/5" />
                  <Skeleton className="h-3 w-16" />
                </div>
              ))}
            </div>
          ) : null}
          {!pending && !error && tasks.length === 0 ? (
            <p className="py-5 text-center text-sm text-muted-foreground">
              <Trans>No tasks</Trans>
            </p>
          ) : null}
          <ol aria-label={t`Task timeline`}>
            {tasks.map((task, index) => (
              <li key={task.id} className="relative grid grid-cols-[12px_minmax(0,1fr)] gap-3">
                <div aria-hidden="true" className="relative flex justify-center">
                  {index < tasks.length - 1 ? (
                    <span className="absolute inset-y-0 top-3 w-px bg-border" />
                  ) : null}
                  <span
                    className={`relative mt-1.5 size-2 rounded-full border ${task.status === "failed" ? "border-destructive bg-destructive" : task.status === "running" ? "border-foreground bg-foreground" : "border-muted-foreground bg-background"}`}
                  />
                </div>
                <details className="group/task min-w-0 pb-6">
                  <summary className="block cursor-pointer list-none rounded-md outline-none focus-visible:ring-2 focus-visible:ring-ring [&::-webkit-details-marker]:hidden">
                    <span className="mb-1.5 flex flex-wrap items-center justify-between gap-x-3 gap-y-1 text-xs text-muted-foreground">
                      <span>
                        {sourceLabel(task)}
                        {parentTaskId && task.botName ? ` → ${task.botName}` : ""}
                      </span>
                      {task.createdAt ? (
                        <time
                          className="shrink-0 tabular-nums"
                          dateTime={task.createdAt}
                          title={new Date(task.createdAt).toLocaleString(i18n.locale)}
                        >
                          {formatMessageTime(task.createdAt, i18n.locale)}
                        </time>
                      ) : null}
                    </span>
                    <span className="flex items-start gap-2">
                      <span className="line-clamp-2 min-w-0 flex-1 text-sm font-medium leading-5">
                        {taskTitle(task.prompt)}
                      </span>
                      <ChevronDown
                        aria-hidden="true"
                        className="mt-0.5 size-3.5 shrink-0 text-muted-foreground transition-transform group-open/task:rotate-180 motion-reduce:transition-none"
                      />
                    </span>
                    <span className="mt-1.5 flex flex-wrap gap-x-3 gap-y-1 text-xs text-muted-foreground">
                      <span>{labels[task.status]}</span>
                      {(task.pendingMessageCount ?? 0) > 0 ? (
                        <span>
                          <Trans>Pending messages: {task.pendingMessageCount}</Trans>
                        </span>
                      ) : null}
                      {task.reportOverdue ? (
                        <span className="text-destructive">
                          <Trans>Report overdue</Trans>
                        </span>
                      ) : null}
                    </span>
                    {task.latestReport ? (
                      <span className="mt-2 block rounded-md bg-muted/50 px-3 py-2">
                        <span className="line-clamp-2 block text-sm leading-5 text-muted-foreground">
                          {task.latestReport.text}
                        </span>
                        <time
                          className="mt-1 block text-xs tabular-nums text-muted-foreground"
                          dateTime={task.latestReport.reportedAt}
                        >
                          {formatMessageTime(task.latestReport.reportedAt, i18n.locale)}
                        </time>
                      </span>
                    ) : null}
                  </summary>
                  <div className="mt-3 space-y-3 border-s border-border ps-3">
                    <p className="whitespace-pre-wrap break-words text-sm leading-6">
                      {task.prompt}
                    </p>
                    {task.latestReport ? (
                      <div>
                        <p className="mb-1 text-xs text-muted-foreground">
                          <Trans>Latest report</Trans>
                        </p>
                        <p className="whitespace-pre-wrap break-words text-sm leading-6">
                          {task.latestReport.text}
                        </p>
                      </div>
                    ) : null}
                    {task.completedAt ? (
                      <time
                        className="block text-xs tabular-nums text-muted-foreground"
                        dateTime={task.completedAt}
                      >
                        <Trans>Ended</Trans> · {formatMessageTime(task.completedAt, i18n.locale)}
                      </time>
                    ) : null}
                    <div className="flex flex-wrap items-center gap-2">
                      {task.childCount === undefined || task.childCount > 0 ? (
                        <Button
                          size="sm"
                          variant="outline"
                          disabled={pending}
                          onClick={() => {
                            void load(task.id, undefined, false, [...trail, task]);
                          }}
                        >
                          <Trans>Subtasks</Trans>
                          {task.childCount ? ` · ${task.childCount}` : ""}
                        </Button>
                      ) : null}
                      {!["completed", "failed", "cancelled"].includes(task.status) ? (
                        <Button
                          size="sm"
                          variant="ghost"
                          className="text-destructive"
                          disabled={pending}
                          onClick={() => {
                            setPending(true);
                            void rpc.tasks
                              .cancel({ taskId: task.id })
                              .then(() => load(parentTaskId, undefined, true))
                              .catch((err) => {
                                setError(errorText(err, t`Could not cancel task`));
                                setPending(false);
                              });
                          }}
                        >
                          <Trans>Cancel task</Trans>
                        </Button>
                      ) : null}
                    </div>
                  </div>
                </details>
              </li>
            ))}
          </ol>
          {cursor ? (
            <Button
              size="sm"
              variant="ghost"
              className="w-full"
              disabled={pending}
              onClick={() => void load(parentTaskId, cursor)}
            >
              <Trans>Load more</Trans>
            </Button>
          ) : null}
        </div>
      ) : null}
    </Disclosure>
  );
}
