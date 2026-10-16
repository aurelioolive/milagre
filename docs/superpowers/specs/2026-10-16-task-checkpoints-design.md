# Task checkpoints

Issue: https://github.com/the-ptf/milagre/issues/12

A checkpoint saves the working files before each idle Chat starts a task. Steering messages share the running task's checkpoint. The daemon owns storage and restore; desktop and mobile expose the same review flow. No commits, index changes, native dependencies, builds or releases.

## Safety and scope

Save regular tracked and nonignored untracked files, including dirty files, in private daemon storage with an atomic manifest. Ignore secret filenames, recognized secret content, generated directories, symlinks, Git metadata and `.milagre`. `.milagre/checkpoint-ignore` adds newline-separated relative glob exclusions. Files over 5 MiB and snapshots over 100 MiB fail closed. Display exclusions and limitations. Checkpoints remain available across restarts.

Record an end snapshot at terminal agent events. Only paths changed between start and end are restore candidates; unrelated later files remain untouched. Every changed path requires a keep-current or restore-checkpoint decision, since filesystem snapshots cannot prove which writer made a change during a task. Files edited after the end snapshot are explicitly marked conflicts. Interrupted tasks with no end snapshot require conflict resolution for all candidates. Never infer ownership of concurrent manual or other Chat edits.

Preview shows paths, create/replace/delete effects and conflict status. A short-lived, single-use preview token binds the current bytes, modes, identity, exclusions and checkpoint. Restore requires explicit user confirmation in every permission mode, all conflicts resolved, and a fresh revalidation of every candidate. No restore while any Chat in the affected Worktree runs or starts. A fresh safety snapshot is persisted before writing. Never follow symlinks, invoke Git restore/reset/clean, or touch the index. Failures retain the safety snapshot for recovery.

File I/O runs in a short-lived Node worker. It pins its working directory, validates every traversed directory by inode, and uses basename-only operations. Restore writes through verified descriptors, including permission changes on read-only files. Individual writes can be partial on failure; the saved recovery checkpoint is the recovery path.

## Clients

A Checkpoints control in each Chat opens its saved task list. Preview lists all impacted paths. Each candidate has a required decision; restore remains disabled until review is complete. Errors remain visible and allow a fresh preview. Shared Link Chats cover each owned Worktree. Phone uses existing JS components and transport only.

## Verification

Real temporary Git repositories cover dirty/index state, untracked files, exclusion rules, modes, additions/deletions, restart recovery, conflicts, stale previews, symlinks, confirmation, active Chats and cross-Chat scoping. Runtime tests prove automatic capture and transport access. Electron and phone checks exercise list, preview, resolution and restore. Required root typecheck, lint, unit tests and affected screen checks run before PR creation. Screenshots live on the screenshots branch.
