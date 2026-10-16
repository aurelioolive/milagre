const assert = require("node:assert/strict");
const fs = require("node:fs");
const os = require("node:os");
const path = require("node:path");
const test = require("node:test");
const { createRoutineStore } = require("./store.cjs");
const { createRoutineScheduler } = require("./scheduler.cjs");

const START = Date.UTC(2026, 0, 5, 10, 0, 0);
const PASS_HINT = '\n\nIf nothing needs doing, reply starting with "(pass)" and a short reason.';
const base = { chatId: "c1", name: "check", prompt: "look at CI", every: "15m", timezone: "UTC", createdBy: { kind: "user" } };

function setup({ enabled = true, chatOptions = {} } = {}) {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), "routine-scheduler-"));
  const clock = { t: START };
  let n = 0;
  const storeOptions = { file: path.join(dir, "routines.json"), now: () => clock.t, id: () => `id${++n}` };
  const store = createRoutineStore(storeOptions);
  store.setEnabled(enabled);
  const calls = { send: [], patch: [] };
  const state = { busy: false, archived: false, exists: true, reply: "", startResult: { turnId: "t1" }, sendError: null, patchError: null };
  const chats = {
    exists: () => state.exists,
    archived: () => state.archived,
    busy: () => state.busy,
    async send(chatId, message) {
      calls.send.push({ chatId, ...message });
      if (state.sendError) throw state.sendError;
      return { started: Promise.resolve(state.startResult) };
    },
    replyText: () => state.reply,
    async patchRunContext(chatId, runId, patch) {
      calls.patch.push({ chatId, runId, patch });
      if (state.patchError) throw state.patchError;
    },
    ...chatOptions,
  };
  const awakeCalls = [];
  const keepAwake = { setRoutinesActive: (active) => awakeCalls.push(active) };
  let changes = 0;
  const make = () => createRoutineScheduler({ store, chats, keepAwake, now: () => clock.t, onChange: () => (changes += 1) });
  const routine = store.upsertHeartbeat(base);
  return { store, storeOptions, clock, state, calls, awakeCalls, routine, make, scheduler: make(), changes: () => changes };
}

const due = (ctx) => (ctx.clock.t = ctx.routine.nextRunAt);
const lastRun = (ctx) => ctx.store.runs(ctx.routine.id)[0];

test("a due beat sends the prompt with the pass hint and a routine-run context", async () => {
  const ctx = setup();
  due(ctx);
  await ctx.scheduler.tick();
  assert.equal(ctx.calls.send.length, 1);
  const sent = ctx.calls.send[0];
  assert.equal(sent.chatId, "c1");
  assert.equal(sent.body, "look at CI");
  assert.equal(sent.prompt, `look at CI${PASS_HINT}`);
  assert.deepEqual(sent.context, { kind: "routine-run", routineId: ctx.routine.id, runId: lastRun(ctx).id, name: "check", at: ctx.clock.t });
  assert.equal(lastRun(ctx).status, "running");
  assert.ok(ctx.changes() > 0);
});

test("a Chat with a turn running records skipped-busy and sends nothing", async () => {
  const ctx = setup();
  ctx.state.busy = true;
  due(ctx);
  await ctx.scheduler.tick();
  assert.equal(ctx.calls.send.length, 0);
  assert.equal(lastRun(ctx).status, "skipped-busy");
  assert.equal(ctx.store.get(ctx.routine.id).runCount, 0);
});

test("a Chat waiting on an approval or question is busy too", async () => {
  // The adapter folds pending approvals and questions into busy(); the scheduler only trusts that answer.
  const ctx = setup({ chatOptions: { busy: () => "approval pending" } });
  due(ctx);
  await ctx.scheduler.tick();
  assert.equal(ctx.calls.send.length, 0);
  assert.equal(lastRun(ctx).status, "skipped-busy");
});

test("a second claim for a Chat with a pending run is skipped-busy", async () => {
  const ctx = setup();
  const other = ctx.store.upsertHeartbeat({ ...base, name: "other" });
  ctx.clock.t = Math.max(ctx.routine.nextRunAt, other.nextRunAt);
  await ctx.scheduler.tick();
  assert.equal(ctx.calls.send.length, 1);
  const statuses = [ctx.store.runs(ctx.routine.id)[0].status, ctx.store.runs(other.id)[0].status].toSorted();
  assert.deepEqual(statuses, ["running", "skipped-busy"]);
});

test("a quiet turn marks the event, finishes quiet and patches the divider", async () => {
  const ctx = setup();
  due(ctx);
  await ctx.scheduler.tick();
  ctx.state.reply = "(pass) CI green";
  ctx.scheduler.observe("c1", { type: "turn-started" });
  const event = { type: "turn-completed" };
  ctx.scheduler.observe("c1", event);
  assert.equal(event.quiet, true);
  const run = lastRun(ctx);
  assert.equal(run.status, "quiet");
  assert.equal(run.summary, "CI green");
  assert.equal(run.chatId, "c1");
  assert.deepEqual(ctx.calls.patch, [{ chatId: "c1", runId: run.id, patch: { quiet: true, summary: "CI green" } }]);
  assert.equal(ctx.store.get(ctx.routine.id).runCount, 1);
});

test("an acting turn finishes acted and leaves the event alone", async () => {
  const ctx = setup();
  due(ctx);
  await ctx.scheduler.tick();
  ctx.state.reply = "Fixed the flaky test.";
  ctx.scheduler.observe("c1", { type: "turn-started" });
  const event = { type: "turn-completed" };
  ctx.scheduler.observe("c1", event);
  assert.equal("quiet" in event, false);
  assert.equal(lastRun(ctx).status, "acted");
  assert.deepEqual(ctx.calls.patch[0].patch, { quiet: false });
});

test("failed and cancelled turns finish failed", async () => {
  const ctx = setup();
  due(ctx);
  await ctx.scheduler.tick();
  ctx.scheduler.observe("c1", { type: "turn-started" });
  ctx.scheduler.observe("c1", { type: "turn-failed", message: "boom" });
  assert.equal(lastRun(ctx).status, "failed");
  assert.equal(lastRun(ctx).error, "boom");

  ctx.clock.t = ctx.store.get(ctx.routine.id).nextRunAt;
  await ctx.scheduler.tick();
  ctx.scheduler.observe("c1", { type: "turn-started" });
  ctx.scheduler.observe("c1", { type: "turn-cancelled" });
  assert.equal(lastRun(ctx).status, "failed");
  assert.equal(lastRun(ctx).error, "cancelled");
});

test("terminal events before turn-started are ignored", async () => {
  const ctx = setup();
  due(ctx);
  await ctx.scheduler.tick();
  ctx.state.reply = "(pass) early";
  const early = { type: "turn-completed" };
  ctx.scheduler.observe("c1", early);
  assert.equal("quiet" in early, false);
  assert.equal(lastRun(ctx).status, "running");
  ctx.scheduler.observe("c1", { type: "turn-started" });
  ctx.scheduler.observe("c1", { type: "turn-completed" });
  assert.equal(lastRun(ctx).status, "quiet");
});

test("events for a Chat with no pending run change nothing", async () => {
  const ctx = setup();
  const event = { type: "turn-completed" };
  ctx.scheduler.observe("c1", { type: "turn-started" });
  ctx.scheduler.observe("c1", event);
  ctx.scheduler.observe("other", event);
  assert.equal("quiet" in event, false);
  assert.deepEqual(ctx.calls.patch, []);
});

test("a patchRunContext failure is logged, not thrown", async (t) => {
  const warn = t.mock.method(console, "warn", () => {});
  const ctx = setup();
  ctx.state.patchError = new Error("no divider");
  due(ctx);
  await ctx.scheduler.tick();
  ctx.state.reply = "(pass)";
  ctx.scheduler.observe("c1", { type: "turn-started" });
  ctx.scheduler.observe("c1", { type: "turn-completed" });
  await new Promise((resolve) => setImmediate(resolve));
  assert.equal(lastRun(ctx).status, "quiet");
  assert.equal(warn.mock.callCount(), 1);
});

test("a send that throws finishes the Run failed", async () => {
  const ctx = setup();
  ctx.state.sendError = new Error("no account");
  due(ctx);
  await ctx.scheduler.tick();
  assert.equal(lastRun(ctx).status, "failed");
  assert.equal(lastRun(ctx).error, "no account");
  ctx.state.sendError = null;
  ctx.state.reply = "(pass)";
  ctx.scheduler.observe("c1", { type: "turn-started" });
  ctx.scheduler.observe("c1", { type: "turn-completed" });
  assert.equal(lastRun(ctx).status, "failed");
});

test("a send whose turn never starts finishes failed", async () => {
  const ctx = setup();
  ctx.state.startResult = null;
  due(ctx);
  await ctx.scheduler.tick();
  await new Promise((resolve) => setImmediate(resolve));
  assert.equal(lastRun(ctx).status, "failed");
  assert.equal(lastRun(ctx).error, "turn did not start");
});

test("a gone target completes the Routine and fails the Run", async () => {
  const ctx = setup();
  ctx.state.exists = false;
  due(ctx);
  await ctx.scheduler.tick();
  assert.equal(ctx.calls.send.length, 0);
  assert.equal(lastRun(ctx).status, "failed");
  assert.equal(lastRun(ctx).error, "chat gone");
  assert.deepEqual(ctx.store.list(), []);
});

test("start completes heartbeats of an archived Chat and keep-awake goes inactive", () => {
  const ctx = setup();
  ctx.state.archived = true;
  ctx.scheduler.start();
  ctx.scheduler.stop();
  assert.deepEqual(ctx.store.list(), []);
  assert.deepEqual(ctx.awakeCalls, [false]);
});

test("start reports keep-awake active while a Routine is enabled", () => {
  const ctx = setup();
  ctx.scheduler.start();
  ctx.scheduler.stop();
  assert.deepEqual(ctx.awakeCalls, [true]);
});

test("chatArchived completes that Chat's heartbeats", () => {
  const ctx = setup();
  const kept = ctx.store.upsertHeartbeat({ ...base, chatId: "c2" });
  ctx.scheduler.start();
  ctx.scheduler.chatArchived("c1");
  ctx.scheduler.stop();
  assert.deepEqual(
    ctx.store.list().map((routine) => routine.id),
    [kept.id],
  );
  assert.equal(ctx.awakeCalls.at(-1), true);
  ctx.scheduler.chatArchived("c2");
  assert.equal(ctx.awakeCalls.at(-1), false);
});

test("a claim lost to a crash fails once on restart and does not fire again", async () => {
  const ctx = setup();
  due(ctx);
  await ctx.scheduler.tick();
  assert.equal(ctx.calls.send.length, 1);
  const restarted = createRoutineStore(ctx.storeOptions);
  const scheduler = createRoutineScheduler({
    store: restarted,
    chats: {
      exists: () => true,
      archived: () => false,
      busy: () => false,
      send: async (...args) => ctx.calls.send.push(args) && { started: Promise.resolve(null) },
      replyText: () => "",
    },
    keepAwake: { setRoutinesActive() {} },
    now: () => ctx.clock.t,
  });
  scheduler.start();
  scheduler.stop();
  await scheduler.tick();
  assert.equal(ctx.calls.send.length, 1);
  const runs = restarted.runs(ctx.routine.id);
  assert.equal(runs.length, 1);
  assert.equal(runs[0].status, "failed");
  assert.equal(runs[0].error, "daemon restarted");
});

test("with the flag off ticks send nothing and keep-awake stays inactive", async () => {
  const ctx = setup({ enabled: false });
  due(ctx);
  await ctx.scheduler.tick();
  assert.equal(ctx.calls.send.length, 0);
  assert.deepEqual(ctx.store.runs(ctx.routine.id), []);
  assert.deepEqual(ctx.awakeCalls, [false]);
});

test("tick expires a Routine past its expiresAt before claiming", async () => {
  const ctx = setup();
  const expiresAt = ctx.store.get(ctx.routine.id).expiresAt;
  ctx.clock.t = expiresAt;
  await ctx.scheduler.tick();
  assert.equal(ctx.calls.send.length, 0);
  assert.deepEqual(ctx.store.list(), []);
});

test("ticks never overlap", async () => {
  let release;
  const gate = new Promise((resolve) => (release = resolve));
  const ctx = setup({ chatOptions: { send: async () => (await gate, { started: Promise.resolve({ turnId: "t" }) }) } });
  due(ctx);
  const first = ctx.scheduler.tick();
  await ctx.scheduler.tick();
  assert.equal(ctx.store.runs(ctx.routine.id).length, 1);
  release();
  await first;
});

test("start ticks on an interval that is unref'd, and stop clears it", () => {
  const ctx = setup();
  const timers = [];
  const cleared = [];
  const scheduler = createRoutineScheduler({
    store: ctx.store,
    chats: { exists: () => true, archived: () => false, busy: () => false },
    keepAwake: { setRoutinesActive() {} },
    now: () => ctx.clock.t,
    setInterval: (fn, ms) => {
      const handle = { fn, ms, unref: () => (handle.unrefd = true) };
      timers.push(handle);
      return handle;
    },
    clearInterval: (handle) => cleared.push(handle),
  });
  scheduler.start();
  assert.equal(timers.length, 1);
  assert.equal(timers[0].ms, 1000);
  assert.equal(timers[0].unrefd, true);
  scheduler.stop();
  assert.deepEqual(cleared, timers);
});

test("runNow starts a Run outside the schedule and reports it", async () => {
  const ctx = setup();
  const run = await ctx.scheduler.runNow(ctx.routine.id);
  assert.equal(run.status, "running");
  assert.equal(ctx.calls.send.length, 1);
  assert.equal(ctx.store.get(ctx.routine.id).nextRunAt, ctx.routine.nextRunAt);
  ctx.state.busy = true;
  const busy = await ctx.scheduler.runNow(ctx.routine.id);
  assert.equal(busy.status, "skipped-busy");
  await assert.rejects(() => ctx.scheduler.runNow("nope"));
});

const settle = () => new Promise((resolve) => setImmediate(resolve));
const nextBeat = (ctx) => (ctx.clock.t = ctx.store.get(ctx.routine.id).nextRunAt);

test("a send that resolves without a turn id finishes failed and the next beat is sent", async () => {
  const ctx = setup();
  ctx.state.startResult = { turnId: null, steered: false };
  due(ctx);
  await ctx.scheduler.tick();
  await settle();
  assert.equal(lastRun(ctx).status, "failed");
  assert.equal(lastRun(ctx).error, "turn did not start");

  ctx.state.startResult = { turnId: "t2", steered: false };
  nextBeat(ctx);
  await ctx.scheduler.tick();
  assert.equal(ctx.calls.send.length, 2);
  assert.equal(lastRun(ctx).status, "running");
  ctx.state.reply = "(pass) fine";
  ctx.scheduler.observe("c1", { type: "turn-started" });
  ctx.scheduler.observe("c1", { type: "turn-completed" });
  assert.equal(lastRun(ctx).status, "quiet");
});

test("a send that steers into a running turn finishes failed and never classifies that turn", async () => {
  const ctx = setup();
  ctx.state.startResult = { turnId: "t-other", steered: true };
  due(ctx);
  await ctx.scheduler.tick();
  await settle();
  assert.equal(lastRun(ctx).status, "failed");
  assert.equal(lastRun(ctx).error, "chat was busy");
  // The turn it steered into ends: it isn't the beat's.
  const end = { type: "turn-completed" };
  ctx.state.reply = "(pass) not mine";
  ctx.scheduler.observe("c1", { type: "turn-started" });
  ctx.scheduler.observe("c1", end);
  assert.equal("quiet" in end, false);
  assert.deepEqual(ctx.calls.patch, []);

  ctx.state.startResult = { turnId: "t2", steered: false };
  nextBeat(ctx);
  await ctx.scheduler.tick();
  assert.equal(ctx.calls.send.length, 2);
  assert.equal(lastRun(ctx).status, "running");
});

test("a turn that fails after the beat's message is sent but before it starts finishes the Run failed", async () => {
  const ctx = setup();
  let resolveStarted;
  ctx.state.startResult = new Promise((resolve) => (resolveStarted = resolve));
  due(ctx);
  await ctx.scheduler.tick();
  // The turn the Chat just ended is published late, before the beat's message: not the beat's.
  ctx.scheduler.observe("c1", { type: "turn-failed", message: "the turn before" });
  assert.equal(lastRun(ctx).status, "running");
  ctx.scheduler.observe("c1", { type: "message-sent" });
  ctx.scheduler.observe("c1", { type: "turn-failed", message: "Claude Code isn't installed." });
  assert.equal(lastRun(ctx).status, "failed");
  assert.equal(lastRun(ctx).error, "Claude Code isn't installed.");
  resolveStarted({ turnId: null, steered: false });
  await settle();
  assert.equal(lastRun(ctx).error, "Claude Code isn't installed.");

  ctx.state.startResult = { turnId: "t2" };
  nextBeat(ctx);
  await ctx.scheduler.tick();
  assert.equal(ctx.calls.send.length, 2);
  assert.equal(lastRun(ctx).status, "running");
});
