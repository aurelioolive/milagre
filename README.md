# Milagre

Milagre is a local-first desktop ADE for coordinating coding agents across projects and git worktrees.

The current public alpha uses React and Electron. It is designed for a solo developer who wants to see related worktrees, share context between agent sessions, and keep approval-sensitive operations visible without losing the raw output.

> The project is experimental. Do not use Full permission mode in a workspace you cannot recover.

## What exists today

- A React renderer inside an Electron desktop shell.
- Project and worktree-oriented chat navigation.
- Codex and Claude CLI process integration through Electron's main process.
- Ask approval, Auto and Full permission modes.
- Tool approval cards for file changes and other write operations.
- Local coordination state under `.milagre/coordination.json`.
- Concise agent output with access to raw details.

The broader coordination graph, canvas and richer provider adapters are documented in [`docs/specs/001-agent-coordination-ade.md`](docs/specs/001-agent-coordination-ade.md).

## Requirements

- macOS
- Node.js 24 or newer
- npm
- At least one supported local CLI agent, such as Codex CLI or Claude Code

Milagre runs agent commands locally. It does not provide model credentials or a hosted inference service.

## Development

```bash
npm install
npm run dev
```

Useful checks:

```bash
npm run typecheck
npm run build
npm run test:agent
npm run release:dry
```

`npm run dev` starts Vite and opens the Electron shell. The renderer is served locally at port 5180 during development.

## Releases

Releases are automated from merges into `main` with `semantic-release`. Commit and Pull Request titles should use Conventional Commits:

```text
fix: correct agent cancellation       # patch release
feat: add worktree canvas             # minor release
feat!: change the coordination API    # major release
docs: clarify setup                   # no release
```

The release workflow creates a `vX.Y.Z` tag and a GitHub Release with generated notes. It does not publish an npm package and does not yet build signed Electron installers. Use `npm run release:dry` to inspect what would be released without creating a tag.

## Pasting images

Paste an image into the chat prompt with Cmd+V (Ctrl+V on other platforms). Images appear as removable thumbnails and can be sent with a prompt or on their own. PNG, JPEG, WebP, and GIF are supported, with up to four images per message and a 5 MB limit per image. Plain-text pasting is unchanged.

Sent images remain in the local conversation history. Claude receives image content through structured input; Codex receives temporary image files that are removed when its request finishes. Restart the development Electron process after updating to load the new image-handling backend.

## Permission modes

- **Ask approval**: pauses before risky write or execution operations and shows the requested command or change.
- **Auto**: allows ordinary agent work while retaining safeguards for higher-risk operations.
- **Full**: gives the selected CLI the broadest available local access. Use only when you explicitly trust the prompt and workspace.

The approval boundary is enforced in the Electron main process. The renderer can request work, but it should not receive arbitrary filesystem or process privileges.

## Repository layout

```text
app/       React renderer, components and styles
electron/  Electron main process, preload bridge and agent runner
scripts/   Development launch helpers
docs/      Product and domain documentation
```

## Contributing

Please read [`CONTRIBUTING.md`](CONTRIBUTING.md) before opening a pull request. For security-sensitive issues, follow [`SECURITY.md`](SECURITY.md).

## License

Milagre is released under the [MIT License](LICENSE).
