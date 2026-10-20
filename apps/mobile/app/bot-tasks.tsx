import type { TaskSummary } from "@rakazo/contracts";
import { Stack, useLocalSearchParams, useRouter } from "expo-router";
import { useEffect, useState } from "react";
import { ScrollView, Text, View } from "react-native";
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
  async function load(next?: string) {
    setPending(true);
    setError(null);
    try {
      const page = await rpc<{ tasks: TaskSummary[]; nextCursor: string | null }>("tasks/list", {
        ...(parentTaskId ? { parentTaskId } : { botId }),
        cursor: next,
      });
      setTasks((previous) => (next ? [...previous, ...page.tasks] : page.tasks));
      setCursor(page.nextCursor);
    } catch (err) {
      setError(errorText(err, t("Could not load tasks")));
    } finally {
      setPending(false);
    }
  }
  useEffect(() => {
    void load();
  }, [botId, parentTaskId]);
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
