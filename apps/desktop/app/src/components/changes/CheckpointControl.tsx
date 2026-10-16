import { useEffect, useRef, useState } from "react";
import { createPortal } from "react-dom";
import { CHECKPOINT_HELP, CHECKPOINT_EXCLUSIONS, checkpointTitle } from "@milagre/shared/checkpoints";
import { useCheckpoints } from "@milagre/shared/use-checkpoints";
import { useBridge } from "../../lib/computer-bridge";
import { ScrollArea } from "../primitives/ScrollArea";

export function CheckpointControl({ chatId }: { chatId: string }) {
  const [open, setOpen] = useState(false);
  return (
    <>
      <button
        data-checkpoints-open
        onClick={() => setOpen(true)}
        className="mx-3 mb-2 rounded-control border border-line px-3 py-2 text-left text-[12px] text-ink-2 hover:bg-hover"
      >
        Checkpoints
      </button>
      {open && <CheckpointDialog key={chatId} chatId={chatId} onClose={() => setOpen(false)} />}
    </>
  );
}

function CheckpointDialog({ chatId, onClose }: { chatId: string; onClose: () => void }) {
  const bridge = useBridge();
  const review = useCheckpoints(bridge.checkpoints, chatId);
  const dialog = useRef<HTMLDialogElement>(null);
  useEffect(() => {
    const previous = document.activeElement as HTMLElement | null;
    dialog.current?.showModal();
    void review.load();
    return () => previous?.focus();
    // The dialog is mounted once for this Chat.
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, []);
  return createPortal(
    <dialog
      ref={dialog}
      data-checkpoints-dialog
      onCancel={(event) => {
        event.preventDefault();
        if (!review.pending) onClose();
      }}
      onClick={(event) => {
        if (event.target === event.currentTarget && !review.pending) onClose();
      }}
      className="m-auto w-[min(680px,calc(100vw-32px))] rounded-card border border-line bg-surface p-0 text-ink shadow-overlay backdrop:bg-black/40 backdrop:backdrop-blur-overlay"
    >
      <div className="flex max-h-[85vh] flex-col" onClick={(event) => event.stopPropagation()}>
        <header className="flex items-center justify-between border-b border-line px-5 py-4">
          <h2 className="text-[16px] font-semibold">Checkpoints</h2>
          <button aria-label="Close checkpoints" onClick={onClose} disabled={review.pending} className="text-[13px] text-ink-2 disabled:opacity-40">
            Close
          </button>
        </header>
        <ScrollArea className="min-h-0 flex-1 p-5">
          <p className="mb-3 text-[12px] leading-relaxed text-ink-2">{CHECKPOINT_HELP}</p>
          <p className="mb-4 text-[11px] leading-relaxed text-ink-3">{CHECKPOINT_EXCLUSIONS}</p>
          {review.error && (
            <p role="alert" className="mb-3 text-[13px] text-red">
              {review.error}
            </p>
          )}
          {review.notice && (
            <p role="status" className="mb-3 text-[13px] text-green">
              {review.notice}
            </p>
          )}
          {review.pending && (
            <p role="status" className="py-3 text-[13px] text-ink-3">
              Working...
            </p>
          )}
          {!review.preview ? (
            <div className="flex flex-col gap-2">
              {!review.pending && !review.items.length && (
                <p className="py-6 text-[13px] text-ink-3">No checkpoints yet. A checkpoint is saved before each task starts.</p>
              )}
              {review.items.map((item) => (
                <button
                  key={item.id}
                  data-checkpoint-id={item.id}
                  disabled={review.pending}
                  onClick={() => void review.inspect(item.id)}
                  className="rounded-control border border-line px-3 py-3 text-left text-[13px] hover:bg-hover disabled:opacity-40"
                >
                  {checkpointTitle(item)}
                  <span className="mt-1 block text-[11px] text-ink-3">
                    {item.completedAt ? "Preview affected files" : "Running or interrupted task"} · {item.excluded} excluded
                  </span>
                </button>
              ))}
            </div>
          ) : (
            <div data-checkpoint-preview className="flex flex-col gap-3">
              <div className="flex items-start justify-between gap-3">
                <div>
                  <h3 className="text-[13px] font-medium">{checkpointTitle(review.preview)}</h3>
                  <p className="mt-1 text-[11px] text-ink-3">
                    {review.preview.files.length} affected files · {review.preview.excluded} excluded · {review.preview.permissionMode} mode
                  </p>
                </div>
                <button disabled={review.pending} onClick={() => void review.inspect(review.preview!.id)} className="shrink-0 text-[12px] text-ink-2">
                  Preview again
                </button>
              </div>
              {!review.preview.files.length && <p className="py-4 text-[13px] text-ink-3">No files need restoring.</p>}
              {review.preview.files.map((file) => (
                <div key={file.key} data-checkpoint-file className="rounded-control border border-line p-3">
                  <p className="break-all font-mono text-[12px]">{file.path}</p>
                  <p className="mt-1 break-all text-[11px] text-ink-3">{file.worktree}</p>
                  <div className="mt-2 flex flex-wrap items-center justify-between gap-2">
                    <span className={`text-[12px] ${file.conflict ? "text-orange" : "text-ink-2"}`}>
                      {file.conflict ? "Conflict: changed after task or interrupted capture" : "Review changes made during task"} · {file.action}
                    </span>
                    <div role="group" aria-label={`Decision for ${file.path}`} className="flex gap-2">
                      {(["keep", "restore"] as const).map((choice) => (
                        <button
                          key={choice}
                          data-checkpoint-choice={choice}
                          aria-pressed={review.decisions[file.key] === choice}
                          disabled={review.pending}
                          onClick={() => review.choose(file.key, choice)}
                          className={`rounded-control border px-2 py-1.5 text-[12px] ${review.decisions[file.key] === choice ? "border-ink bg-ink text-surface" : "border-line text-ink-2"}`}
                        >
                          {choice === "keep" ? "Keep current" : "Restore checkpoint"}
                        </button>
                      ))}
                    </div>
                  </div>
                </div>
              ))}
            </div>
          )}
        </ScrollArea>
        <footer className="flex items-center justify-between gap-3 border-t border-line px-5 py-4">
          <button disabled={review.pending} onClick={() => void review.load()} className="text-[13px] text-ink-2">
            Back to checkpoints
          </button>
          {review.preview && (
            <button
              data-checkpoint-restore
              disabled={review.pending || !review.resolved || !!review.error}
              onClick={() => void review.restore()}
              className="rounded-control bg-ink px-4 py-2 text-[13px] text-surface disabled:opacity-40"
            >
              Confirm restore ({review.restoreCount})
            </button>
          )}
        </footer>
      </div>
    </dialog>,
    document.body,
  );
}
