// NHL94 game-semantic layout + codecs.
//
// SOURCE OF TRUTH: lua/bridge_JD.lua (TRACE_FIELDS / TRACE_G / camera consts).
// This module deliberately duplicates those constants on the server side so the
// nhl94_* tools can translate game nouns (skaters s0-s11, puck pk) into 68K
// addresses/widths/endianness without a bridge round-trip. Keep the two in sync.

export const SORTCORDS = 0xffb04a; // slot 0 base
export const SCSIZE = 0x80; // per-slot struct stride
export const PUCK_SLOT = 14; // puck lives at slot 14
export const PUCK_BASE = SORTCORDS + PUCK_SLOT * SCSIZE; // 0xFFB74A

// In-struct field offsets (mirror bridge_JD.lua TRACE_FIELDS). x/y/z are 16.16
// fixed-point longwords; velocities are signed 16-bit words.
export const OFF: Record<string, number> = {
  x: 0x00,
  y: 0x14,
  z: 0x18,
  xv: 0x28,
  yv: 0x2a,
  zv: 0x2c,
  fdir: 0x54,
  frame: 0x06,
};

// Absolute (M68K BUS) addresses of game globals (mirror bridge_JD.lua TRACE_G
// + camera consts). Keyed by the semantic field name used in freeze mapping.
export const G: Record<string, number> = {
  carrier: 0xffb7aa,
  gameclock: 0xffc468,
  gsp: 0xffc466,
  gmode: 0xffc2ea,
  vpos: 0xffbd18,
  hpos: 0xffbd1c,
  yleader: 0xffbf92,
};

const RAM_BASE = 0xff0000; // "68K RAM" domain is offset from the full bus by this

/** Parse a target name ("s0".."s11" | "pk") into its slot index + base address. */
export function resolveTarget(name: string): { slot: number; base: number } {
  if (name === "pk") return { slot: PUCK_SLOT, base: PUCK_BASE };
  const m = /^s(\d{1,2})$/.exec(name);
  if (m) {
    const slot = Number(m[1]);
    if (slot >= 0 && slot <= 11) return { slot, base: SORTCORDS + slot * SCSIZE };
  }
  throw new Error(`unknown target "${name}" (use s0-s11 or pk)`);
}

/** Whole pixel units -> unsigned 16.16 longword (fraction zeroed), two's complement. */
export function toFixed(whole: number): number {
  return (whole * 0x10000) >>> 0;
}

/** Unsigned 16.16 longword -> signed whole part + unsigned fraction. */
export function fromFixed(raw: number): { whole: number; frac: number } {
  return { whole: raw >> 16, frac: raw & 0xffff };
}

/** Signed 16-bit value -> unsigned two's-complement word. */
export function toWord(v: number): number {
  return v & 0xffff;
}

// Reverse lookups built once from OFF / G.
const FIELD_BY_OFFSET = new Map<number, string>(Object.entries(OFF).map(([k, v]) => [v, k]));
const GLOBAL_BY_ADDR = new Map<number, string>(Object.entries(G).map(([k, v]) => [v, k]));

/**
 * Inverse of target resolution: map a frozen address (as reported by
 * list_frozen, with its domain) back onto a slot-grid field or a game global.
 * Returns null for anything off the grid / at an untracked offset ("unmapped").
 */
export function mapFrozenAddress(
  address: number,
  domain?: string,
): { target: string; field: string } | null {
  const abs = domain === "68K RAM" ? address + RAM_BASE : address;
  // Globals win over the slot grid — the carrier word (0xFFB7AA) physically
  // sits inside the puck slot at offset 0x60 but is a global, not a slot field.
  const g = GLOBAL_BY_ADDR.get(abs);
  if (g) return { target: "global", field: g };

  const rel = abs - SORTCORDS;
  if (rel < 0) return null;
  const slot = Math.floor(rel / SCSIZE);
  const off = rel % SCSIZE;
  const field = FIELD_BY_OFFSET.get(off);
  if (!field) return null;
  if (slot >= 0 && slot <= 11) return { target: `s${slot}`, field };
  if (slot === PUCK_SLOT) return { target: "pk", field };
  return null;
}

/** "MM:SS" or raw seconds -> seconds (0..3599). Throws on malformed / out-of-range. */
export function parseClock(v: string | number): number {
  let seconds: number;
  if (typeof v === "number") {
    seconds = v;
  } else {
    const m = /^(\d{1,2}):(\d{2})$/.exec(v);
    if (!m) throw new Error(`clock must be "MM:SS" or seconds (got "${v}")`);
    const mm = Number(m[1]);
    const ss = Number(m[2]);
    if (ss > 59) throw new Error(`clock seconds must be 00-59 (got "${v}")`);
    seconds = mm * 60 + ss;
  }
  if (!Number.isInteger(seconds) || seconds < 0 || seconds > 3599) {
    throw new Error(`clock out of range 0:00-59:59 (got ${JSON.stringify(v)})`);
  }
  return seconds;
}

/** Seconds -> "M:SS" (matches the OSD's M:SS clock). */
export function formatClock(seconds: number): string {
  const mm = Math.floor(seconds / 60);
  const ss = seconds % 60;
  return `${mm}:${String(ss).padStart(2, "0")}`;
}

// ── memory_ops batch builders ───────────────────────────────────────────────
// Pure translators from game-semantic intent to the {op,address,value,width}
// entries bizhawk_memory_ops expects. Domain is applied once at the top level
// of the memory_ops call by the caller. All values are unsigned (memory_ops
// requires value >= 0), so signed inputs are pre-encoded here.

export interface MemOp {
  op: "write" | "freeze" | "unfreeze";
  address: number;
  value?: number;
  width: string;
}

const S16_MIN = -32768;
const S16_MAX = 32767;

function checkCoord(axis: string, v: number): void {
  if (!Number.isInteger(v) || v < S16_MIN || v > S16_MAX) {
    throw new Error(`${axis} out of range ${S16_MIN}..${S16_MAX} (got ${v})`);
  }
}

export interface TeleportEntry {
  target: string;
  x?: number;
  y?: number;
  z?: number;
}

/** One u32_be write per provided axis; optionally a leading carrier-detach write. */
export function teleportOps(entries: TeleportEntry[], detachPuck: boolean): MemOp[] {
  const ops: MemOp[] = [];
  if (detachPuck) {
    ops.push({ op: "write", address: G.carrier, value: 0xffff, width: "u16_be" });
  }
  for (const e of entries) {
    const { base } = resolveTarget(e.target);
    const axes: [string, number | undefined][] = [
      ["x", e.x],
      ["y", e.y],
      ["z", e.z],
    ];
    let wrote = false;
    for (const [axis, v] of axes) {
      if (v === undefined) continue;
      checkCoord(axis, v);
      ops.push({ op: "write", address: base + OFF[axis], value: toFixed(v), width: "u32_be" });
      wrote = true;
    }
    if (!wrote) throw new Error(`teleport entry for "${e.target}" set no axis (pass x, y and/or z)`);
  }
  return ops;
}

/** Freeze x/y/z at their current raw 16.16 value; zero + freeze xv/yv/zv. */
export function freezeOps(
  targets: string[],
  positions: Record<string, { x: number; y: number; z: number }>,
): MemOp[] {
  const ops: MemOp[] = [];
  for (const t of targets) {
    const { base } = resolveTarget(t);
    const pos = positions[t];
    if (!pos) throw new Error(`no current position captured for "${t}"`);
    ops.push({ op: "freeze", address: base + OFF.x, value: pos.x >>> 0, width: "u32_be" });
    ops.push({ op: "freeze", address: base + OFF.y, value: pos.y >>> 0, width: "u32_be" });
    ops.push({ op: "freeze", address: base + OFF.z, value: pos.z >>> 0, width: "u32_be" });
    ops.push({ op: "freeze", address: base + OFF.xv, value: 0, width: "u16_be" });
    ops.push({ op: "freeze", address: base + OFF.yv, value: 0, width: "u16_be" });
    ops.push({ op: "freeze", address: base + OFF.zv, value: 0, width: "u16_be" });
  }
  return ops;
}

/** Release the 6 position+velocity freezes nhl94_freeze creates, per target. */
export function unfreezeOps(targets: string[]): MemOp[] {
  const ops: MemOp[] = [];
  for (const t of targets) {
    const { base } = resolveTarget(t);
    ops.push({ op: "unfreeze", address: base + OFF.x, width: "u32_be" });
    ops.push({ op: "unfreeze", address: base + OFF.y, width: "u32_be" });
    ops.push({ op: "unfreeze", address: base + OFF.z, width: "u32_be" });
    ops.push({ op: "unfreeze", address: base + OFF.xv, width: "u16_be" });
    ops.push({ op: "unfreeze", address: base + OFF.yv, width: "u16_be" });
    ops.push({ op: "unfreeze", address: base + OFF.zv, width: "u16_be" });
  }
  return ops;
}

/**
 * Park every skater (slots 0-11) not in `keep` at a commanded (x,y): freeze x
 * and y at the computed 16.16 values and freeze xv/yv/zv at 0 (5 ops each).
 * z is deliberately left untouched (parked skaters sit on the ground).
 */
export function parkOps(
  keep: string[],
  y: number,
  xStart: number,
  xSpacing: number,
): { ops: MemOp[]; assignments: { target: string; x: number }[] } {
  checkCoord("y", y);
  const kept = new Set(keep);
  const ops: MemOp[] = [];
  const assignments: { target: string; x: number }[] = [];
  let i = 0;
  for (let slot = 0; slot <= 11; slot++) {
    const target = `s${slot}`;
    if (kept.has(target)) continue;
    const x = xStart + i * xSpacing;
    checkCoord("x", x);
    const base = SORTCORDS + slot * SCSIZE;
    ops.push({ op: "freeze", address: base + OFF.x, value: toFixed(x), width: "u32_be" });
    ops.push({ op: "freeze", address: base + OFF.y, value: toFixed(y), width: "u32_be" });
    ops.push({ op: "freeze", address: base + OFF.xv, value: 0, width: "u16_be" });
    ops.push({ op: "freeze", address: base + OFF.yv, value: 0, width: "u16_be" });
    ops.push({ op: "freeze", address: base + OFF.zv, value: 0, width: "u16_be" });
    assignments.push({ target, x });
    i++;
  }
  if (assignments.length === 0) throw new Error("nothing to park (every skater is in keep)");
  return { ops, assignments };
}

// ── nhl94_recipes: the self-documenting use-case guide ───────────────────────
// Static prose returned verbatim by the nhl94_recipes tool. It is the intended
// FIRST read before driving NHL94: it maps intent ("I want to …") onto the
// right nhl94_* tool + call sequence, so the model never has to reverse-engineer
// the workflow from nine individual tool descriptions. Keep it in sync with the
// tools' actual behavior when any nhl94_* tool changes.
export const RECIPES_GUIDE = `NHL94 USE-CASE GUIDE — read this FIRST, then drive with the nhl94_* tools.

Targets are game nouns: skaters s0-s11, puck pk. All coordinates are WHOLE
pixels (the same numbers nhl94_state and the OSD show) — the tools handle
16.16 fixed-point / endianness for you. Nothing "sticks" on its own: to hold
something in place you FREEZE it (re-asserted every emulated frame until
released). Freezes live in the bridge and are cleared by reloading the Lua
script or restarting BizHawk — use nhl94_rig to survive that.

── WHEN TO USE EACH TOOL ─────────────────────────────────────────────────────
• nhl94_state    — decoded snapshot of everyone + globals. Your default read and
                   the verification step after every change. A trailing * on any
                   value = that word is frozen.
• nhl94_teleport — place a target at whole-pixel (x,y[,z]). Does NOT hold it;
                   the game moves it next frame unless you also freeze.
• nhl94_freeze   — pin targets at their CURRENT position (x/y/z) + zero velocity.
                   Teleport THEN freeze to place-and-hold.
• nhl94_unfreeze — release nhl94_freeze/park pins for given targets.
• nhl94_park     — clear the ice: teleport every skater NOT in keep off-ice and
                   freeze them there (puck untouched). Off-ice vs freeze's
                   at-current-position.
• nhl94_possession — give pk to a skater (proximity pickup) or set it loose.
                   hold:true freezes the carrier word (EMPIRICAL — verify live).
                   Side effect: camera eases to the puck/carrier.
• nhl94_clock    — set / freeze / release the game clock. freeze so nothing
                   expires mid-experiment.
• nhl94_camera   — pin (freeze) or release the scroll. EMPIRICAL — the game
                   rewrites scroll every frame, so a pin may jitter; the reliable
                   centering is focus-steering via nhl94_possession. Verify live.
• nhl94_rig      — save/apply/list/delete a named scenario (savestate + exact
                   freeze set). The durable way to survive restarts and to avoid
                   stale-freeze contamination (apply clears all freezes first).

── SCENARIOS ─────────────────────────────────────────────────────────────────
WANT TO isolate a 1-on-1 (two skaters + puck, everyone else gone)?
  1. nhl94_park keep=["s0","s6"]            (parks the other 10 off-ice)
  2. nhl94_teleport [{target:"s0",x:0,y:0},{target:"s6",x:40,y:0}]
  3. nhl94_possession target:"s0"           (s0 carries; camera eases in)
  4. nhl94_state                            (confirm positions + carrier)

WANT TO set up a 2-on-1 rush (two attackers vs one defender + goalie side)?
  1. nhl94_park keep=["s0","s1","s6"]        (2 attackers s0/s1, 1 defender s6)
  2. nhl94_teleport [{target:"s0",x:-30,y:60},{target:"s1",x:30,y:60},
                     {target:"s6",x:0,y:-40}]
  3. nhl94_possession target:"s0"
  4. nhl94_state

WANT TO stage a breakaway / hand one skater the puck and center on them?
  1. nhl94_teleport [{target:"s0",x:0,y:0}]
  2. nhl94_possession target:"s0"            (carrier + camera follow)
  3. nhl94_state                             (carrier should read s0)

WANT TO freeze the whole scene to inspect it?
  1. nhl94_freeze targets:["s0",...,"pk"]    (pin positions + zero velocity)
  2. nhl94_clock freeze:true                 (stop the clock too)
  3. nhl94_state                             (every held value shows a *)

WANT TO save a scenario and get it back after a restart?
  1. arrange it (park/teleport/freeze/clock as above)
  2. nhl94_rig save name:"my-drill"          (savestate + freeze set)
  … later, even in a fresh session …
  3. nhl94_rig apply name:"my-drill"         (clears all freezes, reloads, re-pins)

── VERIFY (always) ───────────────────────────────────────────────────────────
After any change, call nhl94_state and check:
  • the value moved to what you set,
  • a * appears on each word you froze (per-target x/y/z/xv/yv/zv AND globals
    carrier/clock/period/play/vpos/hpos/yleader),
  • frozen_summary: total = what you expect; unmapped=0 (a nonzero unmapped or a
    surprisingly large total means stale freezes from a previous rig — clear with
    bizhawk_unfreeze all:true or nhl94_rig apply).
EMPIRICAL holds (possession hold, camera pin) may not stick against the game's
per-frame rewrite — always confirm with a read-back.`;
