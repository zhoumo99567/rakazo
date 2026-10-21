import type { ComputerResourceLimits } from "@rakazo/contracts";
import { ComputerResourceUpdateSchema } from "@rakazo/contracts";
import { Stack, useLocalSearchParams, useRouter } from "expo-router";
import { useEffect, useState } from "react";
import { ScrollView, Text, TextInput } from "react-native";
import { NativeActionButton } from "../components/native-action-button";
import { rpc } from "../lib/api";
import { useI18n } from "../lib/i18n";
import { native, useMobileTokens } from "../lib/native";
import { errorText } from "../lib/user-error";

export default function ComputerResources() {
  const { botId, team } = useLocalSearchParams<{ botId: string; team?: string }>();
  const { t } = useI18n();
  const tokens = useMobileTokens();
  const router = useRouter();
  const [initial, setInitial] = useState<ComputerResourceLimits | null>(null);
  const [cpus, setCpus] = useState("");
  const [memory, setMemory] = useState("");
  const [pending, setPending] = useState(false);
  const [error, setError] = useState<string | null>(null);
  useEffect(() => {
    let active = true;
    setInitial(null);
    setError(null);
    rpc<ComputerResourceLimits>("computer/resources", { botId })
      .then((limits) => {
        if (!active) return;
        setInitial(limits);
        setCpus(String(limits.cpus));
        setMemory(String(limits.memoryMiB));
      })
      .catch((err) => {
        if (active) setError(errorText(err, t("Could not read computer limits")));
      });
    return () => {
      active = false;
    };
  }, [botId, t]);
  const parsed = ComputerResourceUpdateSchema.safeParse({
    cpus: Number(cpus),
    memoryMiB: Number(memory),
  });
  async function save() {
    if (!parsed.success || pending) return;
    setPending(true);
    setError(null);
    try {
      await rpc("computer/setResources", { botId, limits: parsed.data });
      router.back();
    } catch (err) {
      setError(errorText(err, t("Could not update computer limits")));
    } finally {
      setPending(false);
    }
  }
  const inputStyle = {
    backgroundColor: native.fill,
    borderRadius: 11,
    padding: 14,
    color: tokens.foreground,
    fontSize: 16,
    marginVertical: 8,
  };
  return (
    <>
      <Stack.Screen options={{ title: t("Resource limits"), gestureEnabled: !pending }} />
      <ScrollView
        contentInsetAdjustmentBehavior="automatic"
        style={{ flex: 1, backgroundColor: tokens.background }}
        contentContainerStyle={{ padding: 24, gap: 12 }}
        keyboardShouldPersistTaps="handled"
      >
        {team === "true" ? (
          <Text style={{ color: tokens.mutedForeground }}>
            {t("Applies to every bot using this team computer.")}
          </Text>
        ) : null}
        <Text style={{ color: tokens.foreground }}>{t("CPU cores")}</Text>
        <TextInput
          accessibilityLabel={t("CPU cores")}
          keyboardType="decimal-pad"
          value={cpus}
          onChangeText={setCpus}
          editable={Boolean(initial) && !pending}
          style={inputStyle}
        />
        <Text style={{ color: tokens.foreground }}>{t("Memory (MiB)")}</Text>
        <TextInput
          accessibilityLabel={t("Memory (MiB)")}
          keyboardType="number-pad"
          value={memory}
          onChangeText={setMemory}
          editable={Boolean(initial) && !pending}
          style={inputStyle}
        />
        {initial && (initial.cpus === 0 || initial.memoryMiB === 0) ? (
          <Text style={{ color: tokens.mutedForeground }}>
            {t("0 currently means unlimited. Enter positive limits to save.")}
          </Text>
        ) : null}
        {initial &&
        Number(memory) > 0 &&
        (initial.memoryMiB === 0 || Number(memory) < initial.memoryMiB) ? (
          <Text style={{ color: tokens.destructive }}>
            {t("Lowering memory can terminate programs. Save your work first.")}
          </Text>
        ) : null}
        {error ? (
          <Text accessibilityRole="alert" style={{ color: tokens.destructive }}>
            {error}
          </Text>
        ) : null}
        <NativeActionButton
          label={pending ? t("Saving…") : t("Save")}
          disabled={!initial || !parsed.success || pending}
          onPress={() => void save()}
        />
      </ScrollView>
    </>
  );
}
