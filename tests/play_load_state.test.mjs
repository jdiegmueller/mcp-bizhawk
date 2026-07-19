import test from "node:test";
import assert from "node:assert/strict";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { startHarness } from "./helpers/harness.mjs";

// Feature 2: play_input_sequence takes an optional load_slot so the
// load+play trial loop collapses from two bridge round-trips to one.

test("bizhawk_play_input_sequence forwards load_slot as a resolved bridge path", async () => {
  const stateDir = fs.mkdtempSync(path.join(os.tmpdir(), "mcp-play-slot-linux-"));
  fs.mkdirSync(path.join(stateDir, "ABCD1234"), { recursive: true });
  fs.writeFileSync(path.join(stateDir, "ABCD1234", "home.State"), "fake-state");
  const h = await startHarness({
    get_info: () => ({ rom_hash: "ABCD1234", rom_name: "Test ROM" }),
    play_input_sequence: () => ({ played: 5, final_framecount: 105, stopped_early: false }),
  }, {
    backend: { os: "linux", stateDir },
  });
  try {
    await h.client.callTool({
      name: "bizhawk_play_input_sequence",
      arguments: { target: h.target, load_slot: "home",
        frames: [{ buttons: { A: true }, hold: 1 }, { buttons: {}, hold: 4 }],
      },
    });
    const call = h.bridge.calls.find((c) => c.method === "play_input_sequence");
    assert.equal(call.params.load_state_path, path.join(stateDir, "ABCD1234", "home.State"));
  } finally {
    await h.close();
    fs.rmSync(stateDir, { recursive: true, force: true });
  }
});

test("bizhawk_play_input_sequence omits load_state_path when not provided", async () => {
  const h = await startHarness({
    play_input_sequence: () => ({ played: 5, final_framecount: 105, stopped_early: false }),
  });
  try {
    await h.client.callTool({
      name: "bizhawk_play_input_sequence",
      arguments: { target: h.target, frames: [{ buttons: {}, hold: 5 }] },
    });
    const call = h.bridge.calls.find((c) => c.method === "play_input_sequence");
    assert.equal(call.params.load_state_path, undefined);
  } finally {
    await h.close();
  }
});

test("bizhawk_play_input_sequence resolves load_slot by backend path config", async () => {
  const stateDir = fs.mkdtempSync(path.join(os.tmpdir(), "mcp-play-slot-host-"));
  fs.mkdirSync(path.join(stateDir, "ABCD1234"), { recursive: true });
  fs.writeFileSync(path.join(stateDir, "ABCD1234", "home.State"), "fake-state");

  const h = await startHarness({
    get_info: () => ({ rom_hash: "ABCD1234", rom_name: "Test ROM" }),
    play_input_sequence: () => ({ played: 5, final_framecount: 105, stopped_early: false }),
  }, {
    backend: {
      os: "windows",
      stateDir,
      stateDirBridge: "X:\\.mcp-bizhawk\\states",
    },
  });
  try {
    await h.client.callTool({
      name: "bizhawk_play_input_sequence",
      arguments: {
        target: h.target,
        load_slot: "home",
        frames: [{ buttons: { A: true }, hold: 5 }],
      },
    });
    const call = h.bridge.calls.find((c) => c.method === "play_input_sequence");
    assert.equal(call.params.load_state_path, "X:\\.mcp-bizhawk\\states\\ABCD1234\\home.State");
  } finally {
    await h.close();
    fs.rmSync(stateDir, { recursive: true, force: true });
  }
});
