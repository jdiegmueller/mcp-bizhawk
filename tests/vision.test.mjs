import test from "node:test";
import assert from "node:assert/strict";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { startHarness, textOf } from "./helpers/harness.mjs";
import { startVisionStub } from "./helpers/vision-stub.mjs";

const DOMAINS = ["M68K BUS", "68K RAM"];

function tempPng() {
  const p = path.join(os.tmpdir(), `mcp-vision-test-${process.pid}-${Math.random().toString(36).slice(2)}.png`);
  fs.writeFileSync(p, Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a]));
  return p;
}

// A screenshot handler that actually writes the PNG at the requested path, so
// the server can read it back to inline it AND hand it to the vision stub.
function writingScreenshot(p) {
  fs.writeFileSync(p.path, Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a]));
  return p.path;
}

test("bizhawk_screenshot returns the PNG AND a vision caption by default", async () => {
  const stub = await startVisionStub("A hockey rink; the puck is near center ice.");
  const shotDir = fs.mkdtempSync(path.join(os.tmpdir(), "mcp-vision-shot-"));
  process.env.VISION_BASE_URL = stub.baseUrl;
  process.env.VISION_MODEL = "test-vlm";
  const h = await startHarness({ screenshot: writingScreenshot }, { backend: { shotDir } });
  try {
    // describe defaults to true — no need to pass it.
    const res = await h.client.callTool({
      name: "bizhawk_screenshot",
      arguments: { target: h.target, name: "captioned", describe_prompt: "Where is the puck?" },
    });
    const t = textOf(res);
    // The PNG is STILL inlined (describe is additive now, not a replacement)...
    assert.equal(res.content.filter((c) => c.type === "image").length, 1, "PNG inlined");
    // ...and the caption is appended.
    assert.match(t, /A hockey rink; the puck is near center ice\./);
    assert.match(t, /Described by test-vlm/);

    // We sent a system message, the prompt, and a PNG data URL.
    assert.equal(stub.received.length, 1);
    const messages = stub.received[0].body.messages;
    assert.equal(messages[0].role, "system");
    assert.match(messages[0].content, /NHL '94/, "system message frames the NHL94 task");
    assert.match(messages[0].content, /NEVER infer stoppage merely because the HUD clock is unchanged/);
    assert.equal(messages[1].role, "user");
    assert.equal(messages[1].content[0].text, "Where is the puck?");
    assert.match(messages[1].content[1].image_url.url, /^data:image\/png;base64,/);
  } finally {
    delete process.env.VISION_BASE_URL;
    delete process.env.VISION_MODEL;
    fs.rmSync(shotDir, { recursive: true, force: true });
    await h.close();
    await stub.close();
  }
});

test("bizhawk_screenshot describe:false returns the PNG only, no vision call", async () => {
  const stub = await startVisionStub("should never be produced");
  const shotDir = fs.mkdtempSync(path.join(os.tmpdir(), "mcp-vision-no-desc-"));
  process.env.VISION_BASE_URL = stub.baseUrl;
  process.env.VISION_MODEL = "test-vlm";
  const h = await startHarness({ screenshot: writingScreenshot }, { backend: { shotDir } });
  try {
    const res = await h.client.callTool({
      name: "bizhawk_screenshot",
      arguments: { target: h.target, name: "no-desc", describe: false },
    });
    assert.equal(res.content.filter((c) => c.type === "image").length, 1, "PNG inlined");
    assert.equal(stub.received.length, 0, "vision endpoint not called when describe:false");
    assert.doesNotMatch(textOf(res), /Described by/);
  } finally {
    delete process.env.VISION_BASE_URL;
    delete process.env.VISION_MODEL;
    fs.rmSync(shotDir, { recursive: true, force: true });
    await h.close();
    await stub.close();
  }
});

test("bizhawk_screenshot degrades to image + note when vision is unconfigured", async () => {
  delete process.env.VISION_BASE_URL;
  delete process.env.VISION_MODEL;
  const shotDir = fs.mkdtempSync(path.join(os.tmpdir(), "mcp-vision-unconfigured-"));
  const h = await startHarness({ screenshot: writingScreenshot }, { backend: { shotDir } });
  try {
    // describe defaults true, but vision isn't configured: still succeed, still
    // return the image, and append a short note instead of erroring.
    const res = await h.client.callTool({ name: "bizhawk_screenshot", arguments: { target: h.target, name: "unconfigured" } });
    assert.equal(res.isError ?? false, false);
    assert.equal(res.content.filter((c) => c.type === "image").length, 1, "PNG still returned");
    assert.match(textOf(res), /vision caption unavailable/);
  } finally {
    await h.close();
    fs.rmSync(shotDir, { recursive: true, force: true });
  }
});

test("nhl94_state appends a vision caption by default, omits it with describe:false", async () => {
  const stub = await startVisionStub("Faceoff at center ice; players lined up.");
  process.env.VISION_BASE_URL = stub.baseUrl;
  process.env.VISION_MODEL = "test-vlm";
  const rec = (i) => ({ _index: i, x: 0, y: 0, z: 0, xv: 0, yv: 0, zv: 0, fdir: 0, frame: 0, attr: 0, anim: 0, spanum: 0, spacnt: 0 });
  const h = await startHarness({
    list_memory_domains: () => DOMAINS,
    read_struct_array: (p) => Array.from({ length: p.count }, (_, i) => rec(i)),
    read_many: () => ({ carrier: 0xff02, gameclock: 300, gsp: 0, gmode: 0, vpos: 0, hpos: 0, yleader: 0, session: 0xff, shotplayer: -1, lastplayer: -1, passdir: 0, passspeed: 0 }),
    list_frozen: () => ({ frozen: [] }),
    screenshot: writingScreenshot,
  });
  try {
    // Default: structured data + caption.
    const t = textOf(await h.client.callTool({ name: "nhl94_state", arguments: { target: h.target } }));
    assert.match(t, /carrier:/, "structured data present");
    assert.match(t, /Faceoff at center ice/, "caption appended by default");
    assert.match(t, /described by test-vlm/i);
    assert.equal(stub.received.length, 1);

    // describe:false → structured only, no vision call.
    const t2 = textOf(await h.client.callTool({ name: "nhl94_state", arguments: { target: h.target, describe: false } }));
    assert.match(t2, /carrier:/);
    assert.doesNotMatch(t2, /Faceoff at center ice/);
    assert.doesNotMatch(t2, /Screenshot described by/);
    assert.equal(stub.received.length, 1, "no additional vision call for describe:false");
  } finally {
    delete process.env.VISION_BASE_URL;
    delete process.env.VISION_MODEL;
    await h.close();
    await stub.close();
  }
});

test("bizhawk_play_input_sequence with describe returns per-observation descriptions, no images", async () => {
  const stub = await startVisionStub("Samus is mid-jump over a gap.");
  const png1 = tempPng();
  const png2 = tempPng();
  process.env.VISION_BASE_URL = stub.baseUrl;
  process.env.VISION_MODEL = "test-vlm";
  const h = await startHarness({
    play_input_sequence: () => ({
      played: 60,
      final_framecount: 160,
      stopped_early: false,
      observations: [
        { frame_offset: 30, path: png1, memory: { x: 5 } },
        { frame_offset: 60, path: png2, memory: { x: 9 } },
      ],
    }),
  });
  try {
    const res = await h.client.callTool({
      name: "bizhawk_play_input_sequence",
      arguments: { target: h.target, screenshot_every: 30,
        describe: true,
        describe_prompt: "What is happening?",
        frames: [{ buttons: { Right: true }, hold: 60 }],
      },
    });
    const t = textOf(res);
    assert.equal(res.content.filter((c) => c.type === "image").length, 0, "no images when describing");
    assert.match(t, /Samus is mid-jump over a gap\./);
    assert.equal(stub.received.length, 2, "one vision call per screenshot observation");

    const call = h.bridge.calls.find((c) => c.method === "play_input_sequence");
    assert.equal(call.params.describe, undefined, "describe is server-side only, not forwarded to the bridge");
  } finally {
    delete process.env.VISION_BASE_URL;
    delete process.env.VISION_MODEL;
    fs.rmSync(png1, { force: true });
    fs.rmSync(png2, { force: true });
    await h.close();
    await stub.close();
  }
});
