const crypto = require("node:crypto");
const fs = require("node:fs");
const path = require("node:path");
const { everyToCron, nextRun } = require("./cron.cjs");

const DEFAULT_EXPIRY_MS = 7 * 864e5;
const MISSED_AFTER_MS = 60_000;
const MAX_RUNS_KEPT = 50;
const UNIT_MS = { m: 60_000, h: 3600_000, d: 864e5 };
const UPDATABLE = new Set(["name", "prompt", "cron", "timezone", "maxRuns", "expiresAt", "enabled"]);
// These end a run's life in a count: skipped-busy and missed runs never ran, so they are not counted.
const FINISH_STATUSES = new Set(["acted", "quiet", "failed", "skipped-busy"]);
const COUNTED = new Set(["acted", "quiet", "failed"]);

function parseExpiresIn(value) {
  const match = typeof value === "string" ? /^(\d+)([mhd])$/.exec(value) : null;
  if (!match || Number(match[1]) < 1) throw new Error(`Invalid expiresIn: ${JSON.stringify(value)} (use e.g. 30m, 6h or 7d)`);
  return Number(match[1]) * UNIT_MS[match[2]];
}

const copy = (value) => (value === undefined ? value : structuredClone(value));

function markCompleted(routine, at) {
  routine.completedAt = at;
  routine.enabled = false;
  routine.nextRunAt = null;
  routine.updatedAt = at;
}

function finish(routine, run, status, extra, at) {
  run.status = status;
  run.endedAt = at;
  if (extra.summary !== undefined) run.summary = extra.summary;
  if (extra.error !== undefined) run.error = extra.error;
  if (extra.chatId !== undefined) run.chatId = extra.chatId;
  routine.lastRunAt = run.startedAt;
  routine.updatedAt = at;
  if (COUNTED.has(status)) routine.runCount += 1;
  if (routine.maxRuns !== undefined && routine.runCount >= routine.maxRuns && !routine.completedAt) markCompleted(routine, at);
}

function empty() {
  return { version: 1, enabled: false, routines: [], runs: {} };
}

/**
 * The daemon's Routines and their Runs in one JSON file. Reads are cached in memory; every mutation
 * is synchronous and rewrites the whole file once (temp file plus rename, like limit-switch.cjs).
 */
function createRoutineStore({ file, now = Date.now, id = () => crypto.randomBytes(4).toString("hex") }) {
  let data = load();

  function load() {
    let text;
    try {
      text = fs.readFileSync(file, "utf8");
    } catch {
      return empty();
    }
    try {
      const parsed = JSON.parse(text);
      if (!parsed || typeof parsed !== "object" || !Array.isArray(parsed.routines) || !parsed.runs || typeof parsed.runs !== "object") {
        throw new Error("unexpected shape");
      }
      return { version: 1, enabled: parsed.enabled === true, routines: parsed.routines, runs: parsed.runs };
    } catch {
      try {
        fs.renameSync(file, `${file}.corrupt`);
      } catch {}
      return empty();
    }
  }

  function save() {
    fs.mkdirSync(path.dirname(file), { recursive: true });
    const temp = `${file}.${crypto.randomUUID()}.tmp`;
    fs.writeFileSync(temp, JSON.stringify(data));
    fs.renameSync(temp, file);
  }

  const find = (routineId) => data.routines.find((routine) => routine.id === routineId);

  function appendRun(routineId, run) {
    const kept = data.runs[routineId] ?? (data.runs[routineId] = []);
    kept.push(run);
    if (kept.length > MAX_RUNS_KEPT) kept.splice(0, kept.length - MAX_RUNS_KEPT);
  }

  function enabled() {
    return data.enabled;
  }
  function setEnabled(value) {
    data.enabled = value === true;
    save();
    return data.enabled;
  }

  function list() {
    return data.routines
      .filter((routine) => !routine.completedAt)
      .toSorted((a, b) => b.createdAt - a.createdAt)
      .map(copy);
  }
  function get(routineId) {
    return copy(find(routineId) ?? null);
  }
  function runs(routineId) {
    return (data.runs[routineId] ?? []).toReversed().map(copy);
  }

  function upsertHeartbeat({ chatId, name, prompt, cron, every, timezone, maxRuns, expiresIn, provider, model, permissionMode, createdBy }) {
    if ((cron === undefined) === (every === undefined)) throw new Error("Give exactly one of cron or every");
    if (typeof timezone !== "string" || timezone === "") throw new Error("A heartbeat needs a timezone");
    if (typeof name !== "string" || name.trim() === "") throw new Error("A heartbeat needs a name");
    if (typeof prompt !== "string" || prompt.trim() === "") throw new Error("A heartbeat needs a prompt");
    const at = now();
    const expression = cron ?? everyToCron(every);
    const nextRunAt = nextRun(expression, timezone, at);
    const expiryMs = expiresIn !== undefined ? parseExpiresIn(expiresIn) : maxRuns === undefined ? DEFAULT_EXPIRY_MS : undefined;
    const existing = data.routines.find((routine) => !routine.completedAt && routine.name === name && routine.target.chatId === chatId);
    const routine = {
      id: existing?.id ?? id(),
      name,
      prompt,
      trigger: { kind: "schedule", cron: expression, timezone },
      target: { kind: "chat", chatId },
      enabled: true,
      createdBy,
      nextRunAt,
      runCount: existing?.runCount ?? 0,
      createdAt: existing?.createdAt ?? at,
      updatedAt: at,
    };
    if (provider !== undefined) routine.provider = provider;
    if (model !== undefined) routine.model = model;
    if (permissionMode !== undefined) routine.permissionMode = permissionMode;
    if (maxRuns !== undefined) routine.maxRuns = maxRuns;
    if (expiryMs !== undefined) routine.expiresAt = at + expiryMs;
    if (existing?.lastRunAt !== undefined) routine.lastRunAt = existing.lastRunAt;
    if (existing) data.routines[data.routines.indexOf(existing)] = routine;
    else data.routines.push(routine);
    save();
    return copy(routine);
  }

  function update(routineId, patch) {
    const routine = find(routineId);
    if (!routine) throw new Error(`Routine not found: ${routineId}`);
    if (routine.completedAt) throw new Error(`Routine is completed: ${routineId}`);
    for (const key of Object.keys(patch)) if (!UPDATABLE.has(key)) throw new Error(`Cannot update ${key}`);
    const next = copy(routine);
    for (const key of ["name", "prompt", "enabled"]) if (patch[key] !== undefined) next[key] = patch[key];
    for (const key of ["maxRuns", "expiresAt"]) {
      if (patch[key] === null) delete next[key];
      else if (patch[key] !== undefined) next[key] = patch[key];
    }
    if (patch.cron !== undefined) next.trigger.cron = patch.cron;
    if (patch.timezone !== undefined) next.trigger.timezone = patch.timezone;
    if (next.maxRuns === undefined && next.expiresAt === undefined) throw new Error("Heartbeats need an end: keep maxRuns or expiresAt");
    const at = now();
    const reschedule = patch.cron !== undefined || patch.timezone !== undefined || (patch.enabled === true && !routine.enabled);
    if (reschedule) next.nextRunAt = nextRun(next.trigger.cron, next.trigger.timezone, at);
    next.updatedAt = at;
    data.routines[data.routines.indexOf(routine)] = next;
    save();
    return copy(next);
  }

  function remove(routineId) {
    const routine = find(routineId);
    if (!routine) return false;
    data.routines.splice(data.routines.indexOf(routine), 1);
    delete data.runs[routineId];
    save();
    return true;
  }

  function claimDue(at) {
    const claims = [];
    let changed = false;
    for (const routine of data.routines) {
      if (!routine.enabled || routine.completedAt || routine.nextRunAt == null || routine.nextRunAt > at) continue;
      const scheduledFor = routine.nextRunAt;
      const late = scheduledFor < at - MISSED_AFTER_MS;
      const run = { id: id(), routineId: routine.id, scheduledFor, startedAt: at, status: late ? "missed" : "running" };
      if (late) run.endedAt = at;
      appendRun(routine.id, run);
      routine.nextRunAt = nextRun(routine.trigger.cron, routine.trigger.timezone, at);
      routine.updatedAt = at;
      if (!late) claims.push({ routine: copy(routine), run: copy(run) });
      changed = true;
    }
    if (changed) save();
    return claims;
  }

  // A Run outside the schedule (run now): same shape as a claimed one, but nextRunAt stays where it is.
  function startRun(routineId, at) {
    const routine = find(routineId);
    if (!routine || routine.completedAt) return null;
    const run = { id: id(), routineId, scheduledFor: at, startedAt: at, status: "running" };
    appendRun(routineId, run);
    save();
    return { routine: copy(routine), run: copy(run) };
  }

  function finishRun(runId, { status, summary, error, chatId }) {
    if (!FINISH_STATUSES.has(status)) throw new Error(`Invalid run status: ${JSON.stringify(status)}`);
    for (const routine of data.routines) {
      const run = (data.runs[routine.id] ?? []).find((item) => item.id === runId);
      if (!run) continue;
      // Only a run still in flight can be finished; a second call must not recount it.
      if (run.status !== "running") return null;
      finish(routine, run, status, { summary, error, chatId }, now());
      save();
      return copy(routine);
    }
    return null;
  }

  function complete(routineId, _reason) {
    const routine = find(routineId);
    if (!routine) return null;
    markCompleted(routine, now());
    save();
    return copy(routine);
  }

  function expireDue(at) {
    let changed = false;
    for (const routine of data.routines) {
      if (routine.completedAt || routine.expiresAt === undefined || routine.expiresAt > at) continue;
      markCompleted(routine, at);
      changed = true;
    }
    if (changed) save();
  }

  function recoverInterrupted() {
    const at = now();
    for (const routine of data.routines) {
      for (const run of data.runs[routine.id] ?? []) {
        if (run.status === "running") finish(routine, run, "failed", { error: "daemon restarted" }, at);
      }
      if (routine.enabled && !routine.completedAt && routine.nextRunAt != null && routine.nextRunAt <= at) {
        routine.nextRunAt = nextRun(routine.trigger.cron, routine.trigger.timezone, at);
      }
    }
    save();
  }

  return { enabled, setEnabled, list, get, runs, upsertHeartbeat, update, remove, claimDue, startRun, finishRun, complete, expireDue, recoverInterrupted };
}

module.exports = { createRoutineStore };
