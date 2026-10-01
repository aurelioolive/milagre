const { spawn } = require("node:child_process");

function runAgent(command, args, cwd, options = {}) {
  const {
    timeoutMs = 120_000,
    spawnImpl = spawn,
    onSpawn,
    input,
  } = options;

  return new Promise((resolve, reject) => {
    const child = spawnImpl(command, args, {
      cwd,
      env: process.env,
      stdio: [input === undefined ? "ignore" : "pipe", "pipe", "pipe"],
      windowsHide: true,
    });
    onSpawn?.(child);
    let stdout = "";
    let stderr = "";
    let settled = false;

    const finish = (callback, value) => {
      if (settled) return;
      settled = true;
      clearTimeout(timeout);
      callback(value);
    };

    const timeout = setTimeout(() => {
      child.kill("SIGTERM");
      finish(reject, new Error(`Agent timed out after ${timeoutMs}ms`));
    }, timeoutMs);

    child.stdout.on("data", (chunk) => {
      stdout += chunk.toString();
    });
    child.stderr.on("data", (chunk) => {
      stderr += chunk.toString();
    });
    child.on("error", (error) => finish(reject, error));
    if (input !== undefined) {
      child.stdin.on("error", (error) => {
        if (error.code !== "EPIPE") {
          child.kill("SIGTERM");
          finish(reject, error);
        }
      });
      child.stdin.end(input);
    }
    child.on("close", (code, signal) => {
      const output = stdout.trim();
      if (code === 0 && output) return finish(resolve, output);

      if (signal === "SIGTERM") return finish(reject, new Error("Agent cancelled by user"));

      const detail = stderr.trim() || output || `Agent exited with code ${code}${signal ? ` (${signal})` : ""}`;
      finish(reject, new Error(detail));
    });

  });
}

module.exports = { runAgent };
