const assert = require("node:assert/strict");
const fs = require("node:fs");
const path = require("node:path");
const { setTimeout: delay } = require("node:timers/promises");
const fixture = `
import React from 'react';
import { createRoot } from 'react-dom/client';
import { CheckpointControl } from '/src/components/changes/CheckpointControl';
import '/src/styles.css';
const item = { id: 'task-1', createdAt: 1792152000000, completedAt: 1792152100000, excluded: 3, permissionMode: 'ask', kind: 'task' };
window.restores = [];
window.failStale = true;
window.didRestore = false;
window.milagre = { checkpoints: {
 list: async () => window.didRestore ? [{...item,id:"recovery",kind:"recovery",createdAt:item.createdAt+300000},item] : [item],
 preview: async () => ({...item, token:'preview', files:[
 {key:'0:src/login.ts', path:'src/login.ts', worktree:'/Projects/account-settings', action:'replace', conflict:true},
 {key:'0:src/helper.ts', path:'src/helper.ts', worktree:'/Projects/account-settings', action:'delete', conflict:false}]}),
 restore: async request => { window.restores.push(request); if(window.failStale) throw new Error('Files changed. Preview again before restoring'); window.didRestore=true; return {restored:1,recoveryId:'recovery'}; }
}};
createRoot(document.getElementById('root')).render(<div className="h-screen bg-canvas p-8 text-ink"><CheckpointControl chatId="/Projects/account-settings#1" /></div>);
`;
async function browserChecks() {
  const { app, BrowserWindow } = require("electron");
  const profile = fs.mkdtempSync(path.join(require("node:os").tmpdir(), "checkpoint-electron-"));
  app.setPath("userData", profile);
  await app.whenReady();
  const window = new BrowserWindow({ width: 1000, height: 850, show: false, webPreferences: { backgroundThrottling: false } });
  const evaluate = (source) =>
    window.webContents.executeJavaScript(source).catch((error) => {
      throw new Error(source + ": " + error.message);
    });
  const wait = async (source) => {
    for (let n = 0; n < 200; n++) {
      if (await evaluate(source)) return;
      await delay(25);
    }
    throw new Error("Timed out: " + source);
  };
  const shot = async (name) => {
    await delay(180);
    if (process.env.MILAGRE_SCREENSHOT_DIR)
      fs.writeFileSync(path.join(process.env.MILAGRE_SCREENSHOT_DIR, "checkpoints-" + name + ".png"), (await window.webContents.capturePage()).toPNG());
  };
  try {
    await window.loadURL(process.argv[2]);
    await wait('!!document.querySelector("[data-checkpoints-open]")');
    await evaluate('document.querySelector("[data-checkpoints-open]").click()');
    await wait('!!document.querySelector("[data-checkpoint-id]")');
    await shot("list");
    await evaluate('document.querySelector("[data-checkpoint-id]").click()');
    await wait('document.querySelectorAll("[data-checkpoint-file]").length === 2');
    assert.equal(await evaluate('document.querySelector("[data-checkpoint-restore]").disabled'), true);
    await shot("preview");
    await evaluate(
      'document.querySelectorAll("[data-checkpoint-choice=keep]")[0].click(); document.querySelectorAll("[data-checkpoint-choice=restore]")[1].click()',
    );
    await wait('!document.querySelector("[data-checkpoint-restore]").disabled');
    await shot("resolved");
    await evaluate('document.querySelector("[data-checkpoint-restore]").click()');
    await wait('document.querySelector("[role=alert]")?.textContent.includes("Files changed")');
    assert.equal(await evaluate('document.querySelector("[data-checkpoint-restore]").disabled'), true);
    assert.deepEqual(await evaluate("window.restores[0]"), {
      chatId: "/Projects/account-settings#1",
      token: "preview",
      decisions: { "0:src/login.ts": "keep", "0:src/helper.ts": "restore" },
      approved: true,
    });
    await shot("stale");
    await evaluate('window.failStale=false; [...document.querySelectorAll("button")].find(b=>b.textContent==="Preview again").click()');
    await wait('!document.querySelector("[role=alert]") && document.querySelectorAll("[data-checkpoint-file]").length === 2');
    assert.equal(await evaluate('document.querySelector("[data-checkpoint-restore]").disabled'), true);
    await evaluate(
      'document.querySelectorAll("[data-checkpoint-choice=keep]")[0].click(); document.querySelectorAll("[data-checkpoint-choice=restore]")[1].click()',
    );
    await wait('!document.querySelector("[data-checkpoint-restore]").disabled');
    await evaluate('document.querySelector("[data-checkpoint-restore]").click()');
    await wait('document.querySelector("[role=status]")?.textContent.includes("1 file restored")');
    await shot("restored");
    await evaluate(`document.querySelector('[aria-label="Close checkpoints"]').click()`);
    await wait('!document.querySelector("[data-checkpoints-dialog]")');
    console.log("PASS: checkpoint list, conflict preview, required decisions, stale restore refusal, fresh preview and explicit restore");
    window.destroy();
    app.exit(0);
  } catch (error) {
    console.error(error);
    app.exit(1);
  }
}
async function main() {
  const { createServer } = await import("vite");
  const { spawn } = require("node:child_process");
  const server = await createServer({
    server: { host: "127.0.0.1", port: 0 },
    plugins: [
      {
        name: "checkpoint-fixture",
        resolveId: (id) => (id === "/__checkpoint_fixture.tsx" ? id : undefined),
        load: (id) => (id === "/__checkpoint_fixture.tsx" ? fixture : undefined),
        configureServer(server) {
          server.middlewares.use((req, res, next) => {
            if (req.url !== "/__checkpoints__") return next();
            res.setHeader("Content-Type", "text/html");
            void server
              .transformIndexHtml(req.url, '<html><body><div id="root"></div><script type="module" src="/__checkpoint_fixture.tsx"></script></body></html>')
              .then((html) => res.end(html))
              // oxlint-disable-next-line promise/no-callback-in-promise -- Connect requires its next callback for middleware errors.
              .catch(next);
          });
        },
      },
    ],
  });
  try {
    await server.listen();
    const env = { ...process.env };
    delete env.ELECTRON_RUN_AS_NODE;
    const child = spawn(require("electron"), [path.resolve(__filename), server.resolvedUrls.local[0] + "__checkpoints__"], { env, stdio: "inherit" });
    process.exitCode = await new Promise((resolve, reject) => {
      child.on("error", reject);
      child.on("exit", (code) => resolve(code ?? 1));
    });
  } finally {
    await server.close();
  }
}
(process.versions.electron ? browserChecks() : main()).catch((error) => {
  console.error(error);
  process.exitCode = 1;
});
