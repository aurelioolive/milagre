import { test } from "node:test";
import assert from "node:assert/strict";
import { groupQuietRuns, isRoutineRun, mergedRoutineRunText, parsePass, routineRunText } from "./routines.mjs";

test("parsePass reads a leading (pass) as quiet, with the summary after it", () => {
  assert.deepEqual(parsePass("(pass) CI green"), { quiet: true, summary: "CI green" });
  assert.deepEqual(parsePass("**(pass)** CI green"), { quiet: true, summary: "CI green" });
  assert.deepEqual(parsePass("  (Pass) waiting\nmore"), { quiet: true, summary: "waiting" });
});

test("parsePass ignores a (pass) that is not at the start", () => {
  assert.deepEqual(parsePass("CI failed, so no (pass) today"), { quiet: false });
  assert.deepEqual(parsePass(""), { quiet: false });
});

test("parsePass caps the summary at 80 characters", () => {
  assert.equal(parsePass("(pass) " + "x".repeat(200)).summary.length, 80);
});

const context = (over = {}) => ({
  kind: "routine-run",
  routineId: "r1",
  runId: "run1",
  name: "Babysit",
  at: Date.UTC(2026, 9, 16, 13, 15),
  quiet: false,
  ...over,
});

test("routineRunText words the acted and the quiet divider", () => {
  assert.equal(routineRunText(context(), "UTC"), "Heartbeat · 13:15");
  assert.equal(routineRunText(context({ at: Date.UTC(2026, 9, 16, 13, 30), quiet: true, summary: "CI green" }), "UTC"), "13:30 · quiet: CI green");
  assert.equal(routineRunText(context({ quiet: true }), "UTC"), "13:15 · quiet");
});

test("mergedRoutineRunText counts the collapsed checks and words the last one", () => {
  const last = context({ at: Date.UTC(2026, 9, 16, 13, 30), quiet: true, summary: "CI green" });
  assert.equal(mergedRoutineRunText({ count: 2, last }, "UTC"), "2 quiet checks · last 13:30: CI green");
  assert.equal(mergedRoutineRunText({ count: 5, last: { ...last, summary: undefined } }, "UTC"), "5 quiet checks · last 13:30");
});

test("routineRunText uses the given zone and a 24 hour clock", () => {
  assert.equal(routineRunText(context({ at: Date.UTC(2026, 9, 16, 0, 5) }), "America/Sao_Paulo"), "Heartbeat · 21:05");
  assert.equal(routineRunText(context({ at: Date.UTC(2026, 9, 16, 3, 5) }), "UTC"), "Heartbeat · 03:05");
});

test("isRoutineRun spots the divider message", () => {
  assert.equal(isRoutineRun({ context: context() }), true);
  assert.equal(isRoutineRun({ context: { kind: "reload" } }), false);
  assert.equal(isRoutineRun(null), false);
});

const divider = (id, over) => ({ id, role: "user", text: "", context: context({ runId: id, ...over }) });
const reply = (id) => ({ id, role: "assistant", text: "(pass) ok" });

test("groupQuietRuns hides quiet replies and merges back-to-back quiet dividers into the last", () => {
  const user = { id: "u", role: "user", text: "hi" };
  const q1 = divider("q1", { quiet: true, summary: "one" });
  const q2 = divider("q2", { quiet: true, summary: "two" });
  const a3 = divider("a3", { quiet: false });
  const messages = [user, q1, reply("r1"), q2, reply("r2"), a3, reply("r3")];
  const grouped = groupQuietRuns(messages);

  assert.equal(grouped.length, messages.length);
  assert.deepEqual(
    grouped.map((entry) => entry.message),
    messages,
  );
  assert.deepEqual(
    grouped.map((entry) => entry.hidden === true),
    [false, true, true, false, true, false, false],
  );
  assert.deepEqual(grouped[3].merged, { count: 2, last: q2.context });
  assert.equal(grouped[1].merged, undefined);
  assert.equal(grouped[5].merged, undefined);
});

test("groupQuietRuns shows a single quiet divider unmerged and hides its reply", () => {
  const q = divider("q", { quiet: true, summary: "one" });
  const grouped = groupQuietRuns([q, reply("r"), { id: "u", role: "user", text: "later" }]);
  assert.equal(grouped[0].hidden, undefined);
  assert.equal(grouped[0].merged, undefined);
  assert.equal(grouped[1].hidden, true);
  assert.equal(grouped[2].hidden, undefined);
});

test("groupQuietRuns does not merge quiet dividers split by a person's message", () => {
  const q1 = divider("q1", { quiet: true });
  const q2 = divider("q2", { quiet: true });
  const grouped = groupQuietRuns([q1, reply("r1"), { id: "u", role: "user", text: "hi" }, q2, reply("r2")]);
  assert.deepEqual(
    grouped.map((entry) => [entry.hidden === true, entry.merged?.count]),
    [
      [false, undefined],
      [true, undefined],
      [false, undefined],
      [false, undefined],
      [true, undefined],
    ],
  );
});
