const { isTurnEnd } = require("@milagre/shared/agent-runs");
const { parsePass } = require("@milagre/shared/routines");

const TICK_MS = 1000;
const BUSY = "chat was busy";
const PASS_HINT = '\n\nIf nothing needs doing, reply starting with "(pass)" and a short reason.';

/**
 * Sends each due heartbeat into its Chat and records how the turn went. `chats` is the adapter the runtime builds:
 * exists, archived, busy (a turn open, preparing, or an approval or question pending), send (resolves once the message
 * is accepted, with a `started` promise for the turn), replyText and patchRunContext.
 */
function createRoutineScheduler({
  store,
  chats,
  keepAwake,
  now = Date.now,
  setInterval: setTimer = setInterval,
  clearInterval: clearTimer = clearInterval,
  onChange = () => {},
}) {
  // chatId -> the heartbeat Run in flight there. `sent` flips on the beat's message-sent, `turnStarted` on turn-started;
  // a turn's end only classifies the Run after both.
  const pending = new Map();
  let timer = null;
  let ticking = false;
  let swept = false;
  let awake = null;
  // Chats whose beat failed to start again, its turn end not yet published: that end is marked quiet when it comes.
  const silenced = new Set();

  function syncKeepAwake() {
    const active = store.enabled() && store.list().some((routine) => routine.enabled);
    if (active === awake) return;
    awake = active;
    keepAwake.setRoutinesActive(active);
  }

  // Resolves with the Routine as the Run left it, or null when the Run was already finished.
  function finish(run, chatId, outcome) {
    return store.finishRun(run.id, { chatId, ...outcome });
  }

  // A failed beat right after another failed beat tells no one: the first failure was announced (store.cjs ends the
  // heartbeat on the third).
  const failedAgain = (routine) => (routine?.failedStreak ?? 0) >= 2;

  function chatGone(chatId) {
    return !chats.exists(chatId) || chats.archived(chatId);
  }

  // Heartbeats whose Chat is gone or archived end; nothing will ever answer them.
  function sweepGone() {
    let changed = false;
    for (const routine of store.list()) {
      if (routine.target.kind !== "chat" || !chatGone(routine.target.chatId)) continue;
      store.complete(routine.id, "chat gone");
      changed = true;
    }
    return changed;
  }

  async function dispatch(routine, run) {
    const chatId = routine.target.chatId;
    if (chatGone(chatId)) {
      store.complete(routine.id, "chat gone");
      finish(run, chatId, { status: "failed", error: "chat gone" });
      return;
    }
    if (pending.has(chatId) || chats.busy(chatId)) {
      finish(run, chatId, { status: "skipped-busy" });
      return;
    }
    const entry = { runId: run.id, sent: false, turnStarted: false };
    pending.set(chatId, entry);
    const context = { kind: "routine-run", routineId: routine.id, runId: run.id, name: routine.name, at: now() };
    let started;
    try {
      ({ started } = await chats.send(chatId, { body: routine.prompt, prompt: routine.prompt + PASS_HINT, context }));
    } catch (error) {
      pending.delete(chatId);
      finish(run, chatId, { status: "failed", error: error?.message ?? String(error) });
      return;
    }
    // No turn of the beat's own will end this Run: a start that failed or was stopped resolves without a turn id, and a
    // message steered into a turn already running belongs to that turn, which isn't the beat's to classify.
    Promise.resolve(started).then(
      (result) => {
        if (result?.steered) release(chatId, entry, BUSY);
        else if (!result?.turnId) release(chatId, entry, "turn did not start");
        return null;
      },
      (error) => release(chatId, entry, error?.message ?? String(error)),
    );
  }

  // Ends a pending Run that no turn end will finish. `event` is the turn end that says so, when one did.
  function release(chatId, entry, error, event) {
    if (pending.get(chatId) !== entry) return;
    pending.delete(chatId);
    const routine = finish({ id: entry.runId }, chatId, { status: "failed", error });
    if (failedAgain(routine)) {
      if (event) event.quiet = true;
      // A beat that steered into someone else's turn has no turn end of its own to silence.
      else if (error !== BUSY) silenced.add(chatId);
    }
    syncKeepAwake();
    onChange();
  }

  async function dispatchAll(claims) {
    for (const { routine, run } of claims) {
      try {
        await dispatch(routine, run);
      } catch (error) {
        console.warn("[routines] dispatch failed", error);
      }
    }
  }

  async function tick() {
    if (ticking) return;
    ticking = true;
    try {
      if (!store.enabled()) {
        syncKeepAwake();
        return;
      }
      const at = now();
      store.expireDue(at);
      const claims = store.claimDue(at);
      await dispatchAll(claims);
      // The flag may have been off at start(); the first enabled tick then does start's sweep, after its claims so a due beat still records its Run.
      let changed = false;
      if (!swept) {
        swept = true;
        changed = sweepGone();
      }
      syncKeepAwake();
      if (changed || claims.length > 0) onChange();
    } finally {
      ticking = false;
    }
  }

  function start() {
    if (timer) return;
    store.recoverInterrupted();
    if (store.enabled()) {
      swept = true;
      sweepGone();
    }
    syncKeepAwake();
    timer = setTimer(() => {
      tick().catch((error) => console.warn("[routines] tick failed", error));
    }, TICK_MS);
    timer.unref?.();
  }

  function stop() {
    if (!timer) return;
    clearTimer(timer);
    timer = null;
  }

  function patchContext(chatId, runId, patch) {
    try {
      Promise.resolve(chats.patchRunContext(chatId, runId, patch)).catch((error) => console.warn("[routines] patchRunContext failed", error));
    } catch (error) {
      console.warn("[routines] patchRunContext failed", error);
    }
  }

  // Runs synchronously: it marks the event quiet before the runtime broadcasts it.
  function observe(chatId, event) {
    if (silenced.has(chatId)) {
      if (event.type === "message-sent" || event.type === "turn-started") silenced.delete(chatId);
      else if (isTurnEnd(event) && event.type !== "turn-completed") {
        silenced.delete(chatId);
        event.quiet = true;
      }
    }
    const entry = pending.get(chatId);
    if (!entry) return;
    if (event.type === "message-sent") {
      entry.sent = true;
      return;
    }
    if (event.type === "turn-started") {
      entry.turnStarted = true;
      return;
    }
    if (!isTurnEnd(event)) return;
    if (!entry.turnStarted) {
      // A turn end before the beat's message is the Chat's previous turn, published late. One after it, before any
      // turn-started, is the beat's turn failing to start (no agent CLI, Stop while it started).
      if (entry.sent && event.type !== "turn-completed")
        release(chatId, entry, event.type === "turn-failed" ? (event.message ?? "turn failed") : "cancelled", event);
      return;
    }
    pending.delete(chatId);
    const run = { id: entry.runId };
    let quiet = false;
    let summary;
    if (event.type === "turn-completed") {
      const pass = parsePass(chats.replyText(chatId));
      if (pass.quiet) {
        quiet = true;
        summary = pass.summary;
        event.quiet = true;
        finish(run, chatId, { status: "quiet", summary });
      } else {
        finish(run, chatId, { status: "acted" });
      }
    } else if (failedAgain(finish(run, chatId, { status: "failed", error: event.type === "turn-failed" ? event.message : "cancelled" }))) {
      event.quiet = true;
    }
    patchContext(chatId, entry.runId, quiet ? { quiet, summary } : { quiet });
    syncKeepAwake();
    onChange();
  }

  function chatArchived(chatId) {
    let changed = false;
    for (const routine of store.list()) {
      if (routine.target.kind !== "chat" || routine.target.chatId !== chatId) continue;
      store.complete(routine.id, "chat archived");
      changed = true;
    }
    if (!changed) return;
    syncKeepAwake();
    onChange();
  }

  async function runNow(routineId) {
    const started = store.startRun(routineId, now());
    if (!started) throw new Error(`Routine not found or completed: ${routineId}`);
    await dispatch(started.routine, started.run);
    syncKeepAwake();
    onChange();
    return store.runs(routineId).find((item) => item.id === started.run.id);
  }

  return { start, stop, tick, observe, chatArchived, runNow };
}

module.exports = { createRoutineScheduler };
