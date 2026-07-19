import test from "node:test";
import assert from "node:assert/strict";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { startHarness, textOf } from "./helpers/harness.mjs";

// Feature 3: bizhawk_run_trials — a savestate-anchored sweep. Each trial loads
// the same state_slot, plays its own input sequence, and observes shared
// memory. One bridge round-trip replaces the get_info + load_state +
// play_input_sequence loop repeated per trial.

test("bizhawk_run_trials forwards the sweep spec and tabulates per-trial results", async () => {
  const stateDir = fs.mkdtempSync(path.join(os.tmpdir(), "mcp-trials-slot-linux-"));
  fs.mkdirSync(path.join(stateDir, "ABCD1234"), { recursive: true });
  fs.writeFileSync(path.join(stateDir, "ABCD1234", "faceoff.State"), "fake-state");
  const h = await startHarness({
    get_info: () => ({ rom_hash: "ABCD1234", rom_name: "Test ROM" }),
    run_trials: () => ({
      trials: [
        { name: "shotA", played: 19, final_framecount: 1019, memory: { px: 100, py: 50 } },
        { name: "shotB", played: 15, final_framecount: 1015, memory: { px: 80, py: 60 } },
      ],
    }),
  }, { backend: { stateDir } });
  try {
    const res = await h.client.callTool({
      name: "bizhawk_run_trials",
      arguments: { target: h.target, state_slot: "faceoff",
        observe_memory: [
          { name: "px", address: 0x10, width: "s32_be" },
          { name: "py", address: 0x20, width: "s32_be" },
        ],
        trials: [
          { name: "shotA", frames: [{ buttons: { A: true }, hold: 1 }, { buttons: {}, hold: 18 }] },
          { name: "shotB", frames: [{ buttons: { B: true }, hold: 1 }, { buttons: {}, hold: 14 }] },
        ],
      },
    });
    const t = textOf(res);
    assert.match(t, /Ran 2 trials from slot 'faceoff'/);
    assert.match(t, /shotA.*px=100, py=50/);
    assert.match(t, /shotB.*px=80, py=60/);

    const call = h.bridge.calls.find((c) => c.method === "run_trials");
    assert.equal(call.params.state_path, path.join(stateDir, "ABCD1234", "faceoff.State"));
    assert.equal(call.params.trials.length, 2);
    assert.equal(call.params.observe_memory.length, 2);
    assert.equal(call.params.trials[1].name, "shotB");
  } finally {
    await h.close();
    fs.rmSync(stateDir, { recursive: true, force: true });
  }
});

test("bizhawk_run_trials inlines per-trial screenshots when captured", async () => {
  const stateDir = fs.mkdtempSync(path.join(os.tmpdir(), "mcp-trials-shot-state-"));
  fs.mkdirSync(path.join(stateDir, "ABCD1234"), { recursive: true });
  fs.writeFileSync(path.join(stateDir, "ABCD1234", "faceoff.State"), "fake-state");
  const png = path.join(os.tmpdir(), "mcp-run-trials-shot.png");
  fs.writeFileSync(png, Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a]));
  const h = await startHarness({
    get_info: () => ({ rom_hash: "ABCD1234", rom_name: "Test ROM" }),
    run_trials: () => ({
      trials: [
        { name: "t0", played: 10, final_framecount: 1010, memory: { hp: 3 }, screenshot_path: png },
      ],
    }),
  }, { backend: { stateDir } });
  try {
    const res = await h.client.callTool({
      name: "bizhawk_run_trials",
      arguments: { target: h.target, state_slot: "faceoff",
        screenshot: true,
        trials: [{ name: "t0", frames: [{ buttons: {}, hold: 10 }] }],
      },
    });
    const images = res.content.filter((c) => c.type === "image");
    assert.equal(images.length, 1);
    assert.equal(images[0].mimeType, "image/png");

    const call = h.bridge.calls.find((c) => c.method === "run_trials");
    assert.equal(call.params.screenshot, true);
  } finally {
    fs.rmSync(png, { force: true });
    await h.close();
    fs.rmSync(stateDir, { recursive: true, force: true });
  }
});

test("bizhawk_run_trials resolves state_slot by backend path config", async () => {
  const stateDir = fs.mkdtempSync(path.join(os.tmpdir(), "mcp-trials-slot-host-"));
  fs.mkdirSync(path.join(stateDir, "ABCD1234"), { recursive: true });
  fs.writeFileSync(path.join(stateDir, "ABCD1234", "faceoff.State"), "fake-state");

  const h = await startHarness({
    get_info: () => ({ rom_hash: "ABCD1234", rom_name: "Test ROM" }),
    run_trials: () => ({
      trials: [
        { name: "shotA", played: 19, final_framecount: 1019, memory: { px: 100 } },
      ],
    }),
  }, {
    backend: {
      os: "windows",
      stateDir,
      stateDirBridge: "X:\\.mcp-bizhawk\\states",
    },
  });
  try {
    const res = await h.client.callTool({
      name: "bizhawk_run_trials",
      arguments: {
        target: h.target,
        state_slot: "faceoff",
        observe_memory: [{ name: "px", address: 0x10, width: "s32_be" }],
        trials: [{ name: "shotA", frames: [{ buttons: { A: true }, hold: 19 }] }],
      },
    });
    assert.match(textOf(res), /Ran 1 trial from slot 'faceoff'/);

    const call = h.bridge.calls.find((c) => c.method === "run_trials");
    assert.equal(call.params.state_path, "X:\\.mcp-bizhawk\\states\\ABCD1234\\faceoff.State");
  } finally {
    await h.close();
    fs.rmSync(stateDir, { recursive: true, force: true });
  }
});
