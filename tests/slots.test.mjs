import test from "node:test";
import assert from "node:assert/strict";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";

process.env.MCP_BIZHAWK_STATE_DIR = fs.mkdtempSync(path.join(os.tmpdir(), "mcp-slots-"));
const { startHarness, textOf } = await import("./helpers/harness.mjs");

const HANDLERS = {
  get_info: () => ({ rom_hash: "ABCD1234", rom_name: "Test ROM" }),
  save_state: (p) => {
    fs.writeFileSync(p.path, "fake-state-bytes");
    return { path: p.path };
  },
  load_state: (p) => ({ path: p.path, paused: false }),
};

test("save → list → load slot round-trip", async () => {
  const h = await startHarness(HANDLERS);
  try {
    let res = await h.client.callTool({ name: "bizhawk_save_slot", arguments: { name: "before-boss" } });
    assert.match(textOf(res), /Saved slot 'before-boss'/);
    const expected = path.join(process.env.MCP_BIZHAWK_STATE_DIR, "ABCD1234", "before-boss.State");
    assert.ok(fs.existsSync(expected), `state file missing at ${expected}`);

    res = await h.client.callTool({ name: "bizhawk_list_slots", arguments: {} });
    assert.match(textOf(res), /before-boss/);

    res = await h.client.callTool({ name: "bizhawk_load_slot", arguments: { name: "before-boss" } });
    assert.match(textOf(res), /Loaded slot 'before-boss' \(running\)/);
    const call = h.bridge.calls.find((c) => c.method === "load_state");
    assert.equal(call.params.path, expected);
  } finally {
    await h.close();
  }
});

test("load_slot of a missing name rejects, listing what exists", async () => {
  // Low-level MCP Server: thrown handler exceptions become JSON-RPC errors,
  // so client.callTool() rejects rather than resolving with isError:true.
  const h = await startHarness(HANDLERS);
  try {
    await assert.rejects(
      h.client.callTool({ name: "bizhawk_load_slot", arguments: { name: "nope" } }),
      /no slot 'nope'/,
    );
  } finally {
    await h.close();
  }
});

test("slot names are validated (path traversal rejected)", async () => {
  const h = await startHarness(HANDLERS);
  try {
    await assert.rejects(
      h.client.callTool({ name: "bizhawk_save_slot", arguments: { name: "../evil" } }),
      /slot name must be/,
    );
  } finally {
    await h.close();
  }
});
