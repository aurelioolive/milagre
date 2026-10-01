const { app, BrowserWindow, dialog, ipcMain, nativeImage } = require("electron");
const { execFile } = require("node:child_process");
const fs = require("node:fs/promises");
const path = require("node:path");
const { promisify } = require("node:util");
const { runAgent } = require("./agent-runner.cjs");
const { discoverSkills, expandSkillPrompt } = require("./skills.cjs");

const execFileAsync = promisify(execFile);

const stateFile = (projectPath) => path.join(projectPath, ".milagre", "coordination.json");
const appIconPath = path.join(__dirname, "../app/public/logo-milagre-image.png");
let activeAgentProcess = null;

function emptyState(projectName) {
  return {
    next_id: 1,
    projects: { 1: { id: 1, name: projectName } },
    worktrees: {},
    sessions: {},
    connections: {},
    events: [],
    messages: [],
    approvals: [],
    tasks: {},
    artifacts: {},
    outputs: [],
    conflicts: [],
  };
}

async function discoverWorktrees(projectPath) {
  try {
    const { stdout } = await execFileAsync("git", ["-C", projectPath, "worktree", "list", "--porcelain"], { encoding: "utf8" });
    return stdout
      .trim()
      .split(/\n(?=worktree )/)
      .filter(Boolean)
      .map((block) => {
        const worktreePath = block.match(/^worktree (.+)$/m)?.[1];
        const branchRef = block.match(/^branch (.+)$/m)?.[1];
        if (!worktreePath) return null;
        const branch = branchRef?.replace(/^refs\/heads\//, "");
        return { path: worktreePath, name: branch || path.basename(worktreePath) };
      })
      .filter(Boolean);
  } catch {
    return [];
  }
}

function reconcileState(rawState, projectName, discoveredWorktrees) {
  const state = rawState ?? emptyState(projectName);
  const existingWorktrees = Object.values(state.worktrees ?? {});
  const existingSessions = Object.values(state.sessions ?? {});
  let nextId = Math.max(state.next_id ?? 1, ...[
    ...existingWorktrees.map((item) => item.id),
    ...existingSessions.map((item) => item.id),
  ]) || 1;
  const allocateId = () => nextId++;
  const existingByPath = new Map(existingWorktrees.map((worktree) => [worktree.path, worktree]));
  const worktrees = {};
  const sessions = {};

  for (const discovered of discoveredWorktrees) {
    const previous = existingByPath.get(discovered.path);
    const worktree = previous ?? { id: allocateId(), project_id: 1, path: discovered.path, name: discovered.name };
    worktrees[worktree.id] = { ...worktree, project_id: 1, path: discovered.path, name: discovered.name };
    const previousSession = existingSessions.find((session) => session.worktree_id === worktree.id);
    const session = previousSession ?? { id: allocateId(), worktree_id: worktree.id, agent_name: discovered.name, status: "Created" };
    sessions[session.id] = { ...session, worktree_id: worktree.id, agent_name: session.agent_name || discovered.name };
  }

  const validWorktreeIds = new Set(Object.values(worktrees).map((worktree) => worktree.id));
  const validSessionIds = new Set(Object.values(sessions).map((session) => session.id));
  const events = (state.events ?? []).filter((event) => validWorktreeIds.has(event.worktree_id));
  const tasks = Object.fromEntries(Object.entries(state.tasks ?? {}).filter(([, task]) => validWorktreeIds.has(task.worktree_id)));
  const artifacts = Object.fromEntries(Object.entries(state.artifacts ?? {}).filter(([, artifact]) => validWorktreeIds.has(artifact.worktree_id)));

  return {
    ...state,
    next_id: nextId,
    projects: { 1: { id: 1, name: projectName } },
    worktrees,
    sessions,
    connections: Object.fromEntries(Object.entries(state.connections ?? {}).filter(([, connection]) => validWorktreeIds.has(connection.left_worktree_id) && validWorktreeIds.has(connection.right_worktree_id))),
    events,
    messages: (state.messages ?? []).filter((message) => validSessionIds.has(message.session_id)),
    tasks,
    artifacts,
  };
}

async function readProject(projectPath) {
  const name = path.basename(projectPath) || "Untitled project";
  let storedState = null;
  try {
    const contents = await fs.readFile(stateFile(projectPath), "utf8");
    storedState = JSON.parse(contents);
  } catch {}
  const discoveredWorktrees = await discoverWorktrees(projectPath);
  const state = reconcileState(storedState, name, discoveredWorktrees);
  if (storedState && JSON.stringify(storedState) !== JSON.stringify(state)) await saveProject(projectPath, state);
  return { path: projectPath, name, state };
}

async function saveProject(projectPath, state) {
  const directory = path.join(projectPath, ".milagre");
  await fs.mkdir(directory, { recursive: true });
  await fs.writeFile(stateFile(projectPath), JSON.stringify(state, null, 2));
}

ipcMain.handle("skills:list", (_event, projectPath) => discoverSkills(projectPath));

ipcMain.handle("agent:send", async (_event, request) => {
  const prompt = await expandSkillPrompt(request.projectPath, request.prompt);
  const instruction = [
    "You are an agent inside Milagre, an agent development environment.",
    "Answer the user concisely and humanly. Do not claim to have changed files unless you actually did.",
    "The user is asking from the shared project context below:",
    prompt,
  ].join("\n\n");

  // Ask approval is handled by Milagre's confirmation dialog before this IPC
  // call. The child process is intentionally non-interactive, so after that
  // approval it must not wait for a terminal prompt that cannot be answered.
  const permissionMode = request.permissionMode || "ask";

  if (request.provider === "codex") {
    const codexPermissionArgs = permissionMode === "full"
      ? ["--dangerously-bypass-approvals-and-sandbox"]
      : ["--approve-for-me"];
    return runAgent("codex", [
      "exec",
      "--model", request.model,
      "--cd", request.projectPath,
      ...codexPermissionArgs,
      "--ephemeral",
      "--color", "never",
      instruction,
    ], request.projectPath, { onSpawn: (child) => { activeAgentProcess = child; } }).finally(() => {
      activeAgentProcess = null;
    });
  }

  return runAgent("claude", [
    "--print",
    "--model", request.model,
    "--add-dir", request.projectPath,
    ...(permissionMode === "full" ? ["--dangerously-skip-permissions"] : ["--permission-mode", "acceptEdits"]),
    instruction,
  ], request.projectPath, { onSpawn: (child) => { activeAgentProcess = child; } }).finally(() => {
    activeAgentProcess = null;
  });
});

ipcMain.handle("agent:cancel", () => {
  if (!activeAgentProcess) return false;
  activeAgentProcess.kill("SIGTERM");
  return true;
});

function createWindow() {
  const window = new BrowserWindow({
    width: 1240,
    height: 820,
    minWidth: 980,
    minHeight: 680,
    title: "Milagre",
    icon: appIconPath,
    backgroundColor: "#f7faf8",
    webPreferences: {
      preload: path.join(__dirname, "preload.cjs"),
      contextIsolation: true,
      nodeIntegration: false,
    },
  });

  if (!app.isPackaged) {
    window.loadURL(process.env.MILAGRE_DEV_SERVER_URL || "http://127.0.0.1:5173");
  } else {
    window.loadFile(path.join(__dirname, "../dist/index.html"));
  }
}

ipcMain.handle("project:current", () => readProject(process.cwd()));
ipcMain.handle("project:open", async () => {
  const result = await dialog.showOpenDialog({
    title: "Open project",
    properties: ["openDirectory", "createDirectory"],
  });
  if (result.canceled || !result.filePaths[0]) return null;
  return readProject(result.filePaths[0]);
});
ipcMain.handle("project:save", (_event, projectPath, state) => saveProject(projectPath, state));

app.whenReady().then(() => {
  app.setName("Milagre");
  if (process.platform === "darwin" && app.dock) {
    const appIcon = nativeImage.createFromPath(appIconPath);
    if (!appIcon.isEmpty()) app.dock.setIcon(appIcon);
  }
  createWindow();
  app.on("activate", () => {
    if (BrowserWindow.getAllWindows().length === 0) createWindow();
  });
});

app.on("window-all-closed", () => {
  if (process.platform !== "darwin") app.quit();
});
