import test from "node:test";
import assert from "node:assert/strict";
import http from "node:http";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { startHarness, textOf } from "./helpers/harness.mjs";

// A tiny stub of the OpenAI-compatible /chat/completions endpoint a local
// vision model (llama.cpp / llama-swap) would serve. Captures the request so
// tests can assert we sent the image + prompt correctly.
async function startVisionStub(content) {
  const received = [];
  const server = http.createServer((req, res) => {
    let body = "";
    req.on("data", (c) => (body += c));
    req.on("end", () => {
      received.push({ url: req.url, body: JSON.parse(body) });
      res.writeHead(200, { "Content-Type": "application/json" });
      res.end(JSON.stringify({ choices: [{ message: { content } }] }));
    });
  });
  await new Promise((r) => server.listen(0, "127.0.0.1", r));
  const port = server.address().port;
  return {
    baseUrl: `http://127.0.0.1:${port}/v1`,
    received,
    close: () => new Promise((r) => server.close(r)),
  };
}

function tempPng() {
  const p = path.join(os.tmpdir(), `mcp-vision-test-${process.pid}-${Math.random().toString(36).slice(2)}.png`);
  fs.writeFileSync(p, Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a]));
  return p;
}

test("bizhawk_screenshot with describe returns the vision model's text, not an image", async () => {
  const stub = await startVisionStub("A hockey rink; the puck is near center ice.");
  const png = tempPng();
  process.env.VISION_BASE_URL = stub.baseUrl;
  process.env.VISION_MODEL = "test-vlm";
  const h = await startHarness({ screenshot: (p) => p.path });
  try {
    const res = await h.client.callTool({
      name: "bizhawk_screenshot",
      arguments: { path: png, describe: true, describe_prompt: "Where is the puck?" },
    });
    const t = textOf(res);
    assert.match(t, /A hockey rink; the puck is near center ice\./);
    assert.equal(res.content.filter((c) => c.type === "image").length, 0, "no binary image returned");

    // We actually called the vision endpoint with the prompt + a PNG data URL.
    assert.equal(stub.received.length, 1);
    const msg = stub.received[0].body.messages[0];
    assert.equal(msg.content[0].text, "Where is the puck?");
    assert.match(msg.content[1].image_url.url, /^data:image\/png;base64,/);
  } finally {
    delete process.env.VISION_BASE_URL;
    delete process.env.VISION_MODEL;
    fs.rmSync(png, { force: true });
    await h.close();
    await stub.close();
  }
});

test("bizhawk_screenshot describe errors clearly when vision is not configured", async () => {
  delete process.env.VISION_BASE_URL;
  delete process.env.VISION_MODEL;
  const png = tempPng();
  const h = await startHarness({ screenshot: (p) => p.path });
  try {
    await assert.rejects(
      h.client.callTool({ name: "bizhawk_screenshot", arguments: { path: png, describe: true } }),
      /VISION_BASE_URL/,
    );
  } finally {
    fs.rmSync(png, { force: true });
    await h.close();
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
      arguments: {
        screenshot_every: 30,
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
