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
} from "../dist/nhl94.js";

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
