const test = require("node:test");
const assert = require("node:assert/strict");
const { routineChats, routineReply } = require("./runtime-adapter.cjs");

const chatId = "/project#2";
const state = {
  sessions: { 2: { id: 2, worktree_id: 1, provider: "codex" }, 3: { id: 3, worktree_id: 1, archived: true } },
  messages: [
    { id: 1, session_id: 2, role: "user", body: "Watch CI", context: null, model: "gpt-x" },
    { id: 2, session_id: 2, role: "assistant", body: "(pass) old beat", context: null },
    { id: 3, session_id: 2, role: "user", body: "Check CI", context: { kind: "routine-run", runId: "run-1" }, model: "gpt-x" },
    { id: 4, session_id: 2, role: "assistant", body: "Note", context: { kind: "git-action" } },
    { id: 5, session_id: 2, role: "assistant", body: "  (pass) CI green  ", context: null },
  ],
};

function fixture({ turnSettings = null, runs = {}, busy = false, open = true } = {}) {
  const sent = [];
  const patched = [];
  const chats = {
    runs,
    isBusy: () => busy,
    turnSettings: () => turnSettings,
    send: async (request) => {
      sent.push(request);
      return { sessionId: request.sessionId, started: Promise.resolve({ turnId: "t" }) };
    },
    patchMessageContext: async (...args) => {
      patched.push(args);
      return true;
    },
  };
  const store = { get: (id) => (id === "r1" ? { id, provider: "claude", model: "cm", permissionMode: "full" } : null) };
  const adapter = routineChats({
    chats,
    store,
    cachedState: (scope) => (open && scope === "/project" ? state : undefined),
    openState: async () => state,
    isClosing: () => false,
  });
  return { adapter, sent, patched };
}

test("a Chat in a Project not open yet counts as there, so it is never swept as gone", () => {
  const { adapter } = fixture({ open: false });
  assert.equal(adapter.exists(chatId), true);
  assert.equal(adapter.archived(chatId), false);
  const opened = fixture().adapter;
  assert.equal(opened.exists(chatId), true);
  assert.equal(opened.exists("/project#9"), false);
  assert.equal(opened.archived("/project#3"), true);
});

test("busy covers a running turn and an approval or question waiting", () => {
  assert.equal(fixture({ busy: true }).adapter.busy(chatId), true);
  assert.equal(fixture().adapter.busy(chatId), false);
  assert.equal(fixture({ runs: { [chatId]: { approvals: [{}], questions: [] } } }).adapter.busy(chatId), true);
  assert.equal(fixture({ runs: { [chatId]: { approvals: [], questions: [{}] } } }).adapter.busy(chatId), true);
});

test("after a restart a beat runs on the Chat's own provider and last model, with the routine's permission mode", async () => {
  const { adapter, sent } = fixture();
  const context = { kind: "routine-run", routineId: "r1", runId: "run-2" };
  const { started } = await adapter.send(chatId, { body: "Check CI", prompt: "Check CI + hint", context });
  assert.deepEqual(await started, { turnId: "t" });
  assert.equal(sent[0].provider, "codex");
  assert.equal(sent[0].model, "gpt-x");
  assert.equal(sent[0].permissionMode, "full");
  assert.equal(sent[0].projectPath, "/project");
  assert.equal(sent[0].sessionId, 2);
  assert.equal(sent[0].worktreeId, 1);
  assert.equal(sent[0].prompt, "Check CI + hint");
  assert.equal(sent[0].context, context);
});

test("a beat keeps the Chat's latest turn settings when it has some", async () => {
  const { adapter, sent } = fixture({ turnSettings: { provider: "claude", model: "opus", permissionMode: "plan", effort: "high" } });
  await adapter.send(chatId, { body: "b", prompt: "p", context: { kind: "routine-run", routineId: "r1" } });
  assert.equal(sent[0].provider, "claude");
  assert.equal(sent[0].model, "opus");
  assert.equal(sent[0].effort, "high");
  assert.equal(sent[0].permissionMode, "full");
});

test("a beat into a Chat that's gone fails", async () => {
  const { adapter } = fixture();
  await assert.rejects(adapter.send("/project#9", { body: "b", prompt: "p", context: { kind: "routine-run", routineId: "r1" } }), /no longer in its Project/);
});

test("the reply is the streamed text while the run holds it, else what was saved after the latest divider", () => {
  assert.equal(fixture({ runs: { [chatId]: { text: "(pass) live" } } }).adapter.replyText(chatId), "(pass) live");
  assert.equal(fixture().adapter.replyText(chatId), "(pass) CI green");
  assert.equal(routineReply({ messages: [{ session_id: 2, role: "assistant", body: "(pass) x", context: null }] }, 2), "");
});

test("patchRunContext patches the divider of that Run", async () => {
  const { adapter, patched } = fixture();
  await adapter.patchRunContext(chatId, "run-1", { quiet: true, summary: "CI green" });
  const [[projectPath, sessionId, match, patch]] = patched;
  assert.equal(projectPath, "/project");
  assert.equal(sessionId, 2);
  assert.deepEqual(patch, { quiet: true, summary: "CI green" });
  assert.deepEqual(
    state.messages.filter(match).map((message) => message.id),
    [3],
  );
});
