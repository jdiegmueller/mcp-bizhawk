import test from "node:test";
import assert from "node:assert/strict";
import {
  SORTCORDS,
  SCSIZE,
  OFF,
  G,
  teleportOps,
  freezeOps,
  unfreezeOps,
  parkOps,
} from "../dist/nhl94.js";

const base = (slot) => SORTCORDS + slot * SCSIZE;

test("teleportOps writes each provided axis as a 16.16 u32_be, skipping absent axes", () => {
  const ops = teleportOps([{ target: "s3", x: 200, y: -40 }], false);
  assert.equal(ops.length, 2);
  assert.deepEqual(ops[0], { op: "write", address: base(3) + OFF.x, value: 0x00c80000, width: "u32_be" });
  assert.deepEqual(ops[1], { op: "write", address: base(3) + OFF.y, value: 0xffd80000, width: "u32_be" });
});

test("teleportOps spans multiple targets in one batch", () => {
  const ops = teleportOps([{ target: "s0", x: 1 }, { target: "s1", z: 2 }], false);
  assert.equal(ops.length, 2);
  assert.equal(ops[0].address, base(0) + OFF.x);
  assert.equal(ops[1].address, base(1) + OFF.z);
});

test("teleportOps prepends a carrier-detach write when detachPuck is set", () => {
  const ops = teleportOps([{ target: "pk", x: 0, y: 0 }], true);
  assert.deepEqual(ops[0], { op: "write", address: G.carrier, value: 0xffff, width: "u16_be" });
  assert.equal(ops.length, 3);
});

test("teleportOps does NOT prepend detach when detachPuck is false", () => {
  const ops = teleportOps([{ target: "pk", x: 0 }], false);
  assert.equal(ops[0].address, base(14) + OFF.x);
  assert.equal(ops.length, 1);
});

test("teleportOps rejects an entry with no axis and out-of-range coords", () => {
  assert.throws(() => teleportOps([{ target: "s0" }], false), /axis|x, y, z/);
  assert.throws(() => teleportOps([{ target: "s0", x: 40000 }], false), /range|-32768/);
  assert.throws(() => teleportOps([{ target: "s0", y: -40000 }], false), /range|-32768/);
});

test("freezeOps emits 6 ops per target: x/y/z at current value, xv/yv/zv at 0", () => {
  const ops = freezeOps(["s5"], { s5: { x: 0x00d20000, y: 0x000f0000, z: -327680 } });
  assert.equal(ops.length, 6);
  assert.deepEqual(ops[0], { op: "freeze", address: base(5) + OFF.x, value: 0x00d20000, width: "u32_be" });
  assert.deepEqual(ops[1], { op: "freeze", address: base(5) + OFF.y, value: 0x000f0000, width: "u32_be" });
  // negative raw is stored as unsigned two's complement
  assert.deepEqual(ops[2], { op: "freeze", address: base(5) + OFF.z, value: 0xfffb0000, width: "u32_be" });
  assert.deepEqual(ops[3], { op: "freeze", address: base(5) + OFF.xv, value: 0, width: "u16_be" });
  assert.deepEqual(ops[4], { op: "freeze", address: base(5) + OFF.yv, value: 0, width: "u16_be" });
  assert.deepEqual(ops[5], { op: "freeze", address: base(5) + OFF.zv, value: 0, width: "u16_be" });
});

test("unfreezeOps emits the 6 matching addresses per target", () => {
  const ops = unfreezeOps(["s0"]);
  assert.equal(ops.length, 6);
  assert.ok(ops.every((o) => o.op === "unfreeze"));
  const addrs = ops.map((o) => o.address).sort((a, b) => a - b);
  const want = [OFF.x, OFF.y, OFF.z, OFF.xv, OFF.yv, OFF.zv].map((o) => base(0) + o).sort((a, b) => a - b);
  assert.deepEqual(addrs, want);
});

test("parkOps parks every skater not in keep, spreading x and freezing 5 ops each", () => {
  const { ops, assignments } = parkOps(["s2"], -300, -160, 32);
  // 11 skaters parked * 5 ops
  assert.equal(assignments.length, 11);
  assert.equal(ops.length, 55);
  assert.ok(!assignments.some((a) => a.target === "s2"));
  // first parked skater is s0 at x_start
  assert.deepEqual(assignments[0], { target: "s0", x: -160 });
  const s0x = ops.find((o) => o.address === base(0) + OFF.x);
  assert.deepEqual(s0x, { op: "freeze", address: base(0) + OFF.x, value: 0xff600000, width: "u32_be" });
  const s0y = ops.find((o) => o.address === base(0) + OFF.y);
  assert.equal(s0y.value, 0xfed40000); // -300 << 16
  // park never freezes z
  assert.ok(!ops.some((o) => o.address === base(0) + OFF.z));
});

test("parkOps rejects when every skater is kept", () => {
  const all = Array.from({ length: 12 }, (_, i) => `s${i}`);
  assert.throws(() => parkOps(all, -300, -160, 32), /nothing to park/);
});
