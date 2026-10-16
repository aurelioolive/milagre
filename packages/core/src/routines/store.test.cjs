const assert = require("node:assert/strict");
const fs = require("node:fs");
const os = require("node:os");
const path = require("node:path");
const test = require("node:test");
const { createRoutineStore } = require("./store.cjs");

const DAY = 864e5;
const START = Date.UTC(2026, 0, 5, 10, 0, 0); // a Monday, 10:00 UTC

function setup() {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), "routine-store-"));
  const file = path.join(dir, "routines.json");
  const clock = { t: START };
  let n = 0;
  const options = { file, now: () => clock.t, id: () => `id${++n}` };
  return { dir, file, clock, options, store: createRoutineStore(options) };
}

const base = { chatId: "c1", name: "check", prompt: "look", every: "15m", timezone: "UTC", createdBy: { kind: "user" } };

test("a missing file means disabled and empty", () => {
  const { store } = setup();
  assert.equal(store.enabled(), false);
  assert.deepEqual(store.list(), []);
  assert.equal(store.get("nope"), null);
  assert.deepEqual(store.runs("nope"), []);
});

test("setEnabled persists", () => {
  const { store, options } = setup();
  assert.equal(store.setEnabled(true), true);
  assert.equal(createRoutineStore(options).enabled(), true);
});

test("upsertHeartbeat twice with the same name and chat keeps one Routine", () => {
  const { store } = setup();
  const first = store.upsertHeartbeat(base);
  store.upsertHeartbeat({ ...base, prompt: "look again" });
  const list = store.list();
  assert.equal(list.length, 1);
  assert.equal(list[0].id, first.id);
  assert.equal(list[0].prompt, "look again");
});

test("upsert keeps runCount and does not match another chat or name", () => {
  const { store } = setup();
  const first = store.upsertHeartbeat(base);
  store.claimDue(first.nextRunAt);
  const run = store.runs(first.id)[0];
  store.finishRun(run.id, { status: "acted" });
  const again = store.upsertHeartbeat(base);
  assert.equal(again.id, first.id);
  assert.equal(again.runCount, 1);
  store.upsertHeartbeat({ ...base, chatId: "c2" });
  store.upsertHeartbeat({ ...base, name: "other" });
  assert.equal(store.list().length, 3);
});

test("a heartbeat with no limits expires in 7 days", () => {
  const { store } = setup();
  const routine = store.upsertHeartbeat(base);
  assert.equal(routine.expiresAt, START + 7 * DAY);
  assert.equal(routine.maxRuns, undefined);
  assert.equal(routine.enabled, true);
  assert.deepEqual(routine.trigger, { kind: "schedule", cron: "*/15 * * * *", timezone: "UTC" });
  assert.deepEqual(routine.target, { kind: "chat", chatId: "c1" });
  assert.equal(routine.nextRunAt, START + 15 * 60_000);
});

test("maxRuns or expiresIn replace the default expiry", () => {
  const { store } = setup();
  const limited = store.upsertHeartbeat({ ...base, name: "a", maxRuns: 3 });
  assert.equal(limited.maxRuns, 3);
  assert.equal(limited.expiresAt, undefined);
  assert.equal(store.upsertHeartbeat({ ...base, name: "b", expiresIn: "30m" }).expiresAt, START + 30 * 60_000);
  assert.equal(store.upsertHeartbeat({ ...base, name: "c", expiresIn: "6h" }).expiresAt, START + 6 * 3600_000);
  assert.equal(store.upsertHeartbeat({ ...base, name: "d", expiresIn: "2d" }).expiresAt, START + 2 * DAY);
});

test("upsertHeartbeat validates its input", () => {
  const { store } = setup();
  assert.throws(() => store.upsertHeartbeat({ ...base, every: undefined }), /cron or every/);
  assert.throws(() => store.upsertHeartbeat({ ...base, cron: "* * * * *" }), /cron or every/);
  assert.throws(() => store.upsertHeartbeat({ ...base, timezone: undefined }), /timezone/);
  assert.throws(() => store.upsertHeartbeat({ ...base, every: "never" }), /Invalid every/);
  assert.throws(() => store.upsertHeartbeat({ ...base, timezone: "Mars/Base" }));
  assert.throws(() => store.upsertHeartbeat({ ...base, cron: "nope", every: undefined }));
  for (const expiresIn of ["0d", "7", "d", "7w", "never", "-1h"]) {
    assert.throws(() => store.upsertHeartbeat({ ...base, expiresIn }), /Invalid expiresIn/, expiresIn);
  }
  assert.deepEqual(store.list(), []);
});

test("claimDue claims once and moves nextRunAt to the next slot", () => {
  const { store, clock } = setup();
  const routine = store.upsertHeartbeat(base);
  const at = routine.nextRunAt;
  clock.t = at;
  const claims = store.claimDue(at);
  assert.equal(claims.length, 1);
  assert.equal(claims[0].routine.id, routine.id);
  assert.equal(claims[0].run.status, "running");
  assert.equal(claims[0].run.scheduledFor, at);
  assert.equal(claims[0].run.routineId, routine.id);
  assert.equal(store.get(routine.id).nextRunAt, at + 15 * 60_000);
  assert.deepEqual(store.claimDue(at), []);
  assert.equal(store.runs(routine.id).length, 1);
});

test("claimDue skips disabled Routines and ones not yet due", () => {
  const { store } = setup();
  const routine = store.upsertHeartbeat(base);
  assert.deepEqual(store.claimDue(routine.nextRunAt - 1), []);
  store.update(routine.id, { enabled: false });
  assert.deepEqual(store.claimDue(routine.nextRunAt + 1000), []);
});

test("a slot missed by more than a minute records one missed Run and advances", () => {
  const { store } = setup();
  const routine = store.upsertHeartbeat(base);
  const at = routine.nextRunAt + 5 * 60_000;
  assert.deepEqual(store.claimDue(at), []);
  const runs = store.runs(routine.id);
  assert.equal(runs.length, 1);
  assert.equal(runs[0].status, "missed");
  assert.equal(runs[0].scheduledFor, routine.nextRunAt);
  assert.equal(store.get(routine.id).nextRunAt, routine.nextRunAt + 15 * 60_000);
  assert.equal(store.get(routine.id).runCount, 0);
  assert.deepEqual(store.claimDue(at), []);
  assert.equal(store.runs(routine.id).length, 1);
});

test("finishRun counts runs and completes the Routine at maxRuns", () => {
  const { store, clock } = setup();
  const routine = store.upsertHeartbeat({ ...base, maxRuns: 2 });
  let at = routine.nextRunAt;
  clock.t = at;
  const [first] = store.claimDue(at);
  clock.t = at + 1000;
  const done = store.finishRun(first.run.id, { status: "acted", summary: "did it", chatId: "c1" });
  assert.equal(done.runCount, 1);
  assert.equal(done.completedAt, undefined);
  const finished = store.runs(routine.id)[0];
  assert.equal(finished.status, "acted");
  assert.equal(finished.endedAt, at + 1000);
  assert.equal(finished.summary, "did it");
  assert.equal(finished.chatId, "c1");
  at = store.get(routine.id).nextRunAt;
  clock.t = at;
  const [second] = store.claimDue(at);
  const last = store.finishRun(second.run.id, { status: "quiet" });
  assert.equal(last.runCount, 2);
  assert.equal(last.completedAt, at);
  assert.equal(last.enabled, false);
  assert.deepEqual(store.list(), []);
  assert.deepEqual(store.claimDue(at + DAY), []);
});

test("skipped-busy and missed runs do not count, failed ones do", () => {
  const { store, clock } = setup();
  const routine = store.upsertHeartbeat(base);
  const claim = (status) => {
    const at = store.get(routine.id).nextRunAt;
    clock.t = at;
    const [c] = store.claimDue(at);
    return store.finishRun(c.run.id, { status, error: status === "failed" ? "boom" : undefined });
  };
  assert.equal(claim("skipped-busy").runCount, 0);
  assert.equal(claim("failed").runCount, 1);
  assert.equal(store.runs(routine.id)[0].error, "boom");
});

test("finishRun twice leaves the Run and runCount alone and returns null", () => {
  const { store, clock, file } = setup();
  const routine = store.upsertHeartbeat({ ...base, maxRuns: 2 });
  clock.t = routine.nextRunAt;
  const [claim] = store.claimDue(clock.t);
  clock.t += 1000;
  assert.equal(store.finishRun(claim.run.id, { status: "acted", summary: "first" }).runCount, 1);
  const before = fs.readFileSync(file, "utf8");
  clock.t += 1000;
  assert.equal(store.finishRun(claim.run.id, { status: "failed", error: "late" }), null);
  assert.equal(store.get(routine.id).runCount, 1);
  const [run] = store.runs(routine.id);
  assert.equal(run.status, "acted");
  assert.equal(run.summary, "first");
  assert.equal(run.error, undefined);
  assert.equal(run.endedAt, routine.nextRunAt + 1000);
  assert.equal(fs.readFileSync(file, "utf8"), before);
});

test("finishRun does not finish a missed Run and rejects statuses outside the finishing set", () => {
  const { store } = setup();
  const routine = store.upsertHeartbeat(base);
  store.claimDue(routine.nextRunAt + 5 * 60_000);
  const [missed] = store.runs(routine.id);
  assert.equal(store.finishRun(missed.id, { status: "acted" }), null);
  assert.equal(store.runs(routine.id)[0].status, "missed");
  const next = setup();
  const r = next.store.upsertHeartbeat(base);
  next.clock.t = r.nextRunAt;
  const [claim] = next.store.claimDue(next.clock.t);
  for (const status of ["running", "missed", "bogus", undefined]) {
    assert.throws(() => next.store.finishRun(claim.run.id, { status }), /Invalid run status/, String(status));
  }
  assert.equal(next.store.runs(r.id)[0].status, "running");
});

test("finishRun on an unknown run returns null", () => {
  const { store } = setup();
  assert.equal(store.finishRun("nope", { status: "acted" }), null);
});

test("recoverInterrupted fails running Runs and advances overdue slots without missed Runs", () => {
  const { store, clock, options } = setup();
  const routine = store.upsertHeartbeat(base);
  const at = routine.nextRunAt;
  clock.t = at;
  store.claimDue(at);
  clock.t = at + 3 * 3600_000;
  const restarted = createRoutineStore(options);
  restarted.recoverInterrupted();
  const runs = restarted.runs(routine.id);
  assert.equal(runs.length, 1);
  assert.equal(runs[0].status, "failed");
  assert.equal(runs[0].error, "daemon restarted");
  assert.equal(runs[0].endedAt, clock.t);
  const after = restarted.get(routine.id);
  assert.equal(after.runCount, 1);
  assert.ok(after.nextRunAt > clock.t);
  assert.ok(after.nextRunAt <= clock.t + 15 * 60_000);
  assert.deepEqual(restarted.claimDue(clock.t), []);
});

test("recoverInterrupted can complete a Routine at maxRuns", () => {
  const { store, clock } = setup();
  const routine = store.upsertHeartbeat({ ...base, maxRuns: 1 });
  clock.t = routine.nextRunAt;
  store.claimDue(clock.t);
  store.recoverInterrupted();
  assert.ok(store.get(routine.id).completedAt);
  assert.deepEqual(store.list(), []);
});

test("only the last 50 Runs are kept", () => {
  const { store, clock } = setup();
  const routine = store.upsertHeartbeat({ ...base, expiresIn: "30d" });
  for (let i = 0; i < 60; i++) {
    const at = store.get(routine.id).nextRunAt;
    clock.t = at;
    const [c] = store.claimDue(at);
    store.finishRun(c.run.id, { status: "quiet" });
  }
  const runs = store.runs(routine.id);
  assert.equal(runs.length, 50);
  assert.ok(runs[0].scheduledFor > runs[49].scheduledFor);
  assert.equal(store.get(routine.id).runCount, 60);
});

test("a re-created store reads back the same Routines and Runs", () => {
  const { store, clock, options } = setup();
  const routine = store.upsertHeartbeat(base);
  clock.t = routine.nextRunAt;
  store.claimDue(clock.t);
  store.setEnabled(true);
  const again = createRoutineStore(options);
  assert.deepEqual(again.list(), store.list());
  assert.deepEqual(again.runs(routine.id), store.runs(routine.id));
  assert.equal(again.enabled(), true);
  assert.deepEqual(fs.readdirSync(path.dirname(options.file)), ["routines.json"]);
});

test("complete and expireDue end Routines", () => {
  const { store, clock } = setup();
  const a = store.upsertHeartbeat({ ...base, name: "a", expiresIn: "1h" });
  const b = store.upsertHeartbeat({ ...base, name: "b", expiresIn: "2h" });
  const c = store.upsertHeartbeat({ ...base, name: "c" });
  clock.t = START + 90 * 60_000;
  store.expireDue(clock.t);
  assert.ok(store.get(a.id).completedAt);
  assert.equal(store.get(a.id).enabled, false);
  assert.equal(store.get(b.id).completedAt, undefined);
  store.complete(c.id, "done early");
  assert.equal(store.get(c.id).completedAt, clock.t);
  assert.deepEqual(
    store.list().map((r) => r.id),
    [b.id],
  );
});

test("list returns disabled Routines, newest first", () => {
  const { store, clock } = setup();
  const a = store.upsertHeartbeat({ ...base, name: "a" });
  clock.t += 1000;
  const b = store.upsertHeartbeat({ ...base, name: "b" });
  store.update(a.id, { enabled: false });
  assert.deepEqual(
    store.list().map((r) => r.id),
    [b.id, a.id],
  );
});

test("update recomputes nextRunAt on cron, timezone and re-enable", () => {
  const { store, clock } = setup();
  const routine = store.upsertHeartbeat(base);
  const hourly = store.update(routine.id, { cron: "0 * * * *" });
  assert.equal(hourly.trigger.cron, "0 * * * *");
  assert.equal(hourly.nextRunAt, START + 3600_000);
  const tokyo = store.update(routine.id, { cron: "0 9 * * *", timezone: "Asia/Tokyo" });
  assert.equal(tokyo.trigger.timezone, "Asia/Tokyo");
  assert.equal(tokyo.nextRunAt, Date.UTC(2026, 0, 6, 0, 0));
  store.update(routine.id, { enabled: false });
  clock.t = START + 5 * 3600_000;
  const back = store.update(routine.id, { enabled: true });
  assert.equal(back.enabled, true);
  assert.ok(back.nextRunAt > clock.t);
  assert.equal(store.update(routine.id, { name: "renamed", prompt: "new" }).name, "renamed");
});

test("update rejects bad input and unknown Routines", () => {
  const { store } = setup();
  const routine = store.upsertHeartbeat(base);
  assert.throws(() => store.update(routine.id, { cron: "nope" }));
  assert.throws(() => store.update(routine.id, { timezone: "Mars/Base" }));
  assert.throws(() => store.update(routine.id, { color: "red" }), /color/);
  assert.throws(() => store.update("nope", { name: "x" }), /not found/);
  assert.equal(store.get(routine.id).trigger.cron, "*/15 * * * *");
});

test("update keeps an end on every heartbeat", () => {
  const { store } = setup();
  const routine = store.upsertHeartbeat(base);
  assert.throws(() => store.update(routine.id, { expiresAt: null }), /Heartbeats need an end/);
  assert.equal(store.update(routine.id, { expiresAt: null, maxRuns: 5 }).maxRuns, 5);
  assert.throws(() => store.update(routine.id, { maxRuns: null }), /Heartbeats need an end/);
});

test("remove deletes the Routine and its Runs", () => {
  const { store, clock, options } = setup();
  const routine = store.upsertHeartbeat(base);
  clock.t = routine.nextRunAt;
  store.claimDue(clock.t);
  assert.equal(store.remove(routine.id), true);
  assert.equal(store.remove(routine.id), false);
  assert.equal(store.get(routine.id), null);
  assert.deepEqual(store.runs(routine.id), []);
  assert.deepEqual(JSON.parse(fs.readFileSync(options.file, "utf8")).runs, {});
});

test("an unparsable file is moved aside and the store starts empty", () => {
  const { file, options } = setup();
  fs.writeFileSync(file, "{ not json");
  const store = createRoutineStore(options);
  assert.deepEqual(store.list(), []);
  assert.equal(fs.readFileSync(`${file}.corrupt`, "utf8"), "{ not json");
  store.upsertHeartbeat(base);
  assert.equal(createRoutineStore(options).list().length, 1);
});

test("returned Routines are copies", () => {
  const { store } = setup();
  const routine = store.upsertHeartbeat(base);
  routine.name = "mutated";
  store.get(routine.id).trigger.cron = "bad";
  assert.equal(store.get(routine.id).name, "check");
  assert.equal(store.get(routine.id).trigger.cron, "*/15 * * * *");
});

test("startRun appends a running Run without moving nextRunAt", () => {
  const { store, clock } = setup();
  const routine = store.upsertHeartbeat(base);
  clock.t += 1000;
  const started = store.startRun(routine.id, clock.t);
  assert.equal(started.run.status, "running");
  assert.equal(started.run.routineId, routine.id);
  assert.equal(started.run.scheduledFor, clock.t);
  assert.equal(started.routine.nextRunAt, routine.nextRunAt);
  assert.equal(store.get(routine.id).nextRunAt, routine.nextRunAt);
  assert.equal(store.runs(routine.id).length, 1);
  assert.equal(store.finishRun(started.run.id, { status: "acted" }).runCount, 1);
});

test("startRun returns null for unknown and completed Routines", () => {
  const { store, clock } = setup();
  assert.equal(store.startRun("nope", clock.t), null);
  const routine = store.upsertHeartbeat(base);
  store.complete(routine.id, "done");
  assert.equal(store.startRun(routine.id, clock.t), null);
});

test("three failed Runs in a row complete the heartbeat; an acted or quiet Run resets the streak", () => {
  const { store } = setup();
  const routine = store.upsertHeartbeat(base);
  const beat = (status, extra = {}) => {
    const { run } = store.startRun(routine.id, START);
    return store.finishRun(run.id, { status, ...extra });
  };
  assert.equal(beat("failed", { error: "boom" }).failedStreak, 1);
  assert.equal(beat("failed", { error: "boom" }).failedStreak, 2);
  assert.equal(beat("skipped-busy").failedStreak, 2);
  assert.equal(beat("quiet").failedStreak, 0);
  beat("failed", { error: "boom" });
  beat("acted");
  beat("failed", { error: "boom" });
  beat("failed", { error: "boom" });
  assert.ok(!store.get(routine.id).completedAt);
  const ended = beat("failed", { error: "no CLI" });
  assert.equal(ended.failedStreak, 3);
  assert.ok(ended.completedAt);
  assert.equal(ended.enabled, false);
  assert.deepEqual(store.list(), []);
  assert.equal(store.runs(routine.id)[0].error, "no CLI · 3 failed beats in a row");
});
