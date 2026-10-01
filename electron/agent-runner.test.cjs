const assert = require("node:assert/strict");
const { EventEmitter } = require("node:events");
const test = require("node:test");
const { runAgent } = require("./agent-runner.cjs");

function silentChild() {
  const child = new EventEmitter();
  child.stdout = new EventEmitter();
  child.stderr = new EventEmitter();
  child.kill = () => {};
  return child;
}

test("runAgent returns the agent response", async () => {
  const child = silentChild();
  let spawnOptions;
  const result = runAgent("agent", [], process.cwd(), {
    spawnImpl: (_command, _args, options) => {
      spawnOptions = options;
      return child;
    },
    timeoutMs: 100,
  });

  child.stdout.emit("data", "oi de volta");
  child.emit("close", 0, null);

  await assert.doesNotReject(result);
  assert.equal(await result, "oi de volta");
  assert.deepEqual(spawnOptions.stdio, ["ignore", "pipe", "pipe"]);
});

test("runAgent rejects when the agent never finishes", async () => {
  const child = silentChild();
  const result = runAgent("agent", [], process.cwd(), {
    spawnImpl: () => child,
    timeoutMs: 10,
  });

  await assert.rejects(result, /Agent timed out after 10ms/);
});

test("runAgent pipes structured input and closes stdin", async () => {
  const child = silentChild();
  child.stdin = new EventEmitter();
  let input;
  child.stdin.end = (value) => { input = value; };
  const result = runAgent("agent", [], process.cwd(), {
    input: '{"type":"user"}\n',
    spawnImpl: (_command, _args, options) => {
      assert.deepEqual(options.stdio, ["pipe", "pipe", "pipe"]);
      return child;
    },
  });
  assert.equal(input, '{"type":"user"}\n');
  child.stdin.emit("error", Object.assign(new Error("closed"), { code: "EPIPE" }));
  child.stdout.emit("data", "answer");
  child.emit("close", 0, null);
  assert.equal(await result, "answer");
});
