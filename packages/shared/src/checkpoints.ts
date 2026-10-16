import type { PermissionMode } from "./model.js";

export type Checkpoint = {
  id: string;
  createdAt: number;
  completedAt?: number;
  kind: "task" | "recovery";
  permissionMode: PermissionMode;
  excluded: number;
};
export type CheckpointFile = {
  key: string;
  path: string;
  worktree: string;
  action: "create" | "replace" | "delete";
  conflict: boolean;
};
export type CheckpointPreview = Checkpoint & { token: string; files: CheckpointFile[] };
export type CheckpointDecision = "keep" | "restore";
export type CheckpointRestore = { chatId: string; token: string; decisions: Record<string, CheckpointDecision>; approved: boolean };
export type CheckpointApi = {
  list(request: { chatId: string }): Promise<Checkpoint[]>;
  preview(request: { chatId: string; id: string }): Promise<CheckpointPreview>;
  restore(request: CheckpointRestore): Promise<{ restored: number; recoveryId: string | null }>;
};
export const CHECKPOINT_HELP =
  "Review each file. Changes made during a task may include your edits or another Chat's work. A recovery checkpoint is saved before restoring. Git staging stays unchanged.";
export const CHECKPOINT_EXCLUSIONS =
  "Ignored files, secret filenames and recognized secret content, generated files and symlinks are excluded. Add exclusions in .milagre/checkpoint-ignore (one relative glob per line).";
export const checkpointTitle = (item: Checkpoint) =>
  `${item.kind === "recovery" ? "Before restore" : "Before task"} · ${new Date(item.createdAt).toLocaleString()}`;
