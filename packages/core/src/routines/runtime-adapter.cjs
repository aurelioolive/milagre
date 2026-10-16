const { lastUserModel, projectOfKey, sessionIdFromKey } = require("@milagre/shared/agent-runs");
const { isLinkScopeKey } = require("@milagre/shared/chat-scopes");
const { createRoutineStore } = require("./store.cjs");
const { createRoutineScheduler } = require("./scheduler.cjs");
const { createRoutineTools } = require("./tools.cjs");

const OFF = "Routines are off. Turn them on in Settings › Experimental.";
const TOOLS_OFF = "Routines are turned off in Settings › Experimental.";

/**
 * How a heartbeat's turn ended: the text after its last tool step in its last reply. A beat that reads "Let me check
 * CI." → a tool call → "(pass) CI green" ended with a pass, though the reply saved is the whole turn's text. The replies
 * are the ones saved after the Chat's latest routine-run divider (Milagre's own notes left out), as `delegationReply`
 * reads a Delegation's: the streamed run is folded away before the turn's end is published, so they are all there is.
 */
function routineReply(state, sessionId) {
  const messages = (state?.messages ?? []).filter((message) => message.session_id === sessionId);
  const start = messages.findLastIndex((message) => message.role === "user" && message.context?.kind === "routine-run");
  if (start === -1) return "";
  const last = messages
    .slice(start + 1)
    .findLast((message) => message.role === "assistant" && message.context == null && (message.body?.trim() || message.steps?.length));
  if (!last) return "";
  const body = last.body ?? "";
  // Step offsets index the saved body (see savedSteps); thinking isn't a tool step.
  const cut = Math.max(0, ...(last.steps ?? []).filter((step) => step.kind !== "thinking").map((step) => step.offset ?? 0));
  return body.slice(cut).trim();
}

/**
 * The scheduler's view of the Chats (see scheduler.cjs). `cachedState(scope)` is a scope's state in memory, undefined
 * when it isn't open; `openState(scope, sessionId)` opens it if needed and resolves with the Chat's messages loaded.
 */
function routineChats({ chats, store, cachedState, openState, isClosing }) {
  const session = (chatId) => cachedState(projectOfKey(chatId))?.sessions?.[sessionIdFromKey(chatId)];
  return {
    // A Project not open yet is unknown, not gone: send opens it, and a Chat missing then fails its Run.
    exists: (chatId) => cachedState(projectOfKey(chatId)) === undefined || Boolean(session(chatId)),
    archived: (chatId) => session(chatId)?.archived === true,
    busy(chatId) {
      const run = chats.runs[chatId];
      return chats.isBusy(chatId) || Boolean(run?.approvals?.length || run?.questions?.length);
    },
    // A beat runs on the Chat's latest turn settings, its permission mode included, so a mode the user changed since
    // the heartbeat was set holds. After a restart: the Chat's own provider and last model, and the mode the Chat had
    // when the heartbeat was set.
    async send(chatId, { body, prompt, context }) {
      if (isClosing()) throw new Error("Milagre is closing.");
      const projectPath = projectOfKey(chatId);
      const sessionId = sessionIdFromKey(chatId);
      const state = await openState(projectPath, sessionId);
      const target = state?.sessions?.[sessionId];
      if (!target) throw new Error("That Chat is no longer in its Project.");
      const routine = store.get(context.routineId);
      const latest = chats.turnSettings(chatId);
      const settings = latest ?? {
        provider: target.provider ?? routine?.provider ?? "claude",
        model: lastUserModel(state, sessionId) || routine?.model,
      };
      const { started } = await chats.send({
        ...settings,
        permissionMode: latest?.permissionMode ?? routine?.permissionMode ?? "auto",
        body,
        prompt,
        context,
        images: [],
        files: [],
        projectPath,
        sessionId,
        worktreeId: target.worktree_id,
      });
      // Whether the Chat was unread before the beat, so a quiet one can leave it that way.
      return { started, unread: target.unread === true };
    },
    // Called on the turn's end, which is published after it was folded into the saved reply (ChatHost.receive).
    replyText: (chatId) => routineReply(cachedState(projectOfKey(chatId)), sessionIdFromKey(chatId)),
    // `session` patches the Chat in the same change (see ChatHost.patchMessageContext).
    async patchRunContext(chatId, runId, patch, session) {
      await chats.patchMessageContext(
        projectOfKey(chatId),
        sessionIdFromKey(chatId),
        (message) => message.role === "user" && message.context?.kind === "routine-run" && message.context.runId === runId,
        patch,
        session,
      );
    },
  };
}

/**
 * Routines in the runtime: the store at `file`, the scheduler over the Chats, the agent tools and the `routines:*`
 * commands. Every write says `routines:changed`. `timers` ({ now, setInterval, clearInterval }) is for tests.
 */
function createRoutines({ file, chats, keepAwake, emit, cachedState, openState, isClosing = () => false, timers = {} }) {
  const now = timers.now ?? Date.now;
  const store = createRoutineStore({ file, now });
  const changed = () => emit("routines:changed", { enabled: store.enabled() });
  const scheduler = createRoutineScheduler({
    store,
    chats: routineChats({ chats, store, cachedState, openState, isClosing }),
    keepAwake,
    now,
    ...(timers.setInterval ? { setInterval: timers.setInterval } : {}),
    ...(timers.clearInterval ? { clearInterval: timers.clearInterval } : {}),
    onChange: changed,
  });
  function chatSettings(chatId) {
    const latest = chats.turnSettings(chatId);
    const state = cachedState(projectOfKey(chatId));
    const session = state?.sessions?.[sessionIdFromKey(chatId)];
    if (!latest && !session) return null;
    return {
      provider: latest?.provider ?? session?.provider,
      model: latest?.model || (state ? lastUserModel(state, sessionIdFromKey(chatId)) : undefined) || undefined,
      permissionMode: latest?.permissionMode,
    };
  }
  const tools = createRoutineTools({
    store,
    scheduler,
    chatSettings,
    defaultTimezone: () => Intl.DateTimeFormat().resolvedOptions().timeZone,
    now,
  });

  return {
    enabled: () => store.enabled(),
    // A session keeps the tools it was given, so each one checks the switch when it runs. An agent's write through a
    // tool says routines changed, like a command's. The definitions are new on each call. A Chat on a Named Link gets
    // none: heartbeats there are out of scope (see the spec's non-goals).
    definitions: (chatId) =>
      (isLinkScopeKey(projectOfKey(chatId)) ? [] : tools.definitions(chatId)).map((tool) => {
        const { run } = tool;
        tool.run = async (input) => {
          if (!store.enabled()) throw new Error(TOOLS_OFF);
          try {
            return await run(input);
          } finally {
            if (!tool.readOnly) changed();
          }
        };
        return tool;
      }),
    /** Runs synchronously, before the event is broadcast, so a quiet turn's end carries `quiet` to every listener. */
    observe(chatId, event) {
      try {
        scheduler.observe(chatId, event);
      } catch (error) {
        console.warn("[routines] observe failed", error);
      }
    },
    chatArchived: (chatId) => scheduler.chatArchived(chatId),
    // The timer only starts once the switch is on; off again, it keeps running and each tick returns at once.
    start() {
      if (store.enabled()) scheduler.start();
    },
    stop: () => scheduler.stop(),
    read: () => ({ enabled: store.enabled() }),
    async save(value) {
      const enabled = store.setEnabled(value === true);
      if (enabled) scheduler.start();
      // Off: one tick turns the routines' keep-awake off now.
      else await scheduler.tick();
      changed();
      return { enabled };
    },
    // store.list gives copies, so each takes its Runs in place.
    list: () => ({ routines: store.list().map((routine) => Object.assign(routine, { runs: store.runs(routine.id) })) }),
    update(id, patch) {
      if (typeof id !== "string" || !id) throw new Error("Choose a routine.");
      if (!patch || typeof patch !== "object" || Array.isArray(patch)) throw new Error("A routine change must be an object.");
      const routine = store.update(id, patch);
      changed();
      return routine;
    },
    remove(id) {
      if (typeof id !== "string" || !id) throw new Error("Choose a routine.");
      const removed = store.remove(id);
      if (removed) changed();
      return { removed };
    },
    async runNow(id) {
      if (!store.enabled()) throw new Error(OFF);
      if (typeof id !== "string" || !id) throw new Error("Choose a routine.");
      return scheduler.runNow(id);
    },
  };
}

module.exports = { createRoutines, routineChats, routineReply };
