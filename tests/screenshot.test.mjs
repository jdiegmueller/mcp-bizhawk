import test from "node:test";
import assert from "node:assert/strict";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { startHarness, textOf } from "./helpers/harness.mjs";

// 1×1 transparent PNG
const PNG_B64 =
  "iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAYAAAAfFcSJAAAADUlEQVR42mP8z8BQDwAEhQGAhKmMIQAAAABJRU5ErkJggg==";

// Mimics client.screenshot: writes a PNG at the requested path.
function fakeScreenshot(p) {
  fs.writeFileSync(p.path, Buffer.from(PNG_B64, "base64"));
  return p.path;
}

test("bizhawk_screenshot inlines the PNG as an image content block", async () => {
  const shotDir = fs.mkdtempSync(path.join(os.tmpdir(), "mcp-shot-inline-"));
  const h = await startHarness({ screenshot: fakeScreenshot }, { backend: { shotDir } });
  try {
    // describe:false isolates the image-inlining behavior from the (default-on) vision caption.
    const res = await h.client.callTool({ name: "bizhawk_screenshot", arguments: { target: h.target, name: "inline", describe: false } });
    const text = textOf(res);
    assert.match(text, /Screenshot captured: inline\.png/);
    assert.doesNotMatch(text, /X:\\|\/mnt\/8tb\/jason/);
    assert.ok(!text.includes(shotDir), `leaked host screenshot dir in ${text}`);
    const img = res.content.find((c) => c.type === "image");
    assert.ok(img, "expected an inline image content block");
    assert.equal(img.mimeType, "image/png");
    assert.equal(img.data, PNG_B64);
  } finally {
    await h.close();
    fs.rmSync(shotDir, { recursive: true, force: true });
  }
});

test("bizhawk_screenshot works with no path (defaults to a temp file)", async () => {
  const h = await startHarness({ screenshot: fakeScreenshot });
  try {
    const res = await h.client.callTool({ name: "bizhawk_screenshot", arguments: { target: h.target, describe: false } });
    const img = res.content.find((c) => c.type === "image");
    assert.ok(img, "expected an inline image content block");
    const m = textOf(res).match(/Screenshot captured: (mcp-bizhawk-shot-\d+-\d+\.png)/);
    assert.ok(m, "expected the generated screenshot name in the text block");
    assert.doesNotMatch(textOf(res), /X:\\|\/mnt\/8tb\/jason|\/tmp\//);
    fs.rmSync(path.join(os.tmpdir(), m[1]), { force: true });
  } finally {
    await h.close();
  }
});

test("bizhawk_screenshot degrades to text-only when the file is unreadable", async () => {
  // Bridge claims success but never writes the file (e.g. BizHawk on a
  // different machine / different filesystem).
  const shotDir = fs.mkdtempSync(path.join(os.tmpdir(), "mcp-shot-missing-"));
  const h = await startHarness({ screenshot: (p) => p.path }, { backend: { shotDir } });
  try {
    const res = await h.client.callTool({
      name: "bizhawk_screenshot",
      arguments: { target: h.target, name: "missing", describe: false },
    });
    assert.equal(res.isError ?? false, false);
    assert.match(textOf(res), /Screenshot captured: missing\.png/);
    assert.match(textOf(res), /could not inline image/);
    assert.doesNotMatch(textOf(res), /X:\\|\/mnt\/8tb\/jason|mcp-shot-missing-/);
    assert.equal(res.content.find((c) => c.type === "image"), undefined);
  } finally {
    await h.close();
    fs.rmSync(shotDir, { recursive: true, force: true });
  }
});

test("bizhawk_screenshot resolves name through backend shot path config", async () => {
  const shotDir = fs.mkdtempSync(path.join(os.tmpdir(), "mcp-shot-host-"));
  const h = await startHarness({
    screenshot: (p) => {
      assert.equal(p.path, "X:\\tmp\\named-shot.png");
      fs.writeFileSync(path.join(shotDir, "named-shot.png"), Buffer.from(PNG_B64, "base64"));
      return p.path;
    },
  }, {
    backend: {
      os: "windows",
      shotDir,
      shotDirBridge: "X:\\tmp",
    },
  });
  try {
    const res = await h.client.callTool({
      name: "bizhawk_screenshot",
      arguments: { target: h.target, name: "named-shot", describe: false },
    });
    assert.match(textOf(res), /Screenshot captured: named-shot\.png/);
    assert.doesNotMatch(textOf(res), /X:\\|\/mnt\/8tb\/jason/);
    const img = res.content.find((c) => c.type === "image");
    assert.ok(img, "expected an inline image content block");
    assert.equal(img.data, PNG_B64);
  } finally {
    await h.close();
    fs.rmSync(shotDir, { recursive: true, force: true });
  }
});
