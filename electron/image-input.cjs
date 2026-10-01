const fs = require("node:fs/promises");
const os = require("node:os");
const path = require("node:path");
const { runAgent } = require("./agent-runner.cjs");

const MAX_IMAGES = 4;
const MAX_IMAGE_BYTES = 5 * 1024 * 1024;

function decodeImages(images = []) {
  if (!Array.isArray(images) || images.length > MAX_IMAGES) throw new Error("Attach up to 4 images per message.");
  return images.map((image) => {
    if (typeof image?.dataUrl !== "string" || image.dataUrl.length > Math.ceil(MAX_IMAGE_BYTES / 3) * 4 + 100) throw new Error("Each image must be 5 MB or smaller.");
    const match = /^data:(image\/(?:png|jpeg|webp|gif));base64,([A-Za-z0-9+/]+={0,2})$/.exec(image.dataUrl);
    if (!match) throw new Error("Use PNG, JPEG, WebP, or GIF images.");
    const bytes = Buffer.from(match[2], "base64");
    if (!bytes.length || bytes.length > MAX_IMAGE_BYTES || bytes.toString("base64") !== match[2]) throw new Error("Invalid image data.");
    const mime = match[1];
    const valid = mime === "image/png" ? bytes.subarray(0, 8).equals(Buffer.from([137,80,78,71,13,10,26,10]))
      : mime === "image/jpeg" ? bytes[0] === 255 && bytes[1] === 216 && bytes[2] === 255
      : mime === "image/gif" ? /^GIF8[79]a$/.test(bytes.subarray(0, 6).toString())
      : bytes.subarray(0, 4).toString() === "RIFF" && bytes.subarray(8, 12).toString() === "WEBP";
    if (!valid) throw new Error("The pasted file is not a valid supported image.");
    return { mime, bytes, base64: match[2] };
  });
}

async function runAgentWithImages(command, args, prompt, cwd, images, options = {}) {
  const { runImpl = runAgent, ...runOptions } = options;
  const decoded = decodeImages(images);
  if (!decoded.length) return runImpl(command, [...args, prompt], cwd, runOptions);
  if (command === "claude") {
    const input = JSON.stringify({
      type: "user",
      message: { role: "user", content: [
        { type: "text", text: prompt },
        ...decoded.map((image) => ({ type: "image", source: { type: "base64", media_type: image.mime, data: image.base64 } })),
      ] },
      parent_tool_use_id: null,
    }) + "\n";
    const output = await runImpl(command, [...args, "--input-format", "stream-json", "--output-format", "stream-json", "--verbose"], cwd, { ...runOptions, input });
    const events = output.split(/\r?\n/).filter(Boolean).map((line) => JSON.parse(line));
    const result = events.findLast((event) => event.type === "result");
    if (!result || result.is_error || typeof result.result !== "string") throw new Error(result?.errors?.join("\n") || result?.result || "Claude did not return a response.");
    return result.result;
  }
  const directory = await fs.mkdtemp(path.join(os.tmpdir(), "milagre-images-"));
  try {
    const flags = [];
    for (const [index, image] of decoded.entries()) {
      const file = path.join(directory, `${index}.${image.mime.split("/")[1]}`);
      await fs.writeFile(file, image.bytes, { mode: 0o600 });
      flags.push("--image", file);
    }
    return await runImpl(command, [...args, ...flags, "--", prompt], cwd, runOptions);
  } finally {
    await fs.rm(directory, { recursive: true, force: true });
  }
}

module.exports = { decodeImages, runAgentWithImages };
