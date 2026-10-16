const test = require("node:test");
const assert = require("node:assert/strict");
const fs = require("node:fs/promises");
const path = require("node:path");
const os = require("node:os");
const { execFileSync } = require("node:child_process");
const { createRuntime } = require("./runtime.cjs");
const { runTool } = require("./linked-tools.cjs");
const { waitUntil } = require("./agents/test-helpers.cjs");

// waitUntil for a check that reads through the runtime.
async function eventually(check, { timeoutMs = 3000 } = {}) {
  const deadline = Date.now() + timeoutMs;
  while (!(await check())) {
    if (Date.now() > deadline) throw new Error("Timed out waiting for condition");
    await new Promise((resolve) => setTimeout(resolve, 10));
  }
}

// A runtime with one Chat on a fake agent, the routine clock and timer in the test's hands.
async function fixture(t, { enable = true } = {}) {
  const dir = await fs.realpath(await fs.mkdtemp(path.join(os.tmpdir(), "runtime-routines-")));
  const project = path.join(dir, "project");
  await fs.mkdir(project);
  execFileSync("git", ["init", "-qb", "main", project]);
  const sessions = [];
  const emitted = [];
  // What publishAgentEvent hands on, with whether the Chat's run still held its streamed text at that moment.
  const published = [];
  let clock = Date.UTC(2026, 9, 16, 12, 0);
  let tickFn = null;
  let runtime;
  runtime = createRuntime({
    dataDir: path.join(dir, "data"),
    cwd: project,
    environmentReady: Promise.resolve(),
    titleModels: {},
    agentCli: async () => ({ command: "fixture" }),
    emit: (channel, payload) => emitted.push({ channel, payload }),
    observeAgentEvent: (chatId, event) =>
      published.push({ chatId, type: event.type, quiet: event.quiet, runText: runtime?.snapshot().runs.runs[chatId]?.text }),
    routines: {
      now: () => clock,
      setInterval: (fn) => {
        tickFn = fn;
        return { unref() {} };
      },
      clearInterval: () => {
        tickFn = null;
      },
    },
    createSession(provider, options) {
      const session = {
        provider,
        options,
        turns: [],
        turnActive: false,
        startTurn: async (request) => {
          session.turns.push(request);
          session.turnActive = true;
          // A native session, so the next turn resumes it instead of restoring the Chat from a brief.
          if (session.turns.length === 1) options.emit({ type: "session-started", nativeId: "native-1" });
          options.emit({ type: "turn-started", turnId: `turn-${session.turns.length}` });
          return { turnId: `turn-${session.turns.length}` };
        },
        interrupt: async () => {
          session.turnActive = false;
          options.emit({ type: "turn-cancelled" });
        },
        close: async () => {},
        // Each string streams as text; a tool step runs between consecutive ones, as an agent's turn reads.
        finish: (...texts) => {
          session.turnActive = false;
          texts.forEach((text, index) => {
            if (index > 0) {
              const id = `step-${session.turns.length}-${index}`;
              options.emit({ type: "step-started", step: { id, kind: "shell", title: "Ran `gh pr checks`" } });
              options.emit({ type: "step-completed", id, status: "done" });
            }
            options.emit({ type: "text-delta", messageId: `reply-${session.turns.length}`, text });
          });
          options.emit({ type: "turn-completed" });
        },
      };
      sessions.push(session);
      return session;
    },
  });
  t.after(async () => {
    await runtime.close();
    await fs.rm(dir, { recursive: true, force: true });
  });
  if (enable) assert.deepEqual(await runtime.invoke("routines:enabled:save", [true]), { enabled: true });
  const opened = await runtime.openProject(project);
  const id = Object.values(opened.state.sessions)[0].id;
  const chatId = `${project}#${id}`;
  await runtime.invoke("chat:send", [{ projectPath: project, sessionId: id, body: "Watch CI", provider: "claude", model: "cm", permissionMode: "full" }]);
  await waitUntil(() => sessions.length === 1 && sessions[0].turns.length === 1);
  const session = sessions[0];
  const messages = async () => (await runtime.invoke("project:snapshot", [project])).state.messages.filter((m) => m.session_id === id);
  const tool = (name) => session.options.linked.tools.find((item) => item.name === name);
  const list = async () => (await runtime.invoke("routines:list")).routines;
  const ends = () => published.filter((item) => item.type === "turn-completed").length;
  const finish = async (...texts) => {
    const before = ends();
    session.finish(...texts);
    await waitUntil(() => ends() > before);
  };
  // Moves the routine clock past the next beat and runs one tick, then waits for what it dispatched to settle.
  const beat = async () => {
    const [routine] = await list();
    clock = routine.nextRunAt + 1000;
    assert.ok(tickFn, "the scheduler is ticking");
    tickFn();
  };
  return { runtime, project, id, chatId, session, sessions, emitted, published, messages, tool, list, finish, beat, advance: (ms) => (clock += ms) };
}

const latestRun = async (f) => (await f.list())[0]?.runs[0];

test("the switch is off by default: no routine tools and no ticks", async (t) => {
  const f = await fixture(t, { enable: false });
  assert.deepEqual(await f.runtime.invoke("routines:enabled:read"), { enabled: false });
  assert.equal(f.tool("heartbeat_create"), undefined);
  assert.equal(f.tool("routine_list"), undefined);
  assert.deepEqual(await f.list(), []);
  await assert.rejects(f.runtime.invoke("routines:run-now", ["missing"]), /Routines are off/);
});

test("a heartbeat an agent sets fires into its Chat, and a (pass) reply ends quiet", async (t) => {
  const f = await fixture(t);
  assert.ok(
    f.emitted.some((item) => item.channel === "routines:changed"),
    "saving the switch says so",
  );
  const created = await runTool(f.tool("heartbeat_create"), { name: "Babysit", prompt: "Check CI on PR 77", every: "5m" });
  assert.equal(created.isError, false, created.text);
  const [routine] = await f.list();
  assert.equal(routine.name, "Babysit");
  assert.equal(routine.target.chatId, f.chatId);
  assert.equal(routine.provider, "claude");
  assert.equal(routine.permissionMode, "full");
  assert.deepEqual(routine.runs, []);
  assert.ok(f.emitted.filter((item) => item.channel === "routines:changed").length >= 2, "a tool's write says so too");
  await f.finish("Watching.");

  await f.beat();
  await waitUntil(() => f.session.turns.length === 2);
  const divider = (await f.messages()).findLast((message) => message.role === "user");
  assert.equal(divider.context.kind, "routine-run");
  assert.equal(divider.context.routineId, routine.id);
  assert.equal(divider.context.name, "Babysit");
  assert.equal(divider.body, "Check CI on PR 77");
  assert.match(f.session.turns[1].prompt, /^Check CI on PR 77\n\nIf nothing needs doing, reply starting with "\(pass\)"/);
  assert.equal(f.session.turns[1].model, "cm");
  assert.equal(f.session.turns[1].permissionMode, "full");
  // Ruling 1: the routine's turn-started goes through publishAgentEvent.
  assert.ok(f.published.filter((item) => item.type === "turn-started").length >= 2);
  assert.equal((await latestRun(f)).status, "running");

  await f.finish("(pass) CI green");
  await eventually(async () => (await latestRun(f)).status === "quiet");
  const run = await latestRun(f);
  assert.equal(run.summary, "CI green");
  assert.equal(run.chatId, f.chatId);
  const end = f.published.findLast((item) => item.type === "turn-completed");
  // The terminal event is marked before anyone hears it, and the streamed run is already folded away by then (ruling 2).
  assert.equal(end.quiet, true);
  assert.equal(end.runText, undefined);
  await eventually(async () => (await f.messages()).find((message) => message.id === divider.id).context.quiet === true);
  const patched = (await f.messages()).find((message) => message.id === divider.id);
  assert.equal(patched.context.summary, "CI green");
  assert.equal(patched.context.runId, run.id);

  // The next beat acts: no quiet mark on its end.
  await f.beat();
  await waitUntil(() => f.session.turns.length === 3);
  await f.finish("CI failed, fixing the test.");
  await eventually(async () => (await latestRun(f)).status === "acted");
  assert.equal(f.published.findLast((item) => item.type === "turn-completed").quiet, undefined);
  const acted = (await f.messages()).findLast((message) => message.context?.kind === "routine-run");
  await eventually(async () => (await f.messages()).find((message) => message.id === acted.id).context.quiet === false);
});

test("a beat while the Chat's turn runs is skipped busy", async (t) => {
  const f = await fixture(t);
  await runTool(f.tool("heartbeat_create"), { name: "Babysit", prompt: "Check CI", every: "5m" });
  // The first turn is still running.
  await f.beat();
  await eventually(async () => (await latestRun(f))?.status === "skipped-busy");
  assert.equal(f.session.turns.length, 1);
});

test("archiving the Chat ends its heartbeats", async (t) => {
  const f = await fixture(t);
  await runTool(f.tool("heartbeat_create"), { name: "Babysit", prompt: "Check CI", every: "5m" });
  await f.finish("ok");
  assert.equal((await f.list()).length, 1);
  await f.runtime.invoke("chat:patch", [f.project, f.id, { archived: true }]);
  assert.deepEqual(await f.list(), []);
});

test("commands update, run now and delete a routine, each saying routines changed", async (t) => {
  const f = await fixture(t);
  await runTool(f.tool("heartbeat_create"), { name: "Babysit", prompt: "Check CI", every: "5m" });
  await f.finish("ok");
  const [routine] = await f.list();
  const changes = () => f.emitted.filter((item) => item.channel === "routines:changed").length;

  let before = changes();
  const updated = await f.runtime.invoke("routines:update", [routine.id, { prompt: "Check CI and deploys" }]);
  assert.equal(updated.prompt, "Check CI and deploys");
  assert.ok(changes() > before);

  before = changes();
  const run = await f.runtime.invoke("routines:run-now", [routine.id]);
  assert.equal(run.status, "running");
  assert.ok(changes() > before);
  await waitUntil(() => f.session.turns.length === 2);
  await f.finish("(pass) nothing new");
  await eventually(async () => (await latestRun(f)).status === "quiet");

  before = changes();
  assert.deepEqual(await f.runtime.invoke("routines:delete", [routine.id]), { removed: true });
  assert.ok(changes() > before);
  assert.deepEqual(await f.list(), []);
  await assert.rejects(f.runtime.invoke("routines:update", [routine.id, { prompt: "x" }]), /Routine not found/);

  // Off again: the tools go, and the tick stops acting.
  assert.deepEqual(await f.runtime.invoke("routines:enabled:save", [false]), { enabled: false });
  assert.deepEqual(await f.runtime.invoke("routines:enabled:read"), { enabled: false });
});

test("a beat that checks with a tool, then ends with (pass), is quiet; a (pass) followed by real work acts", async (t) => {
  const f = await fixture(t);
  await runTool(f.tool("heartbeat_create"), { name: "Babysit", prompt: "Check CI", every: "5m" });
  await f.finish("ok");
  await f.beat();
  await waitUntil(() => f.session.turns.length === 2);
  await f.finish("Let me check CI.", "(pass) CI green");
  await eventually(async () => (await latestRun(f)).status === "quiet");
  assert.equal((await latestRun(f)).summary, "CI green");
  assert.equal(f.published.findLast((item) => item.type === "turn-completed").quiet, true);

  await f.beat();
  await waitUntil(() => f.session.turns.length === 3);
  await f.finish("(pass) looks fine at first.", "Actually CI failed, fixing the test.");
  await eventually(async () => (await latestRun(f)).status === "acted");
  assert.equal(f.published.findLast((item) => item.type === "turn-completed").quiet, undefined);
});

test("a live session's routine tools stop working once the switch is off", async (t) => {
  const f = await fixture(t);
  assert.equal((await runTool(f.tool("routine_list"), {})).isError, false);
  await f.runtime.invoke("routines:enabled:save", [false]);
  for (const [name, args] of [
    ["routine_list", {}],
    ["heartbeat_create", { name: "Babysit", prompt: "Check CI", every: "5m" }],
  ]) {
    const result = await runTool(f.tool(name), args);
    assert.equal(result.isError, true, name);
    assert.equal(result.text, "Routines are turned off in Settings › Experimental.");
  }
  assert.deepEqual(await f.list(), []);
});

test("a quiet beat leaves the Chat's unread mark as it was; a beat that acts marks it unread", async (t) => {
  const f = await fixture(t);
  await runTool(f.tool("heartbeat_create"), { name: "Babysit", prompt: "Check CI", every: "5m" });
  await f.finish("Watching.");
  const unread = async () => (await f.runtime.invoke("project:snapshot", [f.project])).state.sessions[f.id].unread === true;
  await eventually(unread);
  await f.runtime.invoke("chat:patch", [f.project, f.id, { unread: false }]);
  assert.equal(await unread(), false);

  await f.beat();
  await waitUntil(() => f.session.turns.length === 2);
  await f.finish("(pass) CI green");
  await eventually(async () => (await f.messages()).findLast((message) => message.context?.kind === "routine-run").context.quiet === true);
  assert.equal(await unread(), false, "a quiet beat leaves no unread mark");

  await f.beat();
  await waitUntil(() => f.session.turns.length === 3);
  await f.finish("CI failed, fixing the test.");
  await eventually(async () => (await latestRun(f)).status === "acted");
  assert.equal(await unread(), true, "a beat that acts marks the Chat unread");
});
