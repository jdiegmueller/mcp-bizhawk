import test from "node:test";
import assert from "node:assert/strict";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { startHarness, textOf } from "./helpers/harness.mjs";

test("bizhawk_save_state saves a named state through backend path config", async () => {
  const stateDir = fs.mkdtempSync(path.join(os.tmpdir(), "mcp-state-name-host-"));
  const calls = [];
  const h = await startHarness({
    get_info: () => ({ rom_hash: "ABCD1234", rom_name: "Test ROM" }),
    save_state: (p) => {
      calls.push(p);
      fs.mkdirSync(path.join(stateDir, "ABCD1234"), { recursive: true });
      fs.writeFileSync(path.join(stateDir, "ABCD1234", "baseline.State"), "fake-state");
      return { path: p.path };
    },
  }, {
    backend: {
      os: "windows",
      stateDir,
      stateDirBridge: "X:\\.mcp-bizhawk\\states",
    },
  });
  try {
    const res = await h.client.callTool({
      name: "bizhawk_save_state",
      arguments: { target: h.target, name: "baseline" },
    });
    assert.match(textOf(res), /Saved state 'baseline'/);
    assert.equal(calls[0].path, "X:\\.mcp-bizhawk\\states\\ABCD1234\\baseline.State");
    assert.ok(fs.existsSync(path.join(stateDir, "ABCD1234", "baseline.State")));
  } finally {
    await h.close();
    fs.rmSync(stateDir, { recursive: true, force: true });
  }
});

test("bizhawk_load_state loads a named state through backend path config", async () => {
  const stateDir = fs.mkdtempSync(path.join(os.tmpdir(), "mcp-state-load-host-"));
  fs.mkdirSync(path.join(stateDir, "ABCD1234"), { recursive: true });
  fs.writeFileSync(path.join(stateDir, "ABCD1234", "baseline.State"), "fake-state");

  const calls = [];
  const h = await startHarness({
    get_info: () => ({ rom_hash: "ABCD1234", rom_name: "Test ROM" }),
    load_state: (p) => {
      calls.push(p);
      return { path: p.path, paused: p.pause === true };
    },
  }, {
    backend: {
      os: "windows",
      stateDir,
      stateDirBridge: "X:\\.mcp-bizhawk\\states",
    },
  });
  try {
    const res = await h.client.callTool({
      name: "bizhawk_load_state",
      arguments: { target: h.target, name: "baseline" },
    });
    assert.match(textOf(res), /Loaded state 'baseline' \(paused\)/);
    assert.equal(calls[0].path, "X:\\.mcp-bizhawk\\states\\ABCD1234\\baseline.State");
    assert.equal(calls[0].pause, true);
  } finally {
    await h.close();
    fs.rmSync(stateDir, { recursive: true, force: true });
  }
});
