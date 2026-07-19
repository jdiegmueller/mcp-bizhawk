import test from "node:test";
import assert from "node:assert/strict";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { startHarness, textOf } from "./helpers/harness.mjs";

// Feature 1: load_state / frame_advance / play_input_sequence append a
// one-line emulator state summary when the bridge supplies a `state` block,
// so agents stop calling get_info before/after acting. The summary must be
// ADDITIVE — a bridge that omits `state` (older builds, existing fakes) sees
// no change.

test("bizhawk_load_state appends a state summary when the bridge supplies one", async () => {
  const stateDir = fs.mkdtempSync(path.join(os.tmpdir(), "mcp-summary-state-"));
  fs.mkdirSync(path.join(stateDir, "DEADBEEF"), { recursive: true });
  fs.writeFileSync(path.join(stateDir, "DEADBEEF", "x.State"), "fake-state");
  const h = await startHarness({
    get_info: () => ({ rom_hash: "DEADBEEF", rom_name: "Test ROM" }),
    load_state: (p) => {
      assert.equal(p.pause, true);
      return {
        path: p.path,
        paused: true,
        state: { framecount: 999, paused: true, rom_hash: "DEADBEEF" },
      };
    },
  }, { backend: { stateDir } });
  try {
    const res = await h.client.callTool({
      name: "bizhawk_load_state",
      arguments: { target: h.target, name: "x" },
    });
    const t = textOf(res);
    assert.match(t, /Loaded state 'x' \(paused\)/);
    assert.match(t, /State: frame 999, paused, rom DEADBEEF/);
  } finally {
    await h.close();
    fs.rmSync(stateDir, { recursive: true, force: true });
  }
});

test("bizhawk_load_state honors explicit pause:false", async () => {
  const stateDir = fs.mkdtempSync(path.join(os.tmpdir(), "mcp-summary-running-"));
  fs.mkdirSync(path.join(stateDir, "ABCD1234"), { recursive: true });
  fs.writeFileSync(path.join(stateDir, "ABCD1234", "x.State"), "fake-state");
  const h = await startHarness({
    get_info: () => ({ rom_hash: "ABCD1234", rom_name: "Test ROM" }),
    load_state: (p) => {
      assert.equal(p.pause, false);
      return {
        path: p.path,
        paused: false,
        state: { framecount: 1000, paused: false },
      };
    },
  }, { backend: { stateDir } });
  try {
    const res = await h.client.callTool({
      name: "bizhawk_load_state",
      arguments: { target: h.target, name: "x", pause: false },
    });
    const t = textOf(res);
    assert.match(t, /Loaded state 'x' \(running\)/);
    assert.match(t, /State: frame 1000, running/);
  } finally {
    await h.close();
    fs.rmSync(stateDir, { recursive: true, force: true });
  }
});

test("bizhawk_frame_advance appends a state summary when the bridge supplies one", async () => {
  const h = await startHarness({
    frame_advance: () => ({ framecount: 1234, state: { framecount: 1234, paused: false, rom_hash: "AB" } }),
  });
  try {
    const res = await h.client.callTool({
      name: "bizhawk_frame_advance",
      arguments: { target: h.target, count: 3 },
    });
    const t = textOf(res);
    assert.match(t, /Advanced 3 frame\(s\)\. Framecount: 1234/);
    assert.match(t, /State: frame 1234, running, rom AB/);
  } finally {
    await h.close();
  }
});

test("bizhawk_frame_advance still works against a legacy bare-number bridge", async () => {
  const h = await startHarness({ frame_advance: () => 42 });
  try {
    const res = await h.client.callTool({
      name: "bizhawk_frame_advance",
      arguments: { target: h.target, count: 1 },
    });
    const t = textOf(res);
    assert.match(t, /Advanced 1 frame\(s\)\. Framecount: 42/);
    assert.doesNotMatch(t, /State:/);
  } finally {
    await h.close();
  }
});

test("bizhawk_play_input_sequence appends a state summary when the bridge supplies one", async () => {
  const h = await startHarness({
    play_input_sequence: () => ({
      played: 10,
      final_framecount: 1500,
      stopped_early: false,
      state: { framecount: 1500, paused: false, rom_hash: "AB" },
    }),
  });
  try {
    const res = await h.client.callTool({
      name: "bizhawk_play_input_sequence",
      arguments: { target: h.target, frames: [{ buttons: { Right: true }, hold: 10 }] },
    });
    const t = textOf(res);
    assert.match(t, /State: frame 1500, running, rom AB/);
  } finally {
    await h.close();
  }
});
