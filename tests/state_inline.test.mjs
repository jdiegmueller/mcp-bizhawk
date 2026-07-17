import test from "node:test";
import assert from "node:assert/strict";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";

// Feature: the compact per-call state block grows to the DYNAMIC fields agents
// re-check after acting (lag_count, is_lagged, current_memory_domain) and is
// attached to more state-mutating tools (press_buttons, pause, unpause, reset,
// load_slot) so agents stop firing get_info just to answer "where am I now?".
// rom_hash is dropped from the block (static; still in get_info) — the render
// stays additive, so a bridge that omits any field prints nothing for it.

process.env.MCP_BIZHAWK_STATE_DIR = fs.mkdtempSync(path.join(os.tmpdir(), "mcp-inline-"));
const { startHarness, textOf } = await import("./helpers/harness.mjs");

test("press_buttons renders expanded state: lag with * when currently lagged, plus domain", async () => {
  const h = await startHarness({
    press_buttons: () => ({
      state: { framecount: 100, paused: false, lag_count: 5, is_lagged: true, current_memory_domain: "68K RAM" },
    }),
  });
  try {
    const res = await h.client.callTool({
      name: "bizhawk_press_buttons",
      arguments: { buttons: { Right: true } },
    });
    assert.match(textOf(res), /State: frame 100, running, lag 5\*, domain 68K RAM/);
  } finally {
    await h.close();
  }
});

test("is_lagged false renders lag without the * marker", async () => {
  const h = await startHarness({
    press_buttons: () => ({
      state: { framecount: 7, paused: false, lag_count: 5, is_lagged: false },
    }),
  });
  try {
    const res = await h.client.callTool({
      name: "bizhawk_press_buttons",
      arguments: { buttons: { A: true } },
    });
    const t = textOf(res);
    assert.match(t, /State: frame 7, running, lag 5/);
    assert.doesNotMatch(t, /lag 5\*/);
  } finally {
    await h.close();
  }
});

test("press_buttons with no state block prints no State line (additive)", async () => {
  const h = await startHarness({ press_buttons: () => true });
  try {
    const res = await h.client.callTool({
      name: "bizhawk_press_buttons",
      arguments: { buttons: { B: true } },
    });
    assert.doesNotMatch(textOf(res), /State:/);
  } finally {
    await h.close();
  }
});

test("pause / unpause / reset each append a state summary when the bridge supplies one", async () => {
  const h = await startHarness({
    pause:   () => ({ state: { framecount: 10, paused: true } }),
    unpause: () => ({ state: { framecount: 10, paused: false } }),
    reset:   () => ({ state: { framecount: 0, paused: false } }),
  });
  try {
    let res = await h.client.callTool({ name: "bizhawk_pause", arguments: {} });
    assert.match(textOf(res), /State: frame 10, paused/);
    res = await h.client.callTool({ name: "bizhawk_unpause", arguments: {} });
    assert.match(textOf(res), /State: frame 10, running/);
    res = await h.client.callTool({ name: "bizhawk_reset", arguments: {} });
    assert.match(textOf(res), /State: frame 0, running/);
  } finally {
    await h.close();
  }
});

test("pause with a legacy bridge (returns true) still works, no State line", async () => {
  const h = await startHarness({ pause: () => true });
  try {
    const res = await h.client.callTool({ name: "bizhawk_pause", arguments: {} });
    assert.match(textOf(res), /Emulation paused/);
    assert.doesNotMatch(textOf(res), /State:/);
  } finally {
    await h.close();
  }
});

test("load_slot appends the state summary from its underlying load_state", async () => {
  const h = await startHarness({
    get_info: () => ({ rom_hash: "ABCD1234", rom_name: "Test ROM" }),
    save_state: (p) => { fs.writeFileSync(p.path, "fake"); return { path: p.path }; },
    load_state: (p) => {
      assert.equal(p.pause, true);
      return { path: p.path, paused: true, state: { framecount: 555, paused: true, lag_count: 2, is_lagged: false } };
    },
  });
  try {
    await h.client.callTool({ name: "bizhawk_save_slot", arguments: { name: "sp" } });
    const res = await h.client.callTool({ name: "bizhawk_load_slot", arguments: { name: "sp" } });
    const t = textOf(res);
    assert.match(t, /Loaded slot 'sp' \(paused\)/);
    assert.match(t, /State: frame 555, paused, lag 2/);
  } finally {
    await h.close();
  }
});
