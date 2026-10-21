import type { TaskSummary } from "@rakazo/contracts";
import { formatMessageTime, taskTitle } from "@rakazo/core";
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
  const { t, locale } = useI18n();
  const [tasks, setTasks] = useState<TaskSummary[]>([]);
  const [cursor, setCursor] = useState<string | null>(null);
  const [pending, setPending] = useState(false);
  const [expanded, setExpanded] = useState<string | null>(null);
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
    setExpanded(null);
    setCursor(null);
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
        {tasks.map((task, index) => {
          const source =
            task.source?.kind === "bot"
              ? task.source.botName
                ? t("Assigned by {name}", { name: task.source.botName })
                : t("Assigned by a bot")
              : task.source?.kind === "user"
                ? t("Started by you")
                : task.source?.kind === "routine"
                  ? t("Scheduled task")
                  : task.source?.kind === "system"
                    ? t("System task")
                    : "";
          return (
            <View key={task.id} style={{ flexDirection: "row", gap: 12 }}>
              <View accessible={false} style={{ width: 12, alignItems: "center" }}>
                {index < tasks.length - 1 ? (
                  <View
                    style={{
                      position: "absolute",
                      top: 8,
                      bottom: -16,
                      width: 1,
                      backgroundColor: tokens.border,
                    }}
                  />
                ) : null}
                <View
                  style={{
                    marginTop: 5,
                    width: 8,
                    height: 8,
                    borderRadius: 4,
                    borderWidth: 1,
                    borderColor:
                      task.status === "failed" ? tokens.destructive : tokens.mutedForeground,
                    backgroundColor:
                      task.status === "running"
                        ? tokens.foreground
                        : task.status === "failed"
                          ? tokens.destructive
                          : tokens.background,
                  }}
                />
              </View>
              <View style={{ flex: 1, gap: 8, paddingBottom: 12 }}>
                <View
                  style={{
                    flexDirection: "row",
                    flexWrap: "wrap",
                    justifyContent: "space-between",
                    gap: 4,
                  }}
                >
                  <Text style={{ color: tokens.mutedForeground, fontSize: 12 }}>
                    {source}
                    {parentTaskId && task.botName ? ` → ${task.botName}` : ""}
                  </Text>
                  {task.createdAt ? (
                    <Text
                      style={{
                        color: tokens.mutedForeground,
                        fontSize: 12,
                        fontVariant: ["tabular-nums"],
                      }}
                    >
                      {formatMessageTime(task.createdAt, locale)}
                    </Text>
                  ) : null}
                </View>
                <Text
                  numberOfLines={2}
                  style={{ color: tokens.foreground, fontSize: 15, fontWeight: "600" }}
                >
                  {taskTitle(task.prompt)}
                </Text>
                <View style={{ flexDirection: "row", flexWrap: "wrap", gap: 12 }}>
                  <Text style={{ color: tokens.mutedForeground, fontSize: 12 }}>
                    {labels[task.status]}
                  </Text>
                  {(task.pendingMessageCount ?? 0) > 0 ? (
                    <Text style={{ color: tokens.mutedForeground, fontSize: 12 }}>
                      {t("Pending messages")}: {task.pendingMessageCount}
                    </Text>
                  ) : null}
                  {task.reportOverdue ? (
                    <Text style={{ color: tokens.destructive, fontSize: 12 }}>
                      {t("Report overdue")}
                    </Text>
                  ) : null}
                </View>
                {task.latestReport ? (
                  <View
                    style={{ gap: 4, padding: 12, borderRadius: 8, backgroundColor: tokens.muted }}
                  >
                    <Text
                      numberOfLines={expanded === task.id ? undefined : 2}
                      style={{ color: tokens.foreground, fontSize: 14, lineHeight: 20 }}
                    >
                      {task.latestReport.text}
                    </Text>
                    <Text style={{ color: tokens.mutedForeground, fontSize: 12 }}>
                      {formatMessageTime(task.latestReport.reportedAt, locale)}
                    </Text>
                  </View>
                ) : null}
                <NativeActionButton
                  label={expanded === task.id ? t("Hide details") : t("Details")}
                  prominence="plain"
                  onPress={() => setExpanded(expanded === task.id ? null : task.id)}
                />
                {expanded === task.id ? (
                  <View style={{ gap: 12 }}>
                    <Text style={{ color: tokens.foreground, fontSize: 14, lineHeight: 22 }}>
                      {task.prompt}
                    </Text>
                    {task.completedAt ? (
                      <Text style={{ color: tokens.mutedForeground, fontSize: 12 }}>
                        {t("Ended")} · {formatMessageTime(task.completedAt, locale)}
                      </Text>
                    ) : null}
                    <View style={{ flexDirection: "row", flexWrap: "wrap", gap: 20 }}>
                      {task.childCount === undefined || task.childCount > 0 ? (
                        <NativeActionButton
                          label={t("Subtasks")}
                          prominence="plain"
                          disabled={pending}
                          onPress={() =>
                            router.push({
                              pathname: "/bot-tasks",
                              params: { botId, parentTaskId: task.id },
                            })
                          }
                        />
                      ) : null}
                      {!["completed", "failed", "cancelled"].includes(task.status) ? (
                        <NativeActionButton
                          label={t("Cancel task")}
                          prominence="destructive"
                          disabled={pending}
                          onPress={() => {
                            setPending(true);
                            void rpc("tasks/cancel", { taskId: task.id })
                              .then(() => load(undefined, true))
                              .catch((err) => {
                                setError(errorText(err, t("Could not cancel task")));
                                setPending(false);
                              });
                          }}
                        />
                      ) : null}
                    </View>
                  </View>
                ) : null}
              </View>
            </View>
          );
        })}
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
