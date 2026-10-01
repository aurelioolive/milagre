const test = require("node:test");
const assert = require("node:assert/strict");
const fs = require("node:fs/promises");
const { decodeImages, runAgentWithImages } = require("./image-input.cjs");
const png = "iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAQAAAC1HAwCAAAAC0lEQVR42mP8/x8AAwMCAO+aX1cAAAAASUVORK5CYII=";
const image = { id: "one", name: "pasted.png", dataUrl: `data:image/png;base64,${png}` };

test("validates pasted images and rejects unsupported or excessive attachments", () => {
  assert.equal(decodeImages([image])[0].mime, "image/png");
  assert.throws(() => decodeImages(Array(5).fill(image)), /up to 4/);
  assert.throws(() => decodeImages([{ dataUrl: "data:image/svg+xml;base64,PHN2Zz4=" }]), /PNG/);
  assert.throws(() => decodeImages([{ dataUrl: "data:image/png;base64,aGVsbG8=" }]), /valid supported image/);
  assert.throws(() => decodeImages([{ dataUrl: "x".repeat(8 * 1024 * 1024) }]), /5 MB/);
});

test("text requests retain their original command arguments", async () => {
  await runAgentWithImages("claude", ["--print"], "hello", "/project", [], {
    runImpl: async (command, args, cwd, options) => {
      assert.deepEqual(args, ["--print", "hello"]);
      assert.equal(options.input, undefined);
      return "answer";
    },
  });
});

test("Codex receives image files and cleans up after success and failure", async () => {
  for (const fail of [false, true]) {
    let imagePath;
    const result = runAgentWithImages("codex", ["exec"], "describe", "/project", [image], {
      runImpl: async (_command, args) => {
        imagePath = args[args.indexOf("--image") + 1];
        assert.deepEqual(await fs.readFile(imagePath), Buffer.from(png, "base64"));
        assert.deepEqual(args.slice(-2), ["--", "describe"]);
        if (fail) throw new Error("agent failed");
        return "answer";
      },
    });
    if (fail) await assert.rejects(result, /agent failed/);
    else assert.equal(await result, "answer");
    await assert.rejects(fs.stat(imagePath), { code: "ENOENT" });
  }
});

test("Claude receives image content via stdin and returns only the final response", async () => {
  const output = await runAgentWithImages("claude", ["--print"], "describe", "/project", [image], {
    runImpl: async (_command, args, _cwd, options) => {
      assert.ok(args.includes("--input-format"));
      assert.ok(!args.includes(png));
      const input = JSON.parse(options.input);
      assert.equal(input.message.content[0].text, "describe");
      assert.deepEqual(input.message.content[1], { type: "image", source: { type: "base64", media_type: "image/png", data: png } });
      return '{"type":"system"}\n{"type":"result","result":"A screenshot","is_error":false}\n';
    },
  });
  assert.equal(output, "A screenshot");
});

test("Claude error results are surfaced as errors", async () => {
  await assert.rejects(runAgentWithImages("claude", [], "describe", "/project", [image], {
    runImpl: async () => '{"type":"result","is_error":true,"errors":["Image rejected"]}',
  }), /Image rejected/);
});
