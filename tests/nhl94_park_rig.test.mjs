import test from "node:test";
import assert from "node:assert/strict";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { startHarness, textOf } from "./helpers/harness.mjs";

const DOMAINS = ["M68K BUS", "68K RAM"];

test("nhl94_park parks every skater not in keep and does not settle by default", async () => {
  const h = await startHarness({
    list_memory_domains: () => DOMAINS,
    memory_ops: () => ({ frozen_count: 55 }),
    frame_advance: (p) => ({ framecount: 1000 + (p.count ?? 1) }),
  });
  try {
    const res = await h.client.callTool({ name: "nhl94_park", arguments: { target: h.target, keep: ["s2"] } });
    const text = textOf(res);
    assert.match(text, /Parked 11 skater\(s\) at y=32000/);
    assert.match(text, /kept s2/);
    // 11 parked spread evenly across -32000..+32000: first at the left endpoint.
    assert.match(text, /s0 x=-32000/);
    assert.doesNotMatch(text, /frames so the move renders/);
    assert.ok(!h.bridge.calls.some((c) => c.method === "frame_advance"));
    const call = h.bridge.calls.find((c) => c.method === "memory_ops");
    assert.equal(call.params.ops.length, 55);
    assert.ok(!call.params.ops.some((o) => o.address === 0xffb04a + 2 * 0x80)); // s2 untouched
  } finally {
    await h.close();
  }
});

test("nhl94_park settles only when settle_frames is requested", async () => {
  const h = await startHarness({
    list_memory_domains: () => DOMAINS,
    memory_ops: () => ({ frozen_count: 55 }),
    frame_advance: (p) => ({ framecount: 1000 + (p.count ?? 1) }),
  });
  try {
    const res = await h.client.callTool({ name: "nhl94_park", arguments: { target: h.target, keep: ["s2"], settle_frames: 4 } });
    const text = textOf(res);
    assert.match(text, /\+4 frames so the move renders/);
    assert.equal(h.bridge.calls.find((c) => c.method === "frame_advance").params.count, 4);
  } finally {
    await h.close();
  }
});

test("nhl94_park errors when every skater is kept", async () => {
  const h = await startHarness({ list_memory_domains: () => DOMAINS, memory_ops: () => ({ frozen_count: 0 }) });
  try {
    const all = Array.from({ length: 12 }, (_, i) => `s${i}`);
    await assert.rejects(
      h.client.callTool({ name: "nhl94_park", arguments: { target: h.target, keep: all } }),
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
    const save = await h.client.callTool({ name: "nhl94_rig", arguments: { target: h.target, action: "save", name: "faceoff" } });
    assert.match(textOf(save), /Saved rig "faceoff" \(1 freeze\(s\)\)/);
    assert.ok(fs.existsSync(path.join(rigDir, "ABC123", "faceoff.json")));

    const list = await h.client.callTool({ name: "nhl94_rig", arguments: { target: h.target, action: "list" } });
    assert.match(textOf(list), /faceoff — 1 freeze\(s\)/);

    const apply = await h.client.callTool({ name: "nhl94_rig", arguments: { target: h.target, action: "apply", name: "faceoff" } });
    assert.match(textOf(apply), /Applied rig "faceoff".*re-applied 1 freeze/s);
    // apply clears all freezes, loads paused, then re-freezes
    assert.ok(h.bridge.calls.some((c) => c.method === "unfreeze" && c.params.all === true));
    assert.ok(h.bridge.calls.some((c) => c.method === "load_state" && c.params.pause === true));
    assert.equal(applied.at(-1).ops[0].op, "freeze");
    assert.equal(applied.at(-1).ops[0].address, 0xffb04a);
    assert.equal(applied.at(-1).ops[0].width, "u32_be");

    const del = await h.client.callTool({ name: "nhl94_rig", arguments: { target: h.target, action: "delete", name: "faceoff" } });
    assert.match(textOf(del), /Deleted rig "faceoff"/);
    assert.ok(!fs.existsSync(path.join(rigDir, "ABC123", "faceoff.json")));
  } finally {
    await h.close();
    delete process.env.MCP_BIZHAWK_RIG_DIR;
    fs.rmSync(rigDir, { recursive: true, force: true });
  }
});

test("nhl94_rig save/apply sends bridge-side state path while metadata stays server-side", async () => {
  const rigDir = fs.mkdtempSync(path.join(os.tmpdir(), "mcp-rig-host-"));
  const bridgeDir = "X:\\.mcp-bizhawk\\rigs";
  const calls = [];
  const h = await startHarness({
    get_info: () => ({ rom_hash: "ABC123" }),
    list_memory_domains: () => DOMAINS,
    save_state: (p) => {
      calls.push({ method: "save_state", path: p.path });
      fs.mkdirSync(path.join(rigDir, "ABC123"), { recursive: true });
      fs.writeFileSync(path.join(rigDir, "ABC123", "faceoff.State"), "fake-state-bytes");
      return { path: p.path };
    },
    load_state: (p) => {
      calls.push({ method: "load_state", path: p.path });
      return { path: p.path, paused: true };
    },
    unfreeze: () => ({ frozen_count: 0 }),
    list_frozen: () => ({ frozen: [] }),
    memory_ops: (p) => ({ frozen_count: p.ops.length }),
  }, {
    backend: { rigDir, rigDirBridge: bridgeDir },
  });
  try {
    await h.client.callTool({ name: "nhl94_rig", arguments: { target: h.target, action: "save", name: "faceoff" } });
    const jsonPath = path.join(rigDir, "ABC123", "faceoff.json");
    const statePath = path.join(rigDir, "ABC123", "faceoff.State");
    assert.ok(fs.existsSync(jsonPath), `rig metadata missing at ${jsonPath}`);
    assert.ok(fs.existsSync(statePath), `rig state missing at ${statePath}`);
    assert.equal(calls[0].path, "X:\\.mcp-bizhawk\\rigs\\ABC123\\faceoff.State");

    const rig = JSON.parse(fs.readFileSync(jsonPath, "utf8"));
    assert.equal(rig.savestate_path, statePath);

    const apply = await h.client.callTool({ name: "nhl94_rig", arguments: { target: h.target, action: "apply", name: "faceoff" } });
    assert.equal(calls[1].path, "X:\\.mcp-bizhawk\\rigs\\ABC123\\faceoff.State");
    assert.match(textOf(apply), /Applied rig "faceoff"/);
    assert.doesNotMatch(textOf(apply), /X:\\|\/mnt\/8tb\/jason/);
  } finally {
    await h.close();
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
      h.client.callTool({ name: "nhl94_rig", arguments: { target: h.target, action: "apply", name: "nope" } }),
      /no rig "nope"/,
    );
  } finally {
    await h.close();
    delete process.env.MCP_BIZHAWK_RIG_DIR;
    fs.rmSync(rigDir, { recursive: true, force: true });
  }
});

test("nhl94_stage rejects puck placement with skater possession", async () => {
  const h = await startHarness({ list_memory_domains: () => DOMAINS });
  try {
    await assert.rejects(
      h.client.callTool({
        name: "nhl94_stage",
        arguments: { target: h.target, place: [{ target: "pk", x: 0, y: 0, xv: 25000 }],
          possession: "s0",
        },
      }),
      /pk.*possession/i,
    );
  } finally {
    await h.close();
  }
});

test("nhl94_stage clears freezes before applying a rig", async () => {
  const rigDir = fs.mkdtempSync(path.join(os.tmpdir(), "mcp-stage-rig-"));
  process.env.MCP_BIZHAWK_RIG_DIR = rigDir;
  const h = await startHarness({
    get_info: () => ({ rom_hash: "ABC123" }),
    list_memory_domains: () => DOMAINS,
    save_state: (p) => ({ path: p.path }),
    load_state: (p) => ({ path: p.path, paused: true }),
    unfreeze: () => ({ frozen_count: 0 }),
    list_frozen: () => ({ frozen: [{ address: 0xffb04a, width: "s32_be", value: 100, domain: "M68K BUS" }] }),
    memory_ops: (p) => ({ frozen_count: p.ops.length }),
  });
  try {
    await h.client.callTool({ name: "nhl94_rig", arguments: { target: h.target, action: "save", name: "stagebase" } });
    h.bridge.calls.length = 0;
    const res = await h.client.callTool({
      name: "nhl94_stage",
      arguments: { target: h.target, clear_freezes: true, rig: "stagebase", settle_frames: 0 },
    });
    assert.match(textOf(res), /Applied rig "stagebase"/);
    const methods = h.bridge.calls.map((c) => c.method);
    const unfreezeAt = methods.indexOf("unfreeze");
    const loadAt = methods.indexOf("load_state");
    const refreezeAt = methods.indexOf("memory_ops");
    assert.ok(unfreezeAt !== -1 && loadAt !== -1 && refreezeAt !== -1);
    assert.ok(unfreezeAt < loadAt, "explicit clear_freezes must run before rig load");
    assert.ok(loadAt < refreezeAt, "rig freeze table must be restored after load");
    assert.equal(h.bridge.calls[refreezeAt].params.ops[0].width, "u32_be");
  } finally {
    await h.close();
    delete process.env.MCP_BIZHAWK_RIG_DIR;
    fs.rmSync(rigDir, { recursive: true, force: true });
  }
});

test("nhl94_stage supports fdir-only placement without teleport fields", async () => {
  const h = await startHarness({
    list_memory_domains: () => DOMAINS,
    memory_ops: (p) => {
      assert.deepEqual(p.ops, [
        { op: "write", address: 0xffb04a + 0x54, value: 4, width: "u16_be" },
      ]);
      return { applied: 1, frozen_count: 0 };
    },
  });
  try {
    const res = await h.client.callTool({
      name: "nhl94_stage",
      arguments: { target: h.target, place: [{ target: "s0", fdir: 4 }] },
    });
    assert.match(textOf(res), /Placed 1 target\(s\) \(1 op\(s\)\)/);
  } finally {
    await h.close();
  }
});

test("nhl94_stage place accepts compass strings for fdir", async () => {
  const h = await startHarness({
    list_memory_domains: () => DOMAINS,
    memory_ops: (p) => {
      assert.deepEqual(p.ops, [
        { op: "write", address: 0xffb04a + 0x54, value: 4, width: "u16_be" },
      ]);
      return { applied: 1, frozen_count: 0 };
    },
  });
  try {
    const res = await h.client.callTool({
      name: "nhl94_stage",
      arguments: { target: h.target, place: [{ target: "s0", fdir: "south" }] },
    });
    assert.match(textOf(res), /Placed 1 target\(s\) \(1 op\(s\)\)/);
  } finally {
    await h.close();
  }
});

test("nhl94_stage fields writes signed velocity fields with bridge-compatible widths", async () => {
  const h = await startHarness({
    list_memory_domains: () => DOMAINS,
    memory_ops: (p) => {
      assert.deepEqual(p.ops, [
        { op: "write", address: 0xffb04a + 0x28, value: 65535, width: "u16_be" },
        { op: "write", address: 0xffb04a + 0x2a, value: 12000, width: "u16_be" },
      ]);
      return { applied: 2, frozen_count: 0 };
    },
  });
  try {
    const res = await h.client.callTool({
      name: "nhl94_stage",
      arguments: { target: h.target, fields: [
        { target: "s0", field: "xv", value: -1 },
        { target: "s0", field: "yv", value: 12000 },
      ] },
    });
    assert.match(textOf(res), /Wrote 2 field\(s\)/);
  } finally {
    await h.close();
  }
});
