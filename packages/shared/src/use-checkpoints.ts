import { useEffect, useRef, useState } from "react";
import type { Checkpoint, CheckpointApi, CheckpointDecision, CheckpointPreview } from "./checkpoints";

/** Both clients use the same required review and stale-preview behavior. Mount with a key for the Chat. */
export function useCheckpoints(api: CheckpointApi, chatId: string) {
  const [items, setItems] = useState<Checkpoint[]>([]);
  const [preview, setPreview] = useState<CheckpointPreview | null>(null);
  const [decisions, setDecisions] = useState<Record<string, CheckpointDecision>>({});
  const [pending, setPending] = useState(false);
  const [error, setError] = useState("");
  const [notice, setNotice] = useState("");
  const generation = useRef(0);
  const acting = useRef(false);
  useEffect(
    () => () => {
      generation.current++;
      acting.current = false;
    },
    // oxlint-disable-next-line react/exhaustive-effect-dependencies -- invalidate in-flight work when the connection or Chat changes.
    [api, chatId],
  );
  async function run<T>(work: () => Promise<T>, apply: (result: T) => void) {
    if (acting.current) return;
    acting.current = true;
    const current = generation.current;
    setPending(true);
    setError("");
    setNotice("");
    try {
      const result = await work();
      if (generation.current === current) apply(result);
    } catch (failure) {
      if (generation.current === current) setError(failure instanceof Error ? failure.message : String(failure));
    } finally {
      if (generation.current === current) {
        acting.current = false;
        setPending(false);
      }
    }
  }
  function load() {
    return run(
      () => api.list({ chatId }),
      (result) => {
        setItems(result);
        setPreview(null);
        setDecisions({});
      },
    );
  }
  function inspect(id: string) {
    setPreview(null);
    setDecisions({});
    return run(() => api.preview({ chatId, id }), setPreview);
  }
  function restore() {
    if (!preview) return Promise.resolve();
    return run(
      async () => {
        const result = await api.restore({ chatId, token: preview.token, decisions, approved: true });
        return { result, next: await api.list({ chatId }).catch(() => items) };
      },
      ({ result, next }) => {
        setPreview(null);
        setDecisions({});
        setItems(next);
        setNotice(
          `${result.restored} ${result.restored === 1 ? "file" : "files"} restored.${result.recoveryId ? " Use the Before restore checkpoint to recover the previous files." : ""}`,
        );
      },
    );
  }
  const resolved = !!preview?.files.length && preview.files.every((file) => !!decisions[file.key]);
  const restoreCount = preview?.files.filter((file) => decisions[file.key] === "restore").length ?? 0;
  return {
    items,
    preview,
    decisions,
    pending,
    error,
    notice,
    load,
    inspect,
    restore,
    resolved,
    restoreCount,
    choose: (key: string, decision: CheckpointDecision) => setDecisions((current) => ({ ...current, [key]: decision })),
  };
}
