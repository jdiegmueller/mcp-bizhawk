import test from "node:test";
import assert from "node:assert/strict";
import { startHarness, textOf } from "./helpers/harness.mjs";

const DOMAINS = ["M68K BUS", "68K RAM"];
const CARRIER = 0xffb7aa;

function minimalNhlRec(i, over = {}) {
  return {
    _index: i, x: 0, y: 0, z: 0, xv: 0, yv: 0, zv: 0, fdir: 0, frame: 0,
    attr: 0, anim: 0, spanum: 0, spacnt: 0, shotpwr: 0, shotacc: 0,
    passacc: 0, energy: 0, ...over,
  };
}

function defaultNhlGlobals(over = {}) {
  return {
    carrier: 0xff02,
    gameclock: 300,
    gsp: 0,
    gmode: 0,
    vpos: 0,
    hpos: 0,
    yleader: 0,
    session: 0xff,
    shotplayer: -1,
    lastplayer: -1,
    passdir: 0,
    passspeed: 0,
    faceoff_window_latch: 0,
    home_line: 0,
    away_line: 2,
    active_control_home: 0xffff,
    active_control_away: 0xffff,
    control_gate_team0: 0,
    control_gate_team1: 0,
    secondary_control_0: 1,
    secondary_control_1: 0,
    c1playernum: 0,
    c2playernum: 0,
    switch_debounce_home: 0,
    switch_debounce_away: 0,
    pad_word_0: 0,
    pad_word_1: 0,
    pad_word_2: 0,
    pad_word_3: 0,
    raw_pad_byte_0: 0,
    raw_pad_byte_1: 0,
    raw_pad_byte_2: 0,
    raw_pad_byte_3: 0,
    ...over,
  };
}

test("nhl94_teleport writes provided axes as 16.16 and does not settle by default", async () => {
  const h = await startHarness({
    list_memory_domains: () => DOMAINS,
    memory_ops: () => ({ applied: 2, frozen_count: 0 }),
    frame_advance: (p) => ({ framecount: 1000 + (p.count ?? 1) }),
  });
  try {
    const res = await h.client.callTool({
      name: "nhl94_teleport",
      arguments: { target: h.target, targets: [{ target: "s3", x: 200, y: -40 }] },
    });
    assert.match(textOf(res), /Teleported s3 → x=200 y=-40/);
    assert.doesNotMatch(textOf(res), /frames so the move renders/);
    assert.ok(!h.bridge.calls.some((c) => c.method === "frame_advance"));
    const call = h.bridge.calls.find((c) => c.method === "memory_ops");
    assert.equal(call.params.domain, "M68K BUS");
    assert.equal(call.params.ops.length, 2);
    assert.deepEqual(call.params.ops[0], { op: "write", address: 0xffb04a + 3 * 0x80, value: 0x00c80000, width: "u32_be" });
    assert.equal(call.params.ops[1].value, 0xffd80000); // -40 << 16
  } finally {
    await h.close();
  }
});

test("nhl94_teleport settles only when settle_frames is requested", async () => {
  const h = await startHarness({
    list_memory_domains: () => DOMAINS,
    memory_ops: () => ({ applied: 1, frozen_count: 0 }),
    frame_advance: (p) => ({ framecount: 1000 + (p.count ?? 1) }),
  });
  try {
    const res = await h.client.callTool({
      name: "nhl94_teleport",
      arguments: { target: h.target, settle_frames: 3, targets: [{ target: "s3", x: 200 }] },
    });
    assert.match(textOf(res), /Teleported s3 → x=200/);
    assert.match(textOf(res), /\+3 frames so the move renders/);
    const fa = h.bridge.calls.find((c) => c.method === "frame_advance");
    assert.equal(fa.params.count, 3);
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
      arguments: { target: h.target, targets: [{ target: "pk", x: 0, y: 0 }] },
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
      arguments: { target: h.target, targets: [{ target: "pk", x: 5 }] },
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
    const res = await h.client.callTool({ name: "nhl94_freeze", arguments: { target: h.target, targets: ["s5"] } });
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
    const res = await h.client.callTool({ name: "nhl94_unfreeze", arguments: { target: h.target, targets: ["s0", "pk"] } });
    assert.match(textOf(res), /Released freezes on s0/);
    assert.match(textOf(res), /Released freezes on pk/);
    const call = h.bridge.calls.find((c) => c.method === "memory_ops");
    assert.equal(call.params.ops.length, 12);
    assert.ok(call.params.ops.every((o) => o.op === "unfreeze"));
  } finally {
    await h.close();
  }
});

test("nhl94_unfreeze all=true clears the entire bridge freeze table", async () => {
  const h = await startHarness({ unfreeze: () => ({ frozen_count: 0 }) });
  try {
    const res = await h.client.callTool({ name: "nhl94_unfreeze", arguments: { target: h.target, all: true } });
    assert.match(textOf(res), /Released all freezes \(targets, globals, stale, and unmapped\)/);
    const call = h.bridge.calls.find((c) => c.method === "unfreeze");
    assert.deepEqual(call.params, { all: true });
    assert.equal(h.bridge.calls.find((c) => c.method === "list_memory_domains"), undefined);
  } finally {
    await h.close();
  }
});

test("nhl94_unfreeze requires exactly one scope", async () => {
  const h = await startHarness({ unfreeze: () => ({ frozen_count: 0 }) });
  try {
    await assert.rejects(
      h.client.callTool({ name: "nhl94_unfreeze", arguments: { target: h.target } }),
      /non-empty targets array or all:true/,
    );
    await assert.rejects(
      h.client.callTool({ name: "nhl94_unfreeze", arguments: { target: h.target, targets: ["s0"], all: true } }),
      /either targets or all:true, not both/,
    );
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
    const res = await h.client.callTool({ name: "nhl94_state", arguments: { target: h.target, sections: "all", describe: false } });
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
    assert.match(text, /interaction_gate: OPEN \(gmode\.bit0=0;/);
    // phase headline: session=0xFF + gmode bit0 clear ⇒ on ice, gate open.
    assert.match(text, /phase: gameplay \(on ice; stoppage gate open/);
    assert.match(text, /camera: vpos=10 hpos=-5 yleader=50/);
    assert.match(text, /frozen_summary: total=3 mapped=2 unmapped=1/);
    // Animation record sub-line: s3 has attr bit3 (x-flip), spanum 8 (record 2).
    assert.match(text, /anim=0x0046 attr=0x0008\(xflip=1\) spanum=8\(rec 2\) spacnt=5/);
    // Layout line anchors any further hand-read to the correct base/stride.
    assert.match(text, /layout: slot structs @ base=0xFFB04A stride=0x80 domain='M68K BUS'/);
    assert.match(text, /anim\+58 spanum\+5A/);
    // raw:true exposes each target's absolute struct address (s3 @ base+3*0x80).
    const rawRes = await h.client.callTool({ name: "nhl94_state", arguments: { target: h.target, raw: true, describe: false } });
    assert.match(textOf(rawRes), /s3 @0xFFB1CA:/);
  } finally {
    await h.close();
  }
});

test("nhl94_state reports 1P-CPU control context, pad words, and route confidence", async () => {
  const h = await startHarness({
    list_memory_domains: () => DOMAINS,
    read_struct_array: (p) => Array.from({ length: p.count }, (_, i) => minimalNhlRec(i)),
    read_many: () => defaultNhlGlobals({
      active_control_home: 4,
      active_control_away: 0xffff,
      c1playernum: 0,
      c2playernum: 0,
      switch_debounce_home: 0,
      switch_debounce_away: 12,
      pad_word_0: 0x0010,
      pad_word_1: 0,
      pad_word_2: 0,
      pad_word_3: 0,
      home_line: 0,
      away_line: 2,
    }),
    list_frozen: () => ({ frozen: [] }),
  });
  try {
    const text = textOf(await h.client.callTool({ name: "nhl94_state", arguments: { target: h.target, sections: ["control"], describe: false } }));
    assert.match(text, /control:/);
    assert.match(text, /home\(team0\): human active=s4 switch_debounce=0\(ready\) line=Sc1 raw_active=0x0004/);
    assert.match(text, /away\(team1\): CPU active=none switch_debounce=12\(gated 12f\) line=Chk raw_active=0xFFFF/);
    assert.match(text, /mode: 1P-CPU inferred from active control slots; coop_unverified=true/);
    assert.match(text, /input_route: player1 likely controls home\/team0 -> s4; player2 inactive\/CPU; route_verified=true/);
    assert.match(text, /pad_words: word0@0xFFBEEE=0x0010\(B\) word1@0xFFBEF0=0x0000 word2@0xFFBEF2=0x0000 word3@0xFFBEF4=0x0000/);
    assert.match(text, /caveat: c1playernum=0x0000 c2playernum=0x0000 are reported raw only; they are not active skater indices and are not used for mode\/input_route inference/);

    const readManyCalls = h.bridge.calls.filter((c) => c.method === "read_many");
    assert.equal(readManyCalls.length, 1, "control fields should ride the existing globals read_many call");
    const reads = readManyCalls[0].params.reads;
    assert.ok(reads.some((r) => r.name === "active_control_home" && r.address === 0xffc320 && r.width === "u16_be"));
    assert.ok(reads.some((r) => r.name === "active_control_away" && r.address === 0xffc322 && r.width === "u16_be"));
    assert.ok(reads.some((r) => r.name === "switch_debounce_home" && r.address === 0xffbf06 && r.width === "u8"));
    assert.ok(reads.some((r) => r.name === "pad_word_0" && r.address === 0xffbeee && r.width === "u16_be"));
    assert.ok(reads.some((r) => r.name === "pad_word_3" && r.address === 0xffbef4 && r.width === "u16_be"));
    assert.ok(reads.some((r) => r.name === "control_gate_team0" && r.address === 0xffd05a && r.width === "u16_be"));
    assert.ok(reads.some((r) => r.name === "secondary_control_0" && r.address === 0xffc328 && r.width === "u16_be"));
    assert.ok(reads.some((r) => r.name === "raw_pad_byte_0" && r.address === 0xffbef6 && r.width === "u8"));
  } finally {
    await h.close();
  }
});

test("nhl94_state treats full nonzero gmode as stopped while bit0 only gates interactions", async () => {
  const h = await startHarness({
    list_memory_domains: () => DOMAINS,
    read_struct_array: (p) => Array.from({ length: p.count }, (_, i) => minimalNhlRec(i)),
    read_many: () => defaultNhlGlobals({ gmode: 0x0100, session: 0xff }),
    list_frozen: () => ({ frozen: [] }),
  });
  try {
    const text = textOf(await h.client.callTool({ name: "nhl94_state", arguments: { target: h.target, raw: true, describe: false } }));
    assert.match(text, /play: stopped/);
    assert.match(text, /interaction_gate: OPEN \(gmode\.bit0=0;/);
    assert.match(text, /gmode=0x0100/);
  } finally {
    await h.close();
  }
});

test("nhl94_state decodes per-slot control bits and assignment role names", async () => {
  const h = await startHarness({
    list_memory_domains: () => DOMAINS,
    read_struct_array: (p) => Array.from({ length: p.count }, (_, i) => minimalNhlRec(i, i === 4
      ? { pf: 0x88, assidx: 7, assq7: 17 }
      : i === 7
        ? { pf: 0x60, assidx: 0, assq0: 3 }
        : {})),
    read_many: () => defaultNhlGlobals({ active_control_home: 4, active_control_away: 0xffff, gmode: 0 }),
    list_frozen: () => ({ frozen: [] }),
  });
  try {
    const text = textOf(await h.client.callTool({ name: "nhl94_state", arguments: { target: h.target, verbose: true, describe: false } }));
    assert.match(text, /s4[\s\S]*role=assnearest\(q7=17\) team=home human_active=true active_player=false attack_dir=top pf=0x88/);
    assert.match(text, /s7[\s\S]*role=asswingd\(q0=3\) team=away human_active=false active_player=true attack_dir=bottom pf=0x60/);

    const structCall = h.bridge.calls.find((c) => c.method === "read_struct_array");
    assert.ok(structCall.params.fields.some((f) => f.name === "assidx" && f.offset === 0x36));
    assert.ok(structCall.params.fields.some((f) => f.name === "assq0" && f.offset === 0x38));
    assert.ok(structCall.params.fields.some((f) => f.name === "assq7" && f.offset === 0x3f));
  } finally {
    await h.close();
  }
});

test("nhl94_state flags control pointer mismatches and unknown role indices", async () => {
  const h = await startHarness({
    list_memory_domains: () => DOMAINS,
    read_struct_array: (p) => Array.from({ length: p.count }, (_, i) => minimalNhlRec(i, i === 4
      ? { pf: 0x80, assidx: 2, assq2: 99 }
      : {})),
    read_many: () => defaultNhlGlobals({ active_control_home: 4, active_control_away: 0xffff }),
    list_frozen: () => ({ frozen: [] }),
  });
  try {
    const text = textOf(await h.client.callTool({ name: "nhl94_state", arguments: { target: h.target, verbose: true, describe: false } }));
    assert.match(text, /s4[\s\S]*role=role_unknown\(99\)\(q2=99\)/);
    assert.match(text, /s4[\s\S]*control_pointer_mismatch=true/);
  } finally {
    await h.close();
  }
});

test("nhl94_state infers control modes and flags unexpected slot-team pairings", async () => {
  const cases = [
    { label: "CPU-CPU", home: 0xffff, away: 0xffff, pattern: /mode: CPU-CPU inferred from active control slots/, route: /input_route: no active input route known; route_verified=false/ },
    { label: "CPU-1P", home: 0xffff, away: 8, pattern: /mode: CPU-1P inferred from active control slots; coop_unverified=true/, route: /input_route: player1 likely controls away\/team1 -> s8; player2 inactive\/CPU; route_verified=false/ },
    { label: "1P-2P", home: 4, away: 8, pattern: /mode: 1P-2P inferred from active control slots/, route: /input_route: player1\/player2 likely map to home\/away human teams; verify with pad words or live input; route_verified=false/ },
    { label: "unknown-word", home: 0x1234, away: 0xffff, pattern: /mode: unknown inferred from active control slots/, route: /input_route: no active input route known; route_verified=false/ },
    { label: "cross-slot", home: 8, away: 0xffff, pattern: /mode: 1P-CPU inferred from active control slots; coop_unverified=true/, route: /input_route: player1 likely controls home\/team0 -> s8; player2 inactive\/CPU; route_verified=true/, extra: /home\(team0\): human active=s8 slot_team_unexpected=true/ },
  ];

  for (const c of cases) {
    const h = await startHarness({
      list_memory_domains: () => DOMAINS,
      read_struct_array: (p) => Array.from({ length: p.count }, (_, i) => minimalNhlRec(i)),
      read_many: () => defaultNhlGlobals({ active_control_home: c.home, active_control_away: c.away }),
      list_frozen: () => ({ frozen: [] }),
    });
    try {
      const text = textOf(await h.client.callTool({ name: "nhl94_state", arguments: { target: h.target, sections: ["control"], describe: false } }));
      assert.match(text, c.pattern, c.label);
      assert.match(text, c.route, c.label);
      if (c.extra) assert.match(text, c.extra, c.label);
    } finally {
      await h.close();
    }
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
    const res = await h.client.callTool({ name: "nhl94_read", arguments: { target: h.target, targets: ["s0", "pk"], fields: ["x", "impact", "pf", "+0x40:s16_be"] } });
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

test("nhl94_read exposes assignment queue aliases by name", async () => {
  const h = await startHarness({
    list_memory_domains: () => DOMAINS,
    read_many: (p) => Object.fromEntries(p.reads.map((r) => [r.name, r.address & 0xff])),
  });
  try {
    const res = await h.client.callTool({
      name: "nhl94_read",
      arguments: { target: h.target, targets: ["s4"], fields: ["assidx", "assq0", "assq7"] },
    });
    assert.match(textOf(res), /s4: assidx=\d+ assq0=\d+ assq7=\d+/);
    const call = h.bridge.calls.find((c) => c.method === "read_many");
    assert.ok(call.params.reads.some((r) => r.name === "s4.assidx" && r.address === 0xffb04a + 4 * 0x80 + 0x36 && r.width === "u16_be"));
    assert.ok(call.params.reads.some((r) => r.name === "s4.assq0" && r.address === 0xffb04a + 4 * 0x80 + 0x38 && r.width === "u8"));
    assert.ok(call.params.reads.some((r) => r.name === "s4.assq7" && r.address === 0xffb04a + 4 * 0x80 + 0x3f && r.width === "u8"));
  } finally {
    await h.close();
  }
});

test("nhl94_read rejects unknown fields", async () => {
  const h = await startHarness({ list_memory_domains: () => DOMAINS, read_many: () => ({}) });
  try {
    await assert.rejects(
      h.client.callTool({ name: "nhl94_read", arguments: { target: h.target, targets: ["s0"], fields: ["bogus"] } }),
      /unknown field/,
    );
  } finally {
    await h.close();
  }
});

test("nhl94_rules decodes game mode, player mode, and penalty/offside options", async () => {
  const h = await startHarness({
    list_memory_domains: () => DOMAINS,
    read_many: (p) => {
      assert.ok(p.reads.some((r) => r.name === "game_mode_flags" && r.address === 0xffc2fa && r.width === "u8"));
      assert.ok(p.reads.some((r) => r.name === "opt_pen" && r.address === 0xffd056 && r.width === "u16_be"));
      assert.ok(p.reads.some((r) => r.name === "gmode" && r.address === 0xffc2ea && r.width === "u16_be"));
      return defaultNhlGlobals({
        game_mode_flags: 0,
        opt_pen: 2,
        gmode: 0x0000,
        active_control_home: 4,
        active_control_away: 0xffff,
        pad_word_0: 0,
        pad_word_2: 0x0010,
      });
    },
  });
  try {
    const text = textOf(await h.client.callTool({ name: "nhl94_rules", arguments: { target: h.target } }));
    assert.match(text, /game_mode: Exhibition/);
    assert.match(text, /players: 2P-CPU/);
    assert.match(text, /penalties: ON \(except OFFSIDE\)/);
    assert.match(text, /offside: OFF/);
    assert.match(text, /raw: game_mode_flags=0x00 opt_pen=0x0002 gmode=0x0000/);
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
    const t = textOf(await h.client.callTool({ name: "nhl94_state", arguments: { target: h.target, verbose: true, describe: false } }));
    assert.match(t, /impact=42 impactp=7 pos=3 nopuck=1 pf=0x12 pf2=0x34 pf3=0x56 wgt8=200/);
  } finally {
    await h.close();
  }
});

test("nhl94_state defaults to compact output and prints dense sections only on request", async () => {
  const h = await startHarness({
    list_memory_domains: () => DOMAINS,
    read_struct_array: (p) => Array.from({ length: p.count }, (_, i) => minimalNhlRec(i, i === 3
      ? { x: 200 << 16, attr: 0x0008, anim: 0x0046, spanum: 8, spacnt: 5, shotpwr: 6, shotacc: 5, passacc: 4, energy: 9 }
      : {})),
    read_many: () => defaultNhlGlobals({ carrier: 3, active_control_home: 4, active_control_away: 0xffff, shotplayer: 3, lastplayer: 7, passdir: 2, passspeed: 40 }),
    list_frozen: () => ({ frozen: [] }),
  });
  try {
    const compact = textOf(await h.client.callTool({ name: "nhl94_state", arguments: { target: h.target, describe: false } }));
    assert.match(compact, /s3: x=200 y=0 z=0 \| xv=0 yv=0 zv=0 \| dir=0/);
    assert.doesNotMatch(compact, /frame=0/);
    assert.match(compact, /phase: gameplay/);
    assert.match(compact, /control_mode: 1P-CPU/);
    assert.doesNotMatch(compact, /anim=0x0046/);
    assert.doesNotMatch(compact, /\ncontrol:\n/);
    assert.doesNotMatch(compact, /carrier_ratings:/);
    assert.doesNotMatch(compact, /camera:/);
    assert.doesNotMatch(compact, /layout:/);

    const dense = textOf(await h.client.callTool({
      name: "nhl94_state",
      arguments: { target: h.target, sections: ["anim", "control", "ratings", "camera", "debug"], describe: false },
    }));
    assert.match(dense, /anim=0x0046 attr=0x0008\(xflip=1\) spanum=8\(rec 2\) spacnt=5/);
    assert.match(dense, /\ncontrol:\n/);
    assert.match(dense, /carrier_ratings: shotpwr=6 shotacc=5 passacc=4 energy=9/);
    assert.match(dense, /camera: vpos=0 hpos=0 yleader=0/);
    assert.match(dense, /layout: slot structs @ base=0xFFB04A/);
  } finally {
    await h.close();
  }
});

test("nhl94_state sections:'all' aliases every optional section", async () => {
  const h = await startHarness({
    list_memory_domains: () => DOMAINS,
    read_struct_array: (p) => {
      assert.ok(p.fields.some((f) => f.name === "impact"), "sections:'all' should request debug fields");
      return Array.from({ length: p.count }, (_, i) => minimalNhlRec(i, {
        attr: 0x0008, anim: 0x0046, spanum: 8, spacnt: 5,
        impact: 42, impactp: 7, pos: 3, nopuck: 1, pf2: 0x34, pf3: 0x56, wgt8: 200,
      }));
    },
    read_many: () => defaultNhlGlobals({ carrier: 0, active_control_home: 4, active_control_away: 0xffff }),
    list_frozen: () => ({ frozen: [] }),
  });
  try {
    const t = textOf(await h.client.callTool({ name: "nhl94_state", arguments: { target: h.target, sections: "all", describe: false } }));
    assert.match(t, /anim=0x0046/);
    assert.match(t, /\ncontrol:\n/);
    assert.match(t, /carrier_ratings:/);
    assert.match(t, /camera:/);
    assert.match(t, /impact=42 impactp=7 pos=3 nopuck=1/);
    assert.match(t, /layout:/);
  } finally {
    await h.close();
  }
});

test("nhl94_state reports play: stopped / faceoff: yes when gmode bit 0 is set", async () => {
  const rec = (i) => ({ _index: i, x: 0, y: 0, z: 0, xv: 0, yv: 0, zv: 0, fdir: 0, frame: 0, attr: 0, anim: 0, spanum: 0, spacnt: 0 });
  const h = await startHarness({
    list_memory_domains: () => DOMAINS,
    read_struct_array: (p) => Array.from({ length: p.count }, (_, i) => rec(i)),
    // gmode 1 = clock-stopped / faceoff-whistle mode. gmode is read as a full
    // word for clock semantics; bit 0 remains the interaction gate.
    read_many: () => ({ carrier: 0xff02, gameclock: 300, gsp: 0, gmode: 1, vpos: 0, hpos: 0, yleader: 0, session: 0xff, shotplayer: -1, lastplayer: -1, passdir: 0, passspeed: 0 }),
    list_frozen: () => ({ frozen: [] }),
  });
  try {
    const text = textOf(await h.client.callTool({ name: "nhl94_state", arguments: { target: h.target, describe: false } }));
    assert.match(text, /play: stopped/);
    assert.match(text, /faceoff: yes/);
    // phase headline: session=0xFF + gmode bit0 set ⇒ on-ice faceoff/stoppage.
    assert.match(text, /phase: faceoff\/stoppage \(on ice/);
    assert.match(text, /interaction_gate: CLOSED \(gmode\.bit0=1;/);
    // gmode is requested as the full word because high-byte presentation states
    // also stop the clock.
    const call = h.bridge.calls.find((c) => c.method === "read_many");
    const gmodeRead = call.params.reads.find((r) => r.name === "gmode");
    assert.equal(gmodeRead.width, "u16_be");
  } finally {
    await h.close();
  }
});

test("nhl94_state reports RAM-backed faceoff line-change window", async () => {
  const rec = (i) => ({
    _index: i, x: 0, y: 0, z: 0, xv: 0, yv: 0, zv: 0, fdir: 0, frame: 0,
    attr: 0, anim: 0, spanum: 0, spacnt: 0,
  });
  const h = await startHarness({
    list_memory_domains: () => DOMAINS,
    read_struct_array: (p) => Array.from({ length: p.count }, (_, i) => rec(i)),
    read_many: (p) => {
      assert.ok(p.reads.some((r) => r.name === "faceoff_window_latch" && r.address === 0xffc304 && r.width === "u16_be"));
      assert.ok(p.reads.some((r) => r.name === "home_line" && r.address === 0xffc6e5 && r.width === "u8"));
      assert.ok(p.reads.some((r) => r.name === "away_line" && r.address === 0xffca48 && r.width === "u8"));
      assert.ok(!p.reads.some((r) => r.address === 0xffc2ee), "line-change detector must not read the rejected C2EE flag");
      return {
        carrier: 0xff02,
        gameclock: 300,
        gsp: 0,
        gmode: 1,
        vpos: 0,
        hpos: 0,
        yleader: 0,
        session: 0xff,
        shotplayer: -1,
        lastplayer: -1,
        passdir: 0,
        passspeed: 0,
        faceoff_window_latch: 0x2710,
        home_line: 2,
        away_line: 0,
      };
    },
    list_frozen: () => ({ frozen: [] }),
  });
  try {
    const text = textOf(await h.client.callTool({ name: "nhl94_state", arguments: { target: h.target, describe: false } }));
    assert.match(text, /phase: faceoff_line_change/);
    assert.match(text, /phase_label: faceoff \/ line-change \(pre-drop\)/);
    assert.match(text, /faceoff_window: active=true latch=0x2710\(10000\) home=Chk\(2\) away=Sc1\(0\)/);
    assert.match(text, /evidence: latch_nonzero=true interaction_gate_closed=true puck_loose=true/);
    assert.doesNotMatch(text, /c2ea_bit8/);
  } finally {
    await h.close();
  }
});
