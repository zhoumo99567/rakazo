import { Trans, useLingui } from "@lingui/react/macro";
import type { TaskSummary } from "@rakazo/contracts";
import { Button } from "@rakazo/ui-web";
import { useState } from "react";
import { rpc } from "../../lib/rpc";
import { errorText } from "../../lib/user-error";

export function BotTasks({ botId }: { botId: string }) {
  const { t } = useLingui();
  const [tasks, setTasks] = useState<TaskSummary[]>([]);
  const [parentTaskId, setParentTaskId] = useState<string>();
  const [cursor, setCursor] = useState<string | null>(null);
  const [pending, setPending] = useState(false);
  const [error, setError] = useState<string | null>(null);
  async function load(parent?: string, next?: string) {
    setPending(true);
    setError(null);
    try {
      const page = await rpc.tasks.list({
        ...(parent ? { parentTaskId: parent } : { botId }),
        cursor: next,
      });
      setParentTaskId(parent);
      setTasks((previous) => (next ? [...previous, ...page.tasks] : page.tasks));
      setCursor(page.nextCursor);
    } catch (err) {
      setError(errorText(err, t`Could not load tasks`));
    } finally {
      setPending(false);
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
