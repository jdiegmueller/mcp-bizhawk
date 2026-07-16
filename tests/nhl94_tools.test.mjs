import test from "node:test";
import assert from "node:assert/strict";
import { startHarness, textOf } from "./helpers/harness.mjs";

const DOMAINS = ["M68K BUS", "68K RAM"];
const CARRIER = 0xffb7aa;

test("nhl94_teleport writes provided axes as 16.16 and reports decoded coords", async () => {
  const h = await startHarness({
    list_memory_domains: () => DOMAINS,
    memory_ops: () => ({ applied: 2, frozen_count: 0 }),
  });
  try {
    const res = await h.client.callTool({
      name: "nhl94_teleport",
      arguments: { targets: [{ target: "s3", x: 200, y: -40 }] },
    });
    assert.match(textOf(res), /Teleported s3 → x=200 y=-40/);
    const call = h.bridge.calls.find((c) => c.method === "memory_ops");
    assert.equal(call.params.domain, "M68K BUS");
    assert.equal(call.params.ops.length, 2);
    assert.deepEqual(call.params.ops[0], { op: "write", address: 0xffb04a + 3 * 0x80, value: 0x00c80000, width: "u32_be" });
    assert.equal(call.params.ops[1].value, 0xffd80000); // -40 << 16
  } finally {
    await h.close();
  }
});

test("nhl94_teleport pk auto-detaches when a skater carries the puck", async () => {
  const h = await startHarness({
    list_memory_domains: () => DOMAINS,
    read16: (p) => (p.address === CARRIER ? 3 : 0),
    memory_ops: () => ({ applied: 2, frozen_count: 0 }),
  });
  try {
    const res = await h.client.callTool({
      name: "nhl94_teleport",
      arguments: { targets: [{ target: "pk", x: 0, y: 0 }] },
    });
    assert.match(textOf(res), /detached from s3/);
    const call = h.bridge.calls.find((c) => c.method === "memory_ops");
    assert.deepEqual(call.params.ops[0], { op: "write", address: CARRIER, value: 0xffff, width: "u16_be" });
    assert.equal(call.params.ops.length, 3);
  } finally {
    await h.close();
  }
});

test("nhl94_teleport pk stays loose when nobody carries the puck", async () => {
  const h = await startHarness({
    list_memory_domains: () => DOMAINS,
    read16: () => 0xff02, // loose-puck sentinel
    memory_ops: () => ({ applied: 1, frozen_count: 0 }),
  });
  try {
    const res = await h.client.callTool({
      name: "nhl94_teleport",
      arguments: { targets: [{ target: "pk", x: 5 }] },
    });
    assert.match(textOf(res), /loose puck/);
    const call = h.bridge.calls.find((c) => c.method === "memory_ops");
    assert.equal(call.params.ops.length, 1);
    assert.equal(call.params.ops[0].address, 0xffb74a); // pk base + x
  } finally {
    await h.close();
  }
});

test("nhl94_freeze captures current positions and freezes 6 ops per target", async () => {
  const h = await startHarness({
    list_memory_domains: () => DOMAINS,
    read_many: (p) => {
      const out = {};
      for (const r of p.reads) {
        out[r.name] = { "s5.x": 0x00d20000, "s5.y": 0x000f0000, "s5.z": 0 }[r.name] ?? 0;
      }
      return out;
    },
    memory_ops: () => ({ frozen_count: 6 }),
  });
  try {
    const res = await h.client.callTool({ name: "nhl94_freeze", arguments: { targets: ["s5"] } });
    assert.match(textOf(res), /Froze s5 in place @ \(x=210,y=15,z=0\); zeroed xv\/yv\/zv/);
    const call = h.bridge.calls.find((c) => c.method === "memory_ops");
    assert.equal(call.params.ops.length, 6);
    assert.equal(call.params.ops[0].op, "freeze");
    assert.equal(call.params.ops[0].value, 0x00d20000);
    assert.equal(call.params.ops[3].value, 0); // xv zeroed
  } finally {
    await h.close();
  }
});

test("nhl94_unfreeze releases the 6 addresses per target", async () => {
  const h = await startHarness({
    list_memory_domains: () => DOMAINS,
    memory_ops: () => ({ frozen_count: 0 }),
  });
  try {
    const res = await h.client.callTool({ name: "nhl94_unfreeze", arguments: { targets: ["s0", "pk"] } });
    assert.match(textOf(res), /Released freezes on s0/);
    assert.match(textOf(res), /Released freezes on pk/);
    const call = h.bridge.calls.find((c) => c.method === "memory_ops");
    assert.equal(call.params.ops.length, 12);
    assert.ok(call.params.ops.every((o) => o.op === "unfreeze"));
  } finally {
    await h.close();
  }
});

test("nhl94_state decodes the slot grid, globals, and frozen annotations", async () => {
  const rec = (i, over = {}) => ({ _index: i, x: 0, y: 0, z: 0, xv: 0, yv: 0, zv: 0, fdir: 0, frame: 0, ...over });
  const h = await startHarness({
    list_memory_domains: () => DOMAINS,
    read_struct_array: (p) =>
      Array.from({ length: p.count }, (_, i) => {
        if (i === 0) return rec(0, { x: 100 << 16 });
        if (i === 3) return rec(3, { x: 200 << 16, y: (-40) << 16 });
        if (i === 14) return rec(14, { x: 8 << 16, y: 8 << 16 });
        return rec(i);
      }),
    read_many: () => ({ carrier: 3, gameclock: 1199, gsp: 0, gmode: 0, vpos: 10, hpos: -5, yleader: 50 }),
    list_frozen: () => ({
      frozen: [
        { address: 0xffb04a + 0x00, width: "u32_be", value: 100 << 16, domain: "M68K BUS" }, // s0.x
        { address: 0xffb7aa, width: "u16_be", value: 3, domain: "M68K BUS" }, // carrier global
        { address: 0x1234, width: "u8", value: 1, domain: "M68K BUS" }, // off-grid / unmapped
      ],
    }),
  });
  try {
    const res = await h.client.callTool({ name: "nhl94_state", arguments: {} });
    const text = textOf(res);
    assert.match(text, /s3: x=200 y=-40/);
    assert.match(text, /pk: x=8 y=8/);
    assert.match(text, /s0: x=100\*/); // s0.x is frozen
    assert.match(text, /carrier: s3/);
    assert.match(text, /clock: 19:59 \(1199s\)/);
    assert.match(text, /period: 1st/);
    assert.match(text, /play: running/);
    assert.match(text, /camera: vpos=10 hpos=-5 yleader=50/);
    assert.match(text, /frozen_summary: total=3 mapped=2 unmapped=1/);
  } finally {
    await h.close();
  }
});
