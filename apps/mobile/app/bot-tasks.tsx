import type { TaskSummary } from "@rakazo/contracts";
import { Stack, useFocusEffect, useLocalSearchParams, useRouter } from "expo-router";
import { useCallback, useEffect, useRef, useState } from "react";
import { AppState, ScrollView, Text, View } from "react-native";
import { NativeActionButton } from "../components/native-action-button";
import { rpc } from "../lib/api";
import { useI18n } from "../lib/i18n";
import { useMobileTokens } from "../lib/native";
import { errorText } from "../lib/user-error";

export default function BotTasksScreen() {
  const { botId, parentTaskId } = useLocalSearchParams<{ botId: string; parentTaskId?: string }>();
  const router = useRouter();
  const tokens = useMobileTokens();
  const { t } = useI18n();
  const [tasks, setTasks] = useState<TaskSummary[]>([]);
  const [cursor, setCursor] = useState<string | null>(null);
  const [pending, setPending] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const generation = useRef(0);
  const loading = useRef(false);
  async function load(next?: string, refresh = false) {
    if (loading.current) return;
    loading.current = true;
    const request = ++generation.current;
    setPending(true);
    setError(null);
    try {
      let page = await rpc<{ tasks: TaskSummary[]; nextCursor: string | null }>("tasks/list", {
        ...(parentTaskId ? { parentTaskId } : { botId }),
        cursor: next,
      });
      const collected = [...page.tasks];
      while (refresh && page.nextCursor && collected.length < tasks.length) {
        page = await rpc<{ tasks: TaskSummary[]; nextCursor: string | null }>("tasks/list", {
          ...(parentTaskId ? { parentTaskId } : { botId }),
          cursor: page.nextCursor,
        });
        collected.push(...page.tasks);
      }
      if (request !== generation.current) return;
      setTasks((previous) => (next ? [...previous, ...collected] : collected));
      setCursor(page.nextCursor);
    } catch (err) {
      if (request === generation.current) setError(errorText(err, t("Could not load tasks")));
    } finally {
      if (request === generation.current) {
        loading.current = false;
        setPending(false);
      }
    }
  }
  useEffect(() => {
    generation.current += 1;
    loading.current = false;
    setTasks([]);
    void load();
    return () => {
      generation.current += 1;
    };
  }, [botId, parentTaskId]);
  useFocusEffect(
    useCallback(() => {
      if (
        pending ||
        !tasks.some((task) => !["completed", "failed", "cancelled"].includes(task.status))
      )
        return;
      const timer = setInterval(() => {
        if (AppState.currentState === "active") void load(undefined, true);
      }, 30_000);
      return () => clearInterval(timer);
    }, [pending, tasks, botId, parentTaskId]),
  );
  const labels = {
    queued: t("Queued"),
    running: t("Working"),
    waiting_children: t("Waiting for bots"),
    waiting_input: t("Waiting for an answer"),
    completed: t("Completed"),
    failed: t("Failed"),
    cancelled: t("Cancelled"),
  };
  return (
    <>
      <Stack.Screen options={{ title: t("Tasks") }} />
      <ScrollView
        contentInsetAdjustmentBehavior="automatic"
        contentContainerStyle={{ padding: 20, gap: 16 }}
      >
        <NativeActionButton
          label={t("Refresh")}
          prominence="plain"
          disabled={pending}
          onPress={() => void load()}
        />
        {error ? (
          <Text accessibilityRole="alert" style={{ color: tokens.destructive }}>
            {error}
          </Text>
        ) : null}
        {!pending && !error && tasks.length === 0 ? (
          <Text style={{ color: tokens.mutedForeground }}>{t("No tasks")}</Text>
        ) : null}
        {tasks.map((task) => (
          <View
            key={task.id}
            style={{ gap: 8, borderBottomWidth: 1, borderColor: tokens.border, paddingBottom: 12 }}
          >
            <Text numberOfLines={3} style={{ color: tokens.foreground }}>
              {task.prompt}
            </Text>
            <Text style={{ color: tokens.mutedForeground }}>{labels[task.status]}</Text>
            {task.latestReport ? (
              <View style={{ gap: 4 }}>
                <Text numberOfLines={3} style={{ color: tokens.foreground }}>
                  {task.latestReport.text}
                </Text>
                <Text style={{ color: tokens.mutedForeground }}>
                  {new Date(task.latestReport.reportedAt).toLocaleString()}
                </Text>
              </View>
            ) : null}
            {(task.pendingMessageCount ?? 0) > 0 ? (
              <Text style={{ color: tokens.mutedForeground }}>
                {t("Pending messages")}: {task.pendingMessageCount}
              </Text>
            ) : null}
            {task.reportOverdue ? (
              <Text style={{ color: tokens.destructive }}>{t("Report overdue")}</Text>
            ) : null}
            <View style={{ flexDirection: "row", gap: 20 }}>
              <NativeActionButton
                label={t("Subtasks")}
                prominence="plain"
                disabled={pending}
                onPress={() =>
                  router.push({ pathname: "/bot-tasks", params: { botId, parentTaskId: task.id } })
                }
              />
              {!["completed", "failed", "cancelled"].includes(task.status) ? (
                <NativeActionButton
                  label={t("Cancel task")}
                  prominence="plain"
                  disabled={pending}
                  onPress={() => {
                    setPending(true);
                    void rpc("tasks/cancel", { taskId: task.id })
                      .then(() => load())
                      .catch((err) => {
                        setError(errorText(err, t("Could not cancel task")));
                        setPending(false);
                      });
                  }}
                />
              ) : null}
            </View>
          </View>
        ))}
        {cursor ? (
          <NativeActionButton
            label={t("Load more")}
            prominence="plain"
            disabled={pending}
            onPress={() => void load(cursor)}
          />
        ) : null}
      </ScrollView>
    </>
  );
}
