import { useMemo, useState } from "react";
import { Text, View } from "react-native";
import { CHECKPOINT_HELP, CHECKPOINT_EXCLUSIONS, checkpointTitle, type CheckpointApi } from "@milagre/shared/checkpoints";
import { useCheckpoints } from "@milagre/shared/use-checkpoints";
import { useSession } from "./session";
import { Button, ErrorNotice, ListRow, PillButton, useStyles } from "./ui";

/** Lives in the existing Changes scroller, on both Project and shared Link Chats. */
export function CheckpointControl({ chatId }: { chatId: string }) {
  const styles = useStyles();
  const { client } = useSession();
  const [open, setOpen] = useState(false);
  const api = useMemo<CheckpointApi>(
    () => ({
      list: (request) => client!.call("checkpoint:list", [request]),
      preview: (request) => client!.call("checkpoint:preview", [request]),
      restore: (request) => client!.call("checkpoint:restore", [request]),
    }),
    [client],
  );
  const review = useCheckpoints(api, chatId);
  if (!client) return null;
  return (
    <View style={styles.card}>
      <PillButton
        title={open ? "Close checkpoints" : "Checkpoints"}
        secondary
        disabled={review.pending}
        onPress={() => {
          setOpen(!open);
          if (!open) void review.load();
        }}
      />
      {open && (
        <>
          <Text style={styles.muted}>{CHECKPOINT_HELP}</Text>
          <Text style={styles.caption}>{CHECKPOINT_EXCLUSIONS}</Text>
          {!!review.error && <ErrorNotice message={review.error} />}
          {!!review.notice && (
            <Text accessibilityRole="alert" style={styles.text}>
              {review.notice}
            </Text>
          )}
          {review.pending && <Text style={styles.muted}>Working...</Text>}
          {!review.preview ? (
            <>
              {!review.pending && !review.items.length && <Text style={styles.muted}>No checkpoints yet. A checkpoint is saved before each task starts.</Text>}
              {review.items.map((item) => (
                <ListRow
                  key={item.id}
                  title={checkpointTitle(item)}
                  subtitle={`${item.completedAt ? "Preview affected files" : "Running or interrupted task"} · ${item.excluded} excluded`}
                  disabled={review.pending}
                  onPress={() => void review.inspect(item.id)}
                />
              ))}
              <PillButton title="Refresh checkpoints" secondary disabled={review.pending} onPress={() => void review.load()} />
            </>
          ) : (
            <>
              <Text style={styles.label}>{checkpointTitle(review.preview)}</Text>
              <Text style={styles.caption}>
                {review.preview.files.length} affected files · {review.preview.excluded} excluded · {review.preview.permissionMode} mode
              </Text>
              <PillButton title="Preview again" secondary disabled={review.pending} onPress={() => void review.inspect(review.preview!.id)} />
              {!review.preview.files.length && <Text style={styles.muted}>No files need restoring.</Text>}
              {review.preview.files.map((file) => (
                <View key={file.key} style={{ gap: 8, paddingVertical: 12, borderTopWidth: 0.5 }}>
                  <Text selectable style={styles.code}>
                    {file.path}
                  </Text>
                  <Text selectable style={styles.caption}>
                    {file.worktree}
                  </Text>
                  <Text style={styles.label}>
                    {file.conflict ? "Conflict: changed after task or interrupted capture" : "Review changes made during task"} · {file.action}
                  </Text>
                  <View accessibilityLabel={`Decision for ${file.path}`} style={{ gap: 6 }}>
                    <PillButton
                      title={review.decisions[file.key] === "keep" ? "Keep current (selected)" : "Keep current"}
                      secondary={review.decisions[file.key] !== "keep"}
                      disabled={review.pending}
                      onPress={() => review.choose(file.key, "keep")}
                    />
                    <PillButton
                      title={review.decisions[file.key] === "restore" ? "Restore checkpoint (selected)" : "Restore checkpoint"}
                      secondary={review.decisions[file.key] !== "restore"}
                      disabled={review.pending}
                      onPress={() => review.choose(file.key, "restore")}
                    />
                  </View>
                </View>
              ))}
              <Button
                title={`Confirm restore (${review.restoreCount})`}
                disabled={review.pending || !review.resolved || !!review.error}
                onPress={() => void review.restore()}
              />
              <PillButton title="Back to checkpoints" secondary disabled={review.pending} onPress={() => void review.load()} />
            </>
          )}
        </>
      )}
    </View>
  );
}
