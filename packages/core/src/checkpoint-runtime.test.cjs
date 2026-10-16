const test = require("node:test");
const assert = require("node:assert/strict");
const fs = require("node:fs/promises");
const os = require("node:os");
const path = require("node:path");
const { execFileSync } = require("node:child_process");
const { createRuntime } = require("./runtime.cjs");
const { waitUntil } = require("./agents/test-helpers.cjs");
test("tasks capture once before execution; steering reuses the checkpoint; restore validates Chat and active Worktrees", async (t) => {
  const dir = await fs.realpath(await fs.mkdtemp(path.join(os.tmpdir(), "checkpoint-runtime-")));
  const project = path.join(dir, "project");
  await fs.mkdir(project);
  execFileSync("git", ["init", "-q", project]);
  await fs.writeFile(path.join(project, "work.txt"), "manual");
  let emit;
  let session;
  let started = 0;
  const runtime = createRuntime({
    dataDir: path.join(dir, "data"),
    environmentReady: Promise.resolve(),
    titleModels: {},
    agentCli: async () => ({ command: "fixture" }),
    createSession(_provider, options) {
      emit = options.emit;
      session = {
        turnActive: false,
        async startTurn() {
          started++;
          session.turnActive = true;
          options.emit({ type: "turn-started", turnId: "turn" });
          return { turnId: "turn" };
        },
        async close() {},
        async interrupt() {},
      };
      return session;
    },
  });
  t.after(async () => {
    await runtime.close();
    await fs.rm(dir, { recursive: true, force: true });
  });
  const opened = await runtime.openProject(project);
  const id = Object.values(opened.state.sessions)[0].id,
    chatId = `${project}#${id}`;
  const send = () =>
    runtime.invoke("chat:send", [{ projectPath: project, sessionId: id, body: "edit", provider: "codex", model: "test", permissionMode: "ask" }]);
  await send();
  await waitUntil(() => started === 1);
  let items = await runtime.invoke("checkpoint:list", [{ chatId }]);
  assert.equal(items.length, 1);
  await fs.writeFile(path.join(project, "work.txt"), "agent");
  await send();
  await waitUntil(() => started === 2);
  assert.equal((await runtime.invoke("checkpoint:list", [{ chatId }])).length, 1);
  await assert.rejects(runtime.invoke("checkpoint:preview", [{ chatId, id: items[0].id }]), /running|finish/i);
  session.turnActive = false;
  emit({ type: "turn-completed" });
  await waitUntil(async () => (await runtime.invoke("checkpoint:list", [{ chatId }]))[0].completedAt);
  const preview = await runtime.invoke("checkpoint:preview", [{ chatId, id: items[0].id }]);
  assert.equal(preview.files[0].path, "work.txt");
  await assert.rejects(runtime.invoke("checkpoint:preview", [{ chatId: `${project}#999`, id: items[0].id }]), /Chat/i);
  await assert.rejects(runtime.invoke("checkpoint:restore", [{ chatId, token: preview.token, decisions: { [preview.files[0].key]: "restore" } }]), /confirm/i);
  await runtime.invoke("checkpoint:restore", [{ chatId, token: preview.token, decisions: { [preview.files[0].key]: "restore" }, approved: true }]);
  assert.equal(await fs.readFile(path.join(project, "work.txt"), "utf8"), "manual");
});
