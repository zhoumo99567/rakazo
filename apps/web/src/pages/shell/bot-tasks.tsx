import { Trans, useLingui } from "@lingui/react/macro";
import type { TaskSummary } from "@rakazo/contracts";
import { Button } from "@rakazo/ui-web";
import { useEffect, useRef, useState } from "react";
import { rpc } from "../../lib/rpc";
import { errorText } from "../../lib/user-error";

export function BotTasks({ botId }: { botId: string }) {
  const { t } = useLingui();
  const [tasks, setTasks] = useState<TaskSummary[]>([]);
  const [parentTaskId, setParentTaskId] = useState<string>();
  const [cursor, setCursor] = useState<string | null>(null);
  const [pending, setPending] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [open, setOpen] = useState(false);
  const requestGeneration = useRef(0);
  const loading = useRef(false);
  useEffect(() => {
    requestGeneration.current += 1;
    loading.current = false;
    setTasks([]);
    setParentTaskId(undefined);
    setCursor(null);
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
  async function load(parent?: string, next?: string, refresh = false) {
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
  return (
    <details
      className="mt-4"
      onToggle={(event) => {
        setOpen(event.currentTarget.open);
        if (event.currentTarget.open) void load();
      }}
    >
      <summary className="cursor-pointer text-sm text-muted-foreground">
        <Trans>Tasks</Trans>
      </summary>
      <div className="mt-2 flex gap-2">
        {parentTaskId ? (
          <Button size="sm" variant="ghost" disabled={pending} onClick={() => void load()}>
            <Trans>All tasks</Trans>
          </Button>
        ) : null}
        <Button
          size="sm"
          variant="ghost"
          disabled={pending}
          onClick={() => void load(parentTaskId)}
        >
          <Trans>Refresh</Trans>
        </Button>
      </div>
      {error ? (
        <p role="alert" className="text-sm text-destructive">
          {error}
        </p>
      ) : null}
      {!pending && !error && tasks.length === 0 ? (
        <p className="text-sm text-muted-foreground">
          <Trans>No tasks</Trans>
        </p>
      ) : null}
      <ul>
        {tasks.map((task) => (
          <li key={task.id} className="border-b border-border py-3">
            <p className="line-clamp-2 text-sm">{task.prompt}</p>
            <p className="text-xs text-muted-foreground">{labels[task.status]}</p>
            {task.latestReport ? (
              <div className="mt-1 text-sm">
                <p className="line-clamp-3">{task.latestReport.text}</p>
                <time
                  className="text-xs text-muted-foreground"
                  dateTime={task.latestReport.reportedAt}
                >
                  {new Date(task.latestReport.reportedAt).toLocaleString()}
                </time>
              </div>
            ) : null}
            {(task.pendingMessageCount ?? 0) > 0 ? (
              <p className="text-xs text-muted-foreground">
                <Trans>Pending messages: {task.pendingMessageCount}</Trans>
              </p>
            ) : null}
            {task.reportOverdue ? (
              <p className="text-xs text-destructive">
                <Trans>Report overdue</Trans>
              </p>
            ) : null}
            <div className="mt-1 flex gap-2">
              <Button
                size="sm"
                variant="ghost"
                disabled={pending}
                onClick={() => void load(task.id)}
              >
                <Trans>Subtasks</Trans>
              </Button>
              {!["completed", "failed", "cancelled"].includes(task.status) ? (
                <Button
                  size="sm"
                  variant="ghost"
                  disabled={pending}
                  onClick={() => {
                    setPending(true);
                    void rpc.tasks
                      .cancel({ taskId: task.id })
                      .then(() => load(parentTaskId))
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
          </li>
        ))}
      </ul>
      {cursor ? (
        <Button
          size="sm"
          variant="ghost"
          disabled={pending}
          onClick={() => void load(parentTaskId, cursor)}
        >
          <Trans>Load more</Trans>
        </Button>
      ) : null}
    </details>
  );
}
