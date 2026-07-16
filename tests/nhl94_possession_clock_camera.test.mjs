import test from "node:test";
import assert from "node:assert/strict";
import { startHarness, textOf } from "./helpers/harness.mjs";

const DOMAINS = ["M68K BUS", "68K RAM"];
const CARRIER = 0xffb7aa;
const CLOCK = 0xffc468;
const VPOS = 0xffbd18;
const HPOS = 0xffbd1c;
const PK_X = 0xffb74a + 0x00;
const PK_Y = 0xffb74a + 0x14;

test("nhl94_possession gives the puck to a skater by teleporting it onto them", async () => {
  const h = await startHarness({
    list_memory_domains: () => DOMAINS,
    read_many: () => ({ x: 104 << 16, y: (-12) << 16 }),
    memory_ops: () => ({ frozen_count: 0 }),
    frame_advance: (p) => ({ framecount: 1000 + (p.count ?? 1) }),
  });
  try {
    const res = await h.client.callTool({ name: "nhl94_possession", arguments: { target: "s2" } });
    assert.match(textOf(res), /Puck given to s2 \(teleported to x=104,y=-12\); carrier hold: off/);
    // Settles a few frames so the puck's new position renders.
    assert.match(textOf(res), /\+5 frames so the move renders/);
    assert.equal(h.bridge.calls.find((c) => c.method === "frame_advance").params.count, 5);
    const call = h.bridge.calls.find((c) => c.method === "memory_ops");
    assert.equal(call.params.ops[0].op, "unfreeze"); // releases prior hold first
    assert.equal(call.params.ops[0].address, CARRIER);
    const px = call.params.ops.find((o) => o.address === PK_X);
    const py = call.params.ops.find((o) => o.address === PK_Y);
    assert.equal(px.value, (104 << 16) >>> 0);
    assert.equal(py.value, ((-12) << 16) >>> 0);
    assert.ok(!call.params.ops.some((o) => o.op === "freeze")); // no hold
  } finally {
    await h.close();
  }
});

test("nhl94_possession hold:true freezes the carrier word at the slot", async () => {
  const h = await startHarness({
    list_memory_domains: () => DOMAINS,
    read_many: () => ({ x: 0, y: 0 }),
    memory_ops: () => ({ frozen_count: 1 }),
  });
  try {
    const res = await h.client.callTool({ name: "nhl94_possession", arguments: { target: "s5", hold: true } });
    assert.match(textOf(res), /carrier hold: on/);
    const call = h.bridge.calls.find((c) => c.method === "memory_ops");
    const fr = call.params.ops.find((o) => o.op === "freeze" && o.address === CARRIER);
    assert.equal(fr.value, 5);
  } finally {
    await h.close();
  }
});

test("nhl94_possession none sets the puck loose", async () => {
  const h = await startHarness({ list_memory_domains: () => DOMAINS, memory_ops: () => ({ frozen_count: 0 }) });
  try {
    const res = await h.client.callTool({ name: "nhl94_possession", arguments: { target: "none" } });
    assert.match(textOf(res), /Puck set loose/);
    const call = h.bridge.calls.find((c) => c.method === "memory_ops");
    const w = call.params.ops.find((o) => o.op === "write" && o.address === CARRIER);
    assert.equal(w.value, 0xffff);
  } finally {
    await h.close();
  }
});

test("nhl94_possession rejects a non-skater target", async () => {
  const h = await startHarness({ list_memory_domains: () => DOMAINS, memory_ops: () => ({ frozen_count: 0 }) });
  try {
    await assert.rejects(
      h.client.callTool({ name: "nhl94_possession", arguments: { target: "pk" } }),
      /s0.*s11.*none|none/,
    );
  } finally {
    await h.close();
  }
});

test("nhl94_clock set + freeze writes and pins the clock in one call", async () => {
  const h = await startHarness({ list_memory_domains: () => DOMAINS, memory_ops: () => ({ frozen_count: 1 }) });
  try {
    const res = await h.client.callTool({ name: "nhl94_clock", arguments: { set: "19:59", freeze: true } });
    assert.match(textOf(res), /Clock frozen to 19:59/);
    const call = h.bridge.calls.find((c) => c.method === "memory_ops");
    assert.equal(call.params.ops[0].op, "freeze");
    assert.equal(call.params.ops[0].address, CLOCK);
    assert.equal(call.params.ops[0].value, 1199);
  } finally {
    await h.close();
  }
});

test("nhl94_clock freeze without set reads the current value", async () => {
  const h = await startHarness({
    list_memory_domains: () => DOMAINS,
    read16: () => 600,
    memory_ops: () => ({ frozen_count: 1 }),
  });
  try {
    const res = await h.client.callTool({ name: "nhl94_clock", arguments: { freeze: true } });
    assert.match(textOf(res), /Clock frozen to 10:00/);
    const call = h.bridge.calls.find((c) => c.method === "memory_ops");
    assert.equal(call.params.ops[0].value, 600);
  } finally {
    await h.close();
  }
});

test("nhl94_clock rejects freeze+release together", async () => {
  const h = await startHarness({ list_memory_domains: () => DOMAINS, memory_ops: () => ({ frozen_count: 0 }) });
  try {
    await assert.rejects(
      h.client.callTool({ name: "nhl94_clock", arguments: { freeze: true, release: true } }),
      /mutually exclusive/,
    );
  } finally {
    await h.close();
  }
});

test("nhl94_camera pin freezes the requested scroll axes", async () => {
  const h = await startHarness({ list_memory_domains: () => DOMAINS, memory_ops: () => ({ frozen_count: 2 }) });
  try {
    const res = await h.client.callTool({ name: "nhl94_camera", arguments: { pin: { v: 120, h: -30 } } });
    assert.match(textOf(res), /Camera pinned @ v=120 h=-30/);
    const call = h.bridge.calls.find((c) => c.method === "memory_ops");
    const fv = call.params.ops.find((o) => o.address === VPOS);
    const fh = call.params.ops.find((o) => o.address === HPOS);
    assert.equal(fv.value, 120);
    assert.equal(fh.value, 0xffff - 30 + 1); // -30 as unsigned word
    assert.ok(call.params.ops.every((o) => o.op === "freeze"));
  } finally {
    await h.close();
  }
});

test("nhl94_camera release unfreezes both scroll words", async () => {
  const h = await startHarness({ list_memory_domains: () => DOMAINS, memory_ops: () => ({ frozen_count: 0 }) });
  try {
    const res = await h.client.callTool({ name: "nhl94_camera", arguments: { release: true } });
    assert.match(textOf(res), /Camera released/);
    const call = h.bridge.calls.find((c) => c.method === "memory_ops");
    assert.equal(call.params.ops.length, 2);
    assert.ok(call.params.ops.every((o) => o.op === "unfreeze"));
  } finally {
    await h.close();
  }
});

test("nhl94_camera rejects both pin and release", async () => {
  const h = await startHarness({ list_memory_domains: () => DOMAINS, memory_ops: () => ({ frozen_count: 0 }) });
  try {
    await assert.rejects(
      h.client.callTool({ name: "nhl94_camera", arguments: { pin: { v: 0 }, release: true } }),
      /exactly one/,
    );
  } finally {
    await h.close();
  }
});
