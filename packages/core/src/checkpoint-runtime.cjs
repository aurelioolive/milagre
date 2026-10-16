const { projectOfKey, sessionIdFromKey } = require("@milagre/shared/agent-runs");
const { createCheckpoints } = require("./checkpoints.cjs");

function registerCheckpoints(commands, { directory, states, busy, ready }) {
  const preparing = new Set();
  async function rootsFor(chatId) {
    const scope = projectOfKey(chatId),
      id = sessionIdFromKey(chatId);
    if (typeof chatId !== "string" || !scope || !Number.isSafeInteger(id) || !states.has(scope)) throw new Error("Open an existing Chat to use checkpoints");
    const context = await states.executionContext(scope, id);
    if (!context.cwd) throw new Error("The Chat has no Worktree");
    return context.workspaceRoots ?? [context.cwd];
  }
  const store = createCheckpoints({
    directory,
    validateRoots: async (chatId, roots) => {
      const current = await rootsFor(chatId);
      if (JSON.stringify(current.toSorted()) !== JSON.stringify(roots.toSorted())) throw new Error("The checkpoint belongs to a different Worktree");
    },
    assertIdle: async (roots) => {
      for (const scope of states.projects()) {
        const state = await states.get(scope);
        for (const session of Object.values(state.sessions)) {
          if (!busy(`${scope}#${session.id}`) && !preparing.has(`${scope}#${session.id}`)) continue;
          const worktrees = session.worktrees?.map((member) => member.worktreePath) ?? [state.worktrees[session.worktree_id]?.path];
          if (worktrees.some((root) => roots.includes(root))) throw new Error("Wait for running Chats in this Worktree to finish");
        }
      }
    },
  });
  for (const method of ["list", "preview", "restore"])
    commands.handle(`checkpoint:${method}`, async (_context, request = {}) => {
      await ready();
      await rootsFor(request.chatId);
      if (method === "list") return store.list(request.chatId);
      if (method === "preview") return store.preview(request.chatId, request.id);
      return store.restore(request.chatId, request);
    });
  return {
    begin: async (request) => {
      preparing.add(request.chatId);
      try {
        await ready();
        return await store.begin({ chatId: request.chatId, roots: await rootsFor(request.chatId), permissionMode: request.permissionMode });
      } finally {
        preparing.delete(request.chatId);
      }
    },
    finish: (chatId) => store.finish(chatId),
  };
}
module.exports = { registerCheckpoints };
