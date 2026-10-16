# Task checkpoints

Open a Chat's **Changes** panel, then **Checkpoints**. Desktop and paired phones use the same checkpoints, stored locally on the owning Computer. Milagre saves one before a task starts; messages steering a running task share its checkpoint. It does not create Git commits or change the staging area.

1. Choose a checkpoint to preview the files that would be created, replaced or deleted.
2. Choose **Keep current** or **Restore checkpoint** for each file. Files changed after the task ended, or without a complete end capture after interruption, are marked as conflicts. Edits made during the task can also belong to you or another Chat, so every file needs a decision.
3. Press **Confirm restore**. This explicit confirmation is required in Ask, Auto and Full modes. A changed file, exclusion rule or Worktree identity invalidates the preview. Preview again and review the new state.

Restoring waits until all Chats and subagents in the affected Worktrees finish. Only files changed during that task are candidates; unrelated later files stay in place. Shared Link Chats cover their owned Worktrees. Checkpoints survive app and daemon restarts. Interrupted checkpoints are recoverable with conservative conflict review.

Before writing, Milagre saves a **Before restore** recovery checkpoint. Use it to recover from a mistaken or partially completed restore. If a restore fails partway through, a file may be partially written. The error reports its recovery checkpoint and the number of fully restored files. External editors do not share Milagre's locks: keep them idle during the confirmed write. Milagre rechecks each target immediately before writing it, but cannot make a group of filesystem writes atomic against external programs.

## Exclusions and limits

Milagre captures regular Git-tracked files and nonignored untracked files. It excludes symlinks, hard links, Git/Milagre metadata, generated directories (`node_modules`, `dist`, `build`, `coverage`, `.next`, `.expo`, `.cache`), common secret filenames (`.env*`, credentials, private keys and package-manager credentials), and recognized private-key/token content. Filename and token checks cannot recognize every possible secret: configure Project-specific exclusions before a task.

Create `.milagre/checkpoint-ignore` in each Worktree with one relative glob per line, for example:

```
private/**
**/*.cache
config/production.json
```

Blank lines and lines starting with `#` are ignored. Rules are exclusion-only, with no negation or Git-ignore directory shorthand. Use `path/**` for directories. The checkpoint list and preview show exclusion counts. An excluded file is never restored, including when new rules exclude a file saved by an older checkpoint.

A file over 5 MiB or a snapshot over 100 MiB stops capture and prevents the task from starting. Add an exclusion for large generated files, then resend. Checkpoints and deduplicated file contents are private to the daemon's data directory; there is currently no automatic retention limit. They are local recovery data, not a backup outside the Computer.
