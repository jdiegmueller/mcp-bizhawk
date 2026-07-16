import test from "node:test";
import assert from "node:assert/strict";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { startHarness, textOf } from "./helpers/harness.mjs";

const DOMAINS = ["M68K BUS", "68K RAM"];

test("nhl94_park parks every skater not in keep and freezes 5 ops each", async () => {
  const h = await startHarness({
    list_memory_domains: () => DOMAINS,
    memory_ops: () => ({ frozen_count: 55 }),
  });
  try {
    const res = await h.client.callTool({ name: "nhl94_park", arguments: { keep: ["s2"] } });
    const text = textOf(res);
    assert.match(text, /Parked 11 skater\(s\) at y=-300/);
    assert.match(text, /kept s2/);
    assert.match(text, /s0 x=-160/);
    const call = h.bridge.calls.find((c) => c.method === "memory_ops");
    assert.equal(call.params.ops.length, 55);
    assert.ok(!call.params.ops.some((o) => o.address === 0xffb04a + 2 * 0x80)); // s2 untouched
  } finally {
    await h.close();
  }
});

test("nhl94_park errors when every skater is kept", async () => {
  const h = await startHarness({ list_memory_domains: () => DOMAINS, memory_ops: () => ({ frozen_count: 0 }) });
  try {
    const all = Array.from({ length: 12 }, (_, i) => `s${i}`);
    await assert.rejects(
      h.client.callTool({ name: "nhl94_park", arguments: { keep: all } }),
      /nothing to park/,
    );
  } finally {
    await h.close();
  }
});

test("nhl94_rig save → list → apply → delete round-trips through the store", async () => {
  const rigDir = fs.mkdtempSync(path.join(os.tmpdir(), "mcp-rig-"));
  process.env.MCP_BIZHAWK_RIG_DIR = rigDir;
  const applied = [];
  const h = await startHarness({
    get_info: () => ({ rom_hash: "ABC123" }),
    list_memory_domains: () => DOMAINS,
    save_state: (p) => ({ path: p.path }),
    load_state: (p) => ({ path: p.path, paused: true }),
    unfreeze: () => ({ frozen_count: 0 }),
    list_frozen: () => ({ frozen: [{ address: 0xffb04a, width: "s32_be", value: 100, domain: "M68K BUS" }] }),
    memory_ops: (p) => { applied.push(p); return { frozen_count: p.ops.length }; },
  });
  try {
    const save = await h.client.callTool({ name: "nhl94_rig", arguments: { action: "save", name: "faceoff" } });
    assert.match(textOf(save), /Saved rig "faceoff" \(1 freeze\(s\)\)/);
    assert.ok(fs.existsSync(path.join(rigDir, "ABC123", "faceoff.json")));

    const list = await h.client.callTool({ name: "nhl94_rig", arguments: { action: "list" } });
    assert.match(textOf(list), /faceoff — 1 freeze\(s\)/);

    const apply = await h.client.callTool({ name: "nhl94_rig", arguments: { action: "apply", name: "faceoff" } });
    assert.match(textOf(apply), /Applied rig "faceoff".*re-applied 1 freeze/s);
    // apply clears all freezes, loads paused, then re-freezes
    assert.ok(h.bridge.calls.some((c) => c.method === "unfreeze" && c.params.all === true));
    assert.ok(h.bridge.calls.some((c) => c.method === "load_state" && c.params.pause === true));
    assert.equal(applied.at(-1).ops[0].op, "freeze");
    assert.equal(applied.at(-1).ops[0].address, 0xffb04a);

    const del = await h.client.callTool({ name: "nhl94_rig", arguments: { action: "delete", name: "faceoff" } });
    assert.match(textOf(del), /Deleted rig "faceoff"/);
    assert.ok(!fs.existsSync(path.join(rigDir, "ABC123", "faceoff.json")));
  } finally {
    await h.close();
    delete process.env.MCP_BIZHAWK_RIG_DIR;
    fs.rmSync(rigDir, { recursive: true, force: true });
  }
});

test("nhl94_rig apply on a missing name errors with available rigs", async () => {
  const rigDir = fs.mkdtempSync(path.join(os.tmpdir(), "mcp-rig-"));
  process.env.MCP_BIZHAWK_RIG_DIR = rigDir;
  const h = await startHarness({
    get_info: () => ({ rom_hash: "ABC123" }),
    list_memory_domains: () => DOMAINS,
  });
  try {
    await assert.rejects(
      h.client.callTool({ name: "nhl94_rig", arguments: { action: "apply", name: "nope" } }),
      /no rig "nope"/,
    );
  } finally {
    await h.close();
    delete process.env.MCP_BIZHAWK_RIG_DIR;
    fs.rmSync(rigDir, { recursive: true, force: true });
  }
});
