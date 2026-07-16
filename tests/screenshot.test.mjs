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
  const h = await startHarness({ screenshot: fakeScreenshot });
  try {
    const out = path.join(os.tmpdir(), `mcp-bizhawk-test-${process.pid}.png`);
    // describe:false isolates the image-inlining behavior from the (default-on) vision caption.
    const res = await h.client.callTool({ name: "bizhawk_screenshot", arguments: { path: out, describe: false } });
    assert.match(textOf(res), /Screenshot saved: /);
    const img = res.content.find((c) => c.type === "image");
    assert.ok(img, "expected an inline image content block");
    assert.equal(img.mimeType, "image/png");
    assert.equal(img.data, PNG_B64);
    fs.rmSync(out, { force: true });
  } finally {
    await h.close();
  }
});

test("bizhawk_screenshot works with no path (defaults to a temp file)", async () => {
  const h = await startHarness({ screenshot: fakeScreenshot });
  try {
    const res = await h.client.callTool({ name: "bizhawk_screenshot", arguments: { describe: false } });
    const img = res.content.find((c) => c.type === "image");
    assert.ok(img, "expected an inline image content block");
    const m = textOf(res).match(/Screenshot saved: (\S+)/);
    assert.ok(m, "expected the saved path in the text block");
    assert.ok(m[1].includes("mcp-bizhawk-shot-"), `unexpected default path ${m[1]}`);
    fs.rmSync(m[1], { force: true });
  } finally {
    await h.close();
  }
});

test("bizhawk_screenshot degrades to text-only when the file is unreadable", async () => {
  // Bridge claims success but never writes the file (e.g. BizHawk on a
  // different machine / different filesystem).
  const h = await startHarness({ screenshot: (p) => p.path });
  try {
    const res = await h.client.callTool({
      name: "bizhawk_screenshot",
      arguments: { path: path.join(os.tmpdir(), "does-not-exist-dir-xyz", "shot.png"), describe: false },
    });
    assert.equal(res.isError ?? false, false);
    assert.match(textOf(res), /could not inline image/);
    assert.equal(res.content.find((c) => c.type === "image"), undefined);
  } finally {
    await h.close();
  }
});
