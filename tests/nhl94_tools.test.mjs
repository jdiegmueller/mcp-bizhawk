import test from "node:test";
import assert from "node:assert/strict";
import { startHarness, textOf } from "./helpers/harness.mjs";

const DOMAINS = ["M68K BUS", "68K RAM"];
const CARRIER = 0xffb7aa;

test("nhl94_teleport writes provided axes as 16.16 and reports decoded coords", async () => {
  const h = await startHarness({
    list_memory_domains: () => DOMAINS,
    memory_ops: () => ({ applied: 2, frozen_count: 0 }),
    frame_advance: (p) => ({ framecount: 1000 + (p.count ?? 1) }),
  });
  try {
    const res = await h.client.callTool({
      name: "nhl94_teleport",
      arguments: { targets: [{ target: "s3", x: 200, y: -40 }] },
    });
    assert.match(textOf(res), /Teleported s3 → x=200 y=-40/);
    // After the write the tool settles a few frames so the move renders.
    assert.match(textOf(res), /\+5 frames so the move renders/);
    const fa = h.bridge.calls.find((c) => c.method === "frame_advance");
    assert.equal(fa.params.count, 5);
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
    // frame_advance isn't mocked here → nhlSettle degrades silently (no note),
    // but the teleport itself still succeeds.
    assert.doesNotMatch(textOf(res), /frames so the move renders/);
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
  const rec = (i, over = {}) => ({ _index: i, x: 0, y: 0, z: 0, xv: 0, yv: 0, zv: 0, fdir: 0, frame: 0, attr: 0, anim: 0, spanum: 0, spacnt: 0, ...over });
  const h = await startHarness({
    list_memory_domains: () => DOMAINS,
    read_struct_array: (p) =>
      Array.from({ length: p.count }, (_, i) => {
        if (i === 0) return rec(0, { x: 100 << 16 });
        if (i === 3) return rec(3, { x: 200 << 16, y: (-40) << 16, attr: 0x0008, anim: 0x0046, spanum: 8, spacnt: 5, shotpwr: 6, shotacc: 5, passacc: 4, energy: 9 });
        if (i === 14) return rec(14, { x: 8 << 16, y: 8 << 16 });
        return rec(i);
      }),
    read_many: () => ({ carrier: 3, gameclock: 1199, gsp: 0, gmode: 0, vpos: 10, hpos: -5, yleader: 50, session: 0xff, shotplayer: 3, lastplayer: 7, passdir: 2, passspeed: 40 }),
    list_frozen: () => ({
      frozen: [
        { address: 0xffb04a + 0x00, width: "u32_be", value: 100 << 16, domain: "M68K BUS" }, // s0.x
        { address: 0xffb7aa, width: "u16_be", value: 3, domain: "M68K BUS" }, // carrier global
        { address: 0x1234, width: "u8", value: 1, domain: "M68K BUS" }, // off-grid / unmapped
      ],
    }),
  });
  try {
    // describe:false keeps this focused on the structured decode (the vision
    // caption is on by default now).
    const res = await h.client.callTool({ name: "nhl94_state", arguments: { describe: false } });
    const text = textOf(res);
    assert.match(text, /s3: x=200 y=-40/);
    assert.match(text, /pk: x=8 y=8/);
    assert.match(text, /s0: x=100\*/); // s0.x is frozen
    assert.match(text, /carrier: s3/);
    // carrier ratings (OSD parity) come from the carrying slot (s3) struct.
    assert.match(text, /carrier_ratings: shotpwr=6 shotacc=5 passacc=4 energy=9/);
    // play-context globals footer (OSD parity): shot/last as slots, pass vector.
    assert.match(text, /shot: s3   last: s7   pass: dir=2 speed=40/);
    assert.match(text, /clock: 19:59 \(1199s\)/);
    assert.match(text, /period: 1st/);
    assert.match(text, /play: running/);
    assert.match(text, /faceoff: no/); // gmode bit0 clear
    // phase headline: session=0xFF + gmode bit0 clear ⇒ live gameplay.
    assert.match(text, /phase: gameplay \(live play/);
    assert.match(text, /camera: vpos=10 hpos=-5 yleader=50/);
    assert.match(text, /frozen_summary: total=3 mapped=2 unmapped=1/);
    // Animation record sub-line: s3 has attr bit3 (x-flip), spanum 8 (record 2).
    assert.match(text, /anim=0x0046 attr=0x0008\(xflip=1\) spanum=8\(rec 2\) spacnt=5/);
    // Layout line anchors any further hand-read to the correct base/stride.
    assert.match(text, /layout: slot structs @ base=0xFFB04A stride=0x80 domain='M68K BUS'/);
    assert.match(text, /anim\+58 spanum\+5A/);
    // raw:true exposes each target's absolute struct address (s3 @ base+3*0x80).
    const rawRes = await h.client.callTool({ name: "nhl94_state", arguments: { raw: true, describe: false } });
    assert.match(textOf(rawRes), /s3 @0xFFB1CA:/);
  } finally {
    await h.close();
  }
});

test("nhl94_read decodes named + raw fields per target via one read_many", async () => {
  const h = await startHarness({
    list_memory_domains: () => DOMAINS,
    // Echo a deterministic value per requested read: x → 100<<16 (fixed),
    // everything else → the low byte of its address.
    read_many: (p) => Object.fromEntries(p.reads.map((r) => [r.name, r.name.endsWith(".x") ? (100 << 16) : (r.address & 0xff)])),
  });
  try {
    const res = await h.client.callTool({ name: "nhl94_read", arguments: { targets: ["s0", "pk"], fields: ["x", "impact", "pf", "+0x40:s16_be"] } });
    const t = textOf(res);
    // x is 16.16 → decoded to whole pixels (100); others are raw integers.
    assert.match(t, /s0: x=100 impact=\d+ pf=\d+ \+0x40:s16_be=\d+/);
    assert.match(t, /pk: x=100 /);
    const call = h.bridge.calls.find((c) => c.method === "read_many");
    // per-target.field naming, and impact read at the s0 struct base + 0x32.
    assert.ok(call.params.reads.some((r) => r.name === "s0.impact"));
    assert.ok(call.params.reads.some((r) => r.name === "pk.+0x40:s16_be" && r.width === "s16_be"));
  } finally {
    await h.close();
  }
});

test("nhl94_read rejects unknown fields", async () => {
  const h = await startHarness({ list_memory_domains: () => DOMAINS, read_many: () => ({}) });
  try {
    await assert.rejects(
      h.client.callTool({ name: "nhl94_read", arguments: { targets: ["s0"], fields: ["bogus"] } }),
      /unknown field/,
    );
  } finally {
    await h.close();
  }
});

test("nhl94_state verbose:true appends the extended per-entity line", async () => {
  const rec = (i, over = {}) => ({
    _index: i, x: 0, y: 0, z: 0, xv: 0, yv: 0, zv: 0, fdir: 0, frame: 0, attr: 0, anim: 0, spanum: 0, spacnt: 0,
    impact: 42, impactp: 7, pos: 3, nopuck: 1, pf: 0x12, pf2: 0x34, pf3: 0x56, wgt8: 200, ...over,
  });
  const h = await startHarness({
    list_memory_domains: () => DOMAINS,
    read_struct_array: (p) => {
      // verbose must have requested the extended fields too.
      assert.ok(p.fields.some((f) => f.name === "impact"));
      return Array.from({ length: p.count }, (_, i) => rec(i));
    },
    read_many: () => ({ carrier: 0xff02, gameclock: 300, gsp: 0, gmode: 0, vpos: 0, hpos: 0, yleader: 0, session: 0xff, shotplayer: -1, lastplayer: -1, passdir: 0, passspeed: 0 }),
    list_frozen: () => ({ frozen: [] }),
  });
  try {
    const t = textOf(await h.client.callTool({ name: "nhl94_state", arguments: { verbose: true, describe: false } }));
    assert.match(t, /impact=42 impactp=7 pos=3 nopuck=1 pf=0x12 pf2=0x34 pf3=0x56 wgt8=200/);
  } finally {
    await h.close();
  }
});

test("nhl94_state reports play: stopped / faceoff: yes when gmode bit 0 is set", async () => {
  const rec = (i) => ({ _index: i, x: 0, y: 0, z: 0, xv: 0, yv: 0, zv: 0, fdir: 0, frame: 0, attr: 0, anim: 0, spanum: 0, spacnt: 0 });
  const h = await startHarness({
    list_memory_domains: () => DOMAINS,
    read_struct_array: (p) => Array.from({ length: p.count }, (_, i) => rec(i)),
    // gmode 1 = clock-stopped / faceoff-whistle mode; gmode must be read as a
    // byte, so bit 0 here is the C2EA flag bit.
    read_many: () => ({ carrier: 0xff02, gameclock: 300, gsp: 0, gmode: 1, vpos: 0, hpos: 0, yleader: 0, session: 0xff, shotplayer: -1, lastplayer: -1, passdir: 0, passspeed: 0 }),
    list_frozen: () => ({ frozen: [] }),
  });
  try {
    const text = textOf(await h.client.callTool({ name: "nhl94_state", arguments: { describe: false } }));
    assert.match(text, /play: stopped/);
    assert.match(text, /faceoff: yes/);
    // phase headline: session=0xFF + gmode bit0 set ⇒ on-ice faceoff/stoppage.
    assert.match(text, /phase: faceoff\/stoppage \(on ice/);
    // gmode is requested as a byte read, not u16_be (the endianness fix).
    const call = h.bridge.calls.find((c) => c.method === "read_many");
    const gmodeRead = call.params.reads.find((r) => r.name === "gmode");
    assert.equal(gmodeRead.width, "u8");
  } finally {
    await h.close();
  }
});
