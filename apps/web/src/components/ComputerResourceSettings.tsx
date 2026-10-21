import { Trans, useLingui } from "@lingui/react/macro";
import type { ComputerResourceLimits } from "@rakazo/contracts";
import { ComputerResourceUpdateSchema } from "@rakazo/contracts";
import { Button, Dialog, DialogContent, DialogHeader, DialogTitle, Input } from "@rakazo/ui-web";
import { useEffect, useId, useState } from "react";
import { rpc } from "../lib/rpc";
import { errorText } from "../lib/user-error";

export function ComputerResourceSettings({
  botId,
  team,
  onClose,
  onChanged,
}: {
  botId: string;
  team: boolean;
  onClose: () => void;
  onChanged: () => Promise<void>;
}) {
  const { t } = useLingui();
  const id = useId();
  const [initial, setInitial] = useState<ComputerResourceLimits | null>(null);
  const [cpus, setCpus] = useState("");
  const [memory, setMemory] = useState("");
  const [pending, setPending] = useState(false);
  const [error, setError] = useState<string | null>(null);
  useEffect(() => {
    let active = true;
    setInitial(null);
    setError(null);
    rpc.computer
      .resources({ botId })
      .then((limits) => {
        if (!active) return;
        setInitial(limits);
        setCpus(String(limits.cpus));
        setMemory(String(limits.memoryMiB));
      })
      .catch((err) => {
        if (active) setError(errorText(err, t`Could not read computer limits`));
      });
    return () => {
      active = false;
    };
  }, [botId, t]);
  const parsed = ComputerResourceUpdateSchema.safeParse({
    cpus: Number(cpus),
    memoryMiB: Number(memory),
  });
  const loweringMemory =
    initial &&
    Number(memory) > 0 &&
    (initial.memoryMiB === 0 || Number(memory) < initial.memoryMiB);
  async function save() {
    if (!parsed.success || pending) return;
    setPending(true);
    setError(null);
    try {
      await rpc.computer.setResources({ botId, limits: parsed.data });
      await onChanged();
      onClose();
    } catch (err) {
      setError(errorText(err, t`Could not update computer limits`));
    } finally {
      setPending(false);
    }
  }
  return (
    <Dialog
      open
      onOpenChange={(open) => {
        if (!open && !pending) onClose();
      }}
    >
      <DialogContent className="sm:max-w-sm">
        <DialogHeader>
          <DialogTitle>
            <Trans>Resource limits</Trans>
          </DialogTitle>
        </DialogHeader>
        {team ? (
          <p className="text-sm text-muted-foreground">
            <Trans>Applies to every bot using this team computer.</Trans>
          </p>
        ) : null}
        <label className="text-sm" htmlFor={`${id}-cpus`}>
          <Trans>CPU cores</Trans>
          <Input
            type="number"
            id={`${id}-cpus`}
            min="0.01"
            max="1024"
            step="0.01"
            value={cpus}
            disabled={!initial || pending}
            onChange={(event) => setCpus(event.target.value)}
          />
        </label>
        <label className="text-sm" htmlFor={`${id}-memory`}>
          <Trans>Memory (MiB)</Trans>
          <Input
            type="number"
            id={`${id}-memory`}
            min="6"
            step="1"
            value={memory}
            disabled={!initial || pending}
            onChange={(event) => setMemory(event.target.value)}
          />
        </label>
        {initial && (initial.cpus === 0 || initial.memoryMiB === 0) ? (
          <p className="text-sm text-muted-foreground">
            <Trans>0 currently means unlimited. Enter positive limits to save.</Trans>
          </p>
        ) : null}
        {loweringMemory ? (
          <p className="text-sm text-destructive">
            <Trans>Lowering memory can terminate programs. Save your work first.</Trans>
          </p>
        ) : null}
        {error ? (
          <p role="alert" className="text-sm text-destructive">
            {error}
          </p>
        ) : null}
        <div className="flex justify-end gap-2">
          <Button variant="outline" disabled={pending} onClick={onClose}>
            <Trans>Cancel</Trans>
          </Button>
          <Button disabled={!initial || !parsed.success || pending} onClick={() => void save()}>
            {pending ? <Trans>Saving…</Trans> : <Trans>Save</Trans>}
          </Button>
        </div>
      </DialogContent>
    </Dialog>
  );
}
