import test from "node:test";
import assert from "node:assert/strict";
import {
  SORTCORDS,
  SCSIZE,
  OFF,
  resolveTarget,
  toFixed,
  fromFixed,
  toWord,
  mapFrozenAddress,
  parseClock,
  formatClock,
  parkOps,
  PARK_Y,
  resolveField,
  READ_DEFAULT_FIELDS,
  classifyPhase,
  SESSION_BYTE,
  RECIPES_GUIDE,
  lineLabel,
  G,
} from "../dist/nhl94.js";

test("RECIPES_GUIDE encodes the safe experiment lifecycle and current tool semantics", () => {
  assert.match(RECIPES_GUIDE, /read once .* do not repeat before every call/);
  assert.match(RECIPES_GUIDE, /nhl94_unfreeze \{"all":true\}/);
  assert.match(RECIPES_GUIDE, /Velocity xv\/yv\/zv uses RAW signed 16-bit/);
  assert.match(RECIPES_GUIDE, /nhl94_fields — semantic field read\/write\/freeze\/unfreeze/);
  assert.match(RECIPES_GUIDE, /nhl94_stage — batch clean\/rig\/park\/place\/possession\/field setup/);
  assert.match(RECIPES_GUIDE, /assign the carrier directly/);
  assert.match(RECIPES_GUIDE, /Clock freeze .* does NOT close the collision stoppage gate/s);
  assert.match(RECIPES_GUIDE, /OPEN only proves this ONE prerequisite is clear/);
  assert.match(RECIPES_GUIDE, /ZERO HITS is\s+inconclusive/);
  assert.match(RECIPES_GUIDE, /clear bridge freezes only; they\s+do NOT stop bizhawk_trap_exec hooks/);
  assert.match(RECIPES_GUIDE, /read\/status do NOT stop hooks/);
  assert.match(RECIPES_GUIDE, /loads the state PAUSED/);
  assert.doesNotMatch(RECIPES_GUIDE, /proximity pickup/);
  assert.doesNotMatch(RECIPES_GUIDE, /\["s0",…,"pk"\]/);
});

test("classifyPhase maps session byte + gmode bit0 to the coarse phase buckets", () => {
  // session 0xFF = on ice; gmode bit0 splits live vs faceoff/stoppage.
  assert.match(classifyPhase(0xff, false), /^gameplay \(on ice; stoppage gate open/);
  assert.match(classifyPhase(0xff, true), /^faceoff\/stoppage \(on ice/);
  // session 0x00 = no game loaded (title/menus); 0xFE = off-ice break.
  assert.match(classifyPhase(0x00, false), /^pre-game .*no game loaded/);
  assert.match(classifyPhase(0xfe, false), /^off-ice break/);
  // gmode bit0 is irrelevant off the ice (still a "waiting for START" screen).
  assert.match(classifyPhase(0x00, true), /^pre-game/);
  assert.match(classifyPhase(0xfe, true), /^off-ice break/);
  // Anything unexpected degrades gracefully, echoing the raw byte.
  assert.match(classifyPhase(0x42, false), /^unknown \(session=0x42\)/);
  assert.equal(SESSION_BYTE, 0xffc735);
});

test("lineLabel maps selected-line bytes and preserves unknowns via caller raw fields", () => {
  assert.equal(lineLabel(0), "Sc1");
  assert.equal(lineLabel(1), "Sc2");
  assert.equal(lineLabel(2), "Chk");
  assert.equal(lineLabel(3), "unknown");
  assert.equal(lineLabel(255), "unknown");
});

test("global table exposes faceoff-window and selected-line addresses", () => {
  assert.equal(G.faceoff_window_latch, 0xffc304);
  assert.equal(G.home_line, 0xffc6e5);
  assert.equal(G.away_line, 0xffca48);
});

test("resolveField maps known names to offset/width and flags fixed-point axes", () => {
  assert.deepEqual(resolveField("impact"), { field: "impact", offset: 0x32, width: "s16_be", fixed: false });
  assert.deepEqual(resolveField("pf"), { field: "pf", offset: 0x62, width: "u8", fixed: false });
  assert.deepEqual(resolveField("x"), { field: "x", offset: 0x00, width: "s32_be", fixed: true });
});

test("resolveField parses raw offsets with optional width (default u8)", () => {
  assert.deepEqual(resolveField("+0x32"), { field: "+0x32", offset: 0x32, width: "u8", fixed: false });
  assert.deepEqual(resolveField("0x32:s16_be"), { field: "0x32:s16_be", offset: 0x32, width: "s16_be", fixed: false });
  assert.deepEqual(resolveField("50"), { field: "50", offset: 50, width: "u8", fixed: false });
});

test("resolveField rejects unknown names and out-of-struct offsets", () => {
  assert.throws(() => resolveField("nope"), /unknown field/);
  assert.throws(() => resolveField("+0x80"), /out of struct range/); // SCSIZE = 0x80
  assert.ok(READ_DEFAULT_FIELDS.includes("impact"));
});

// Decode the x whole-pixel each parked skater's frozen x-op was set to, in
// slot order, from a parkOps result.
function parkXs(keep) {
  return parkOps(keep).assignments.map((a) => a.x);
}

test("parkOps spreads parked skaters evenly across -32000..+32000 by count", () => {
  // Keep all but one → N=1 → lone skater dead center.
  const one = parkOps(Array.from({ length: 11 }, (_, i) => `s${i}`)); // keep s0..s10, park s11
  assert.deepEqual(one.assignments.map((a) => a.x), [0]);

  // N=2 → the two endpoints.
  assert.deepEqual(parkXs(Array.from({ length: 10 }, (_, i) => `s${i}`)), [-32000, 32000]);

  // N=3 → endpoints + center (spacing 32000).
  assert.deepEqual(parkXs(Array.from({ length: 9 }, (_, i) => `s${i}`)), [-32000, 0, 32000]);

  // N=4 → spacing 64000/3 ≈ 21333, endpoints exact.
  assert.deepEqual(parkXs(Array.from({ length: 8 }, (_, i) => `s${i}`)), [-32000, -10667, 10667, 32000]);
});

test("parkOps freezes x/y (y=PARK_Y) + zeroes xv/yv/zv, 5 ops per parked skater", () => {
  const { ops, assignments } = parkOps(["s2"]); // park 11
  assert.equal(assignments.length, 11);
  assert.equal(ops.length, 55);
  assert.ok(ops.every((o) => o.op === "freeze"));
  // Every parked skater's y is frozen at PARK_Y (16.16).
  const yOps = ops.filter((o) => (o.address - SORTCORDS) % SCSIZE === OFF.y);
  assert.equal(yOps.length, 11);
  assert.ok(yOps.every((o) => o.value === toFixed(PARK_Y)));
  // s2 is untouched.
  assert.ok(!ops.some((o) => o.address === SORTCORDS + 2 * SCSIZE + OFF.x));
});

test("parkOps throws when every skater is kept", () => {
  assert.throws(
    () => parkOps(Array.from({ length: 12 }, (_, i) => `s${i}`)),
    /nothing to park/,
  );
});

test("resolveTarget maps s0..s11 onto the slot grid", () => {
  assert.deepEqual(resolveTarget("s0"), { slot: 0, base: SORTCORDS });
  assert.deepEqual(resolveTarget("s3"), { slot: 3, base: SORTCORDS + 3 * SCSIZE });
  assert.deepEqual(resolveTarget("s11"), { slot: 11, base: SORTCORDS + 11 * SCSIZE });
});

test("resolveTarget maps pk onto slot 14", () => {
  assert.deepEqual(resolveTarget("pk"), { slot: 14, base: SORTCORDS + 14 * SCSIZE });
  assert.equal(resolveTarget("pk").base, 0xffb74a);
});

test("resolveTarget rejects unknown targets with a helpful message", () => {
  for (const bad of ["s12", "s-1", "p1", "", "puck", "S0", "12"]) {
    assert.throws(() => resolveTarget(bad), /s0-s11|pk/, `should reject "${bad}"`);
  }
});

test("toFixed shifts whole units into the 16.16 high word (unsigned two's complement)", () => {
  assert.equal(toFixed(200), 0x00c80000);
  assert.equal(toFixed(0), 0);
  assert.equal(toFixed(-5), 0xfffb0000);
  assert.equal(toFixed(-1), 0xffff0000);
});

test("fromFixed decodes a 16.16 longword into signed whole + fraction", () => {
  assert.deepEqual(fromFixed(0x00c80000), { whole: 200, frac: 0 });
  assert.deepEqual(fromFixed(0xfffb0000), { whole: -5, frac: 0 });
  assert.deepEqual(fromFixed(0x00c83456), { whole: 200, frac: 0x3456 });
});

test("toWord encodes a signed 16-bit value as unsigned two's complement", () => {
  assert.equal(toWord(0), 0);
  assert.equal(toWord(-1), 0xffff);
  assert.equal(toWord(-300), 0xfed4);
  assert.equal(toWord(300), 300);
});

test("mapFrozenAddress maps slot-grid field addresses back to {target, field}", () => {
  assert.deepEqual(mapFrozenAddress(SORTCORDS + OFF.x, "M68K BUS"), { target: "s0", field: "x" });
  assert.deepEqual(mapFrozenAddress(SORTCORDS + 3 * SCSIZE + OFF.y, "M68K BUS"), { target: "s3", field: "y" });
  assert.deepEqual(mapFrozenAddress(SORTCORDS + 14 * SCSIZE + OFF.zv, "M68K BUS"), { target: "pk", field: "zv" });
});

test("mapFrozenAddress normalizes 68K RAM (base 0xFF0000) addresses", () => {
  assert.deepEqual(mapFrozenAddress(0xb04a + OFF.z, "68K RAM"), { target: "s0", field: "z" });
});

test("mapFrozenAddress maps the carrier word to a global, not a slot field", () => {
  const r = mapFrozenAddress(0xffb7aa, "M68K BUS");
  assert.equal(r.field, "carrier");
  assert.equal(/^s\d+$|^pk$/.test(r.target), false);
});

test("mapFrozenAddress returns null for addresses off the grid / unknown offsets", () => {
  assert.equal(mapFrozenAddress(0x1234, "M68K BUS"), null);
  // in-grid but not a tracked field offset (e.g. +0x40)
  assert.equal(mapFrozenAddress(SORTCORDS + 0x40, "M68K BUS"), null);
});

test("parseClock accepts MM:SS and raw seconds, rejects out-of-range", () => {
  assert.equal(parseClock("19:59"), 1199);
  assert.equal(parseClock("0:00"), 0);
  assert.equal(parseClock(1199), 1199);
  assert.throws(() => parseClock("19:99"));
  assert.throws(() => parseClock(3600));
  assert.throws(() => parseClock(-1));
});

test("formatClock renders seconds as MM:SS", () => {
  assert.equal(formatClock(1199), "19:59");
  assert.equal(formatClock(0), "0:00");
  assert.equal(formatClock(65), "1:05");
});
