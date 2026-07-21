// NHL94 game-semantic layout + codecs.
//
// SOURCE OF TRUTH: docs/rom-reference/RETAIL_OFFSETS.md in the NHL94 game repo
// for decoded retail RAM, plus lua/bridge_JD.lua for trace/OSD parity fields.
// This module deliberately duplicates constants on the server side so the
// nhl94_* tools can translate game nouns (skaters s0-s11, puck pk) into 68K
// addresses/widths/endianness without a bridge round-trip.

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
  // Animation (SPA) record fields — mirror bridge_JD.lua TRACE_FIELDS.
  // attr = sprite attribute/flip bits (bit 3 = x-flip); anim = animation
  // selector; spanum = byte offset into the SPA per-direction list (÷4 = record
  // index); spacnt = VBL dwell countdown (signed).
  attr: 0x04,
  anim: 0x58,
  spanum: 0x5a,
  spacnt: 0x5c,
  // Extended per-entity fields (mirror bridge_JD.lua TRACE_FIELDS) that agents
  // otherwise hand-read via eval_lua. impact/impactp = body-check accumulators
  // (+0x32 is the accumulator the check routine slams to 256 during a stoppage);
  // pos = a positional/state word; nopuck = has-no-puck flag; pf/pf2/pf3 = player
  // flag bytes; wgt8 = weight byte.
  impact: 0x32,
  impactp: 0x2e,
  pos: 0x34,
  assidx: 0x36,
  assq0: 0x38,
  assq1: 0x39,
  assq2: 0x3a,
  assq3: 0x3b,
  assq4: 0x3c,
  assq5: 0x3d,
  assq6: 0x3e,
  assq7: 0x3f,
  nopuck: 0x5e,
  lockout: 0x5e,
  pf: 0x62,
  team_flags: 0x62,
  pf2: 0x63,
  pf3: 0x64,
  wgt8: 0x67,
  // Player ratings the OSD shows for the puck carrier (mirror bridge_JD.lua's
  // carrier readout): shotpwr/shotacc/passacc @0x6C/6D/6E, energy @0x66. u8.
  energy: 0x66,
  shotpwr: 0x6c,
  shotacc: 0x6d,
  passacc: 0x6e,
  puck_control_rating: 0x71,
};

// Read width per field name (used by nhl94_state and nhl94_read). Mirrors the
// widths bridge_JD.lua TRACE_FIELDS / the state reader use. x/y/z are 16.16
// longwords (read s32_be, decoded to whole pixels elsewhere).
export const FIELD_WIDTH: Record<string, string> = {
  x: "s32_be", y: "s32_be", z: "s32_be",
  xv: "s16_be", yv: "s16_be", zv: "s16_be",
  fdir: "u16_be", frame: "u16_be",
  attr: "u16_be", anim: "u16_be", spanum: "u16_be", spacnt: "s16_be",
  impact: "s16_be", impactp: "s16_be", pos: "u16_be",
  assidx: "u16_be",
  assq0: "u8", assq1: "u8", assq2: "u8", assq3: "u8",
  assq4: "u8", assq5: "u8", assq6: "u8", assq7: "u8",
  nopuck: "u8", pf: "u8", pf2: "u8", pf3: "u8", wgt8: "u8",
  lockout: "u8", team_flags: "u8",
  energy: "u8", shotpwr: "u8", shotacc: "u8", passacc: "u8",
  puck_control_rating: "u8",
};

// Fields that are 16.16 fixed-point (decode to whole pixels); everything else is
// a plain integer at its declared width.
export const FIXED_FIELDS = new Set(["x", "y", "z"]);

export const FDIR_DIRECTIONS = [
  "north",
  "northeast",
  "east",
  "southeast",
  "south",
  "southwest",
  "west",
  "northwest",
] as const;

export type FdirDirection = typeof FDIR_DIRECTIONS[number];

const FDIR_BY_NAME = new Map<string, number>(FDIR_DIRECTIONS.map((name, idx) => [name, idx]));

export function fdirValue(v: unknown): number {
  if (typeof v === "string") {
    const found = FDIR_BY_NAME.get(v.toLowerCase());
    if (found !== undefined) return found;
    throw new Error(`fdir direction must be one of: ${FDIR_DIRECTIONS.join(", ")}`);
  }
  if (typeof v === "number" && Number.isInteger(v)) return v;
  throw new Error("fdir value must be an integer or compass direction string");
}

export function fdirLabel(raw: number): string {
  const octant = raw & 0xffff;
  const label = FDIR_DIRECTIONS[octant];
  return label ? `${label} (${octant})` : String(raw);
}

// Absolute (M68K BUS) addresses of game globals (mirror bridge_JD.lua TRACE_G
// + camera consts). Keyed by the semantic field name used in freeze mapping.
export const G: Record<string, number> = {
  carrier: 0xffb7aa,
  clock: 0xffc468,
  gameclock: 0xffc468,
  period: 0xffc466,
  gsp: 0xffc466,
  gmode: 0xffc2ea,
  vpos: 0xffbd18,
  hpos: 0xffbd1c,
  yleader: 0xffbf92,
  // Play-context globals the OSD footer shows (mirror bridge_JD.lua TRACE_G):
  // shotplayer/lastplayer = slot index (s16, -1/none when unset), passdir/
  // passspeed = the last pass vector. All s16_be.
  shotplayer: 0xffbed8,
  lastplayer: 0xffbeda,
  passdir: 0xffbedc,
  passspeed: 0xffbede,
  // RETAIL_OFFSETS.md live-verified RAM table: canonical HUD score pair,
  // sim RNG state, and VBlank frame counter.
  home_score: 0xffc6da,
  away_score: 0xffca3e,
  rng_seed: 0xffd066,
  vblank_frame_counter: 0xffb03e,
  faceoff_window_latch: 0xffc304,
  line_change_latch: 0xffc304,
  home_line: 0xffc6e5,
  away_line: 0xffca48,
};

// Read-only control context globals. Kept separate from G so nhl94_fields does
// not expose semantic writes to control state.
export const CONTROL_G: Record<string, number> = {
  active_control_home: 0xffc320,
  active_control_away: 0xffc322,
  c1playernum: 0xffc656,
  c2playernum: 0xffc658,
  switch_debounce_home: 0xffbf06,
  switch_debounce_away: 0xffbf07,
  pad_word_0: 0xffbeee,
  pad_word_1: 0xffbef0,
  pad_word_2: 0xffbef2,
  pad_word_3: 0xffbef4,
};

// Screen/session-phase byte at 0xFFC735. NHL94 has NO clean single "screen
// state" enum — a two-playthrough full-RAM diff (2026-07-16, see memory
// nhl94-game-phase-flags.md) found every scalar candidate was either
// run-dependent scratch (0xFFCF2C/CF25) or opaque table data. This byte is
// itself opaque table data (part of a big-endian -1/-2 sentinel array), but it
// was the ONE signal that tracked the three coarse phase buckets IDENTICALLY
// across both independent runs:
//   0x00 = no game loaded  (title / EA-logo / team-select / setup menu / matchups intro)
//   0xFE = game loaded, OFF the ice  (pre-faceoff zamboni intro, inter-period intermission menu, post-game)
//   0xFF = ON the ice  (faceoff or live play — and only those)
// Combined with gmode(0xFFC2EA) bit0 (clock-stopped = faceoff/whistle) it yields
// the phase label from classifyPhase(). It is a HEURISTIC, not a documented mode
// variable — treat the vision caption as the authority for naming which menu.
export const SESSION_BYTE = 0xffc735;

/**
 * Coarse game-phase label from the two reliable instantaneous signals: the
 * session byte (SESSION_BYTE) and gmode bit0 (faceoffBit — set = clock stopped).
 * Deliberately conservative: it distinguishes live-play / on-ice-stoppage /
 * not-in-play (the "nothing moves until you press START" case the agent most
 * needs) and defers naming the specific menu to the vision caption.
 */
export function classifyPhase(sessionByte: number, faceoffBit: boolean): string {
  switch (sessionByte) {
    case 0xff:
      return faceoffBit
        ? "faceoff/stoppage (on ice; stoppage gate closed — whistle or faceoff)"
        : "gameplay (on ice; stoppage gate open)";
    case 0x00:
      return "pre-game (title / team-select / setup menu / intro — no game loaded; nothing moves until START — see caption)";
    case 0xfe:
      return "off-ice break (inter-period intermission, post-game, or pre-faceoff intro — nothing moves until START — see caption)";
    default:
      return `unknown (session=0x${(sessionByte >>> 0).toString(16).toUpperCase().padStart(2, "0")}${faceoffBit ? ", clock stopped" : ""}) — rely on the caption below`;
  }
}

/** Selected-line byte -> short NHL94 line label. Raw values are reported separately. */
export function lineLabel(v: number): "Sc1" | "Sc2" | "Chk" | "unknown" {
  switch (v) {
    case 0: return "Sc1";
    case 1: return "Sc2";
    case 2: return "Chk";
    default: return "unknown";
  }
}

export const ROLE_NAMES: Record<number, string> = {
  0: "idle",
  1: "assdefo",
  2: "assdefd",
  3: "asswingd",
  4: "asswingo",
  5: "asscenterd",
  6: "asscentero",
  7: "assscore",
  8: "assstanley",
  9: "assben",
  10: "assepen",
  11: "assbench",
  12: "asspenalty",
  13: "assdopen",
  14: "assgoaliecpu",
  15: "assgoalietopuck",
  16: "asspuckc",
  17: "assnearest",
  18: "assshoot",
  19: "asspassrec",
  20: "assfight",
  21: "fwatch",
  22: "assfaceoff",
  23: "assfaceoffpl",
  29: "assgoaliectrl",
  32: "assgoaliebreakwait",
};

export function roleName(idx: number): string {
  return ROLE_NAMES[idx] ?? `role_unknown(${idx})`;
}

export interface SlotControlContext {
  assidx: number;
  assq: number[];
  roleIdx: number;
  role: string;
  team: "home" | "away";
  humanActive: boolean;
  activePlayer: boolean;
  attackDir: "bottom" | "top";
  pf: number;
}

export function decodeSlotControl(rec: Record<string, number>): SlotControlContext {
  const pf = rec.pf ?? 0;
  const assidx = (rec.assidx ?? 0) & 7;
  const assq = Array.from({ length: 8 }, (_, i) => rec[`assq${i}`] ?? 0);
  const roleIdx = assq[assidx] ?? 0;
  return {
    assidx,
    assq,
    roleIdx,
    role: roleName(roleIdx),
    team: (pf & 0x40) !== 0 ? "away" : "home",
    humanActive: (pf & 0x08) !== 0,
    activePlayer: (pf & 0x20) !== 0,
    attackDir: (pf & 0x80) !== 0 ? "top" : "bottom",
    pf,
  };
}

export function formatSlotControlContext(ctx: SlotControlContext): string {
  return `role=${ctx.role}(q${ctx.assidx}=${ctx.roleIdx}) ` +
    `team=${ctx.team} human_active=${ctx.humanActive ? "true" : "false"} ` +
    `active_player=${ctx.activePlayer ? "true" : "false"} attack_dir=${ctx.attackDir} ` +
    `pf=0x${ctx.pf.toString(16).toUpperCase().padStart(2, "0")}`;
}

export function hexWord(v: number): string {
  return `0x${(v & 0xffff).toString(16).toUpperCase().padStart(4, "0")}`;
}

export function formatSwitchDebounce(v: number): string {
  return v === 0 ? "0(ready)" : `${v}(gated ${v}f)`;
}

export function formatPadWord(v: number): string {
  const decoded = (v & 0x10) !== 0 ? "(B)" : "";
  return `${hexWord(v)}${decoded}`;
}

export interface ControlSlotInfo {
  role: "human" | "CPU" | "unknown";
  active: string;
  raw: string;
  validSlot: boolean;
  slotTeamUnexpected: boolean;
}

export function controlSlotInfo(raw: number, team: "home" | "away"): ControlSlotInfo {
  const validSlot = raw >= 0 && raw <= 11;
  const slotTeamUnexpected = validSlot && (team === "home" ? raw > 5 : raw < 6);
  if (raw === 0xffff) {
    return { role: "CPU", active: "none", raw: hexWord(raw), validSlot: false, slotTeamUnexpected: false };
  }
  if (validSlot) {
    return { role: "human", active: `s${raw}`, raw: hexWord(raw), validSlot, slotTeamUnexpected };
  }
  return { role: "unknown", active: `unknown(${hexWord(raw)})`, raw: hexWord(raw), validSlot: false, slotTeamUnexpected: false };
}

export function inferControlMode(homeRaw: number, awayRaw: number): string {
  const homeValid = homeRaw >= 0 && homeRaw <= 11;
  const awayValid = awayRaw >= 0 && awayRaw <= 11;
  const homeCpu = homeRaw === 0xffff;
  const awayCpu = awayRaw === 0xffff;
  if (homeCpu && awayCpu) return "CPU-CPU";
  if (homeValid && awayCpu) return "1P-CPU";
  if (homeCpu && awayValid) return "CPU-1P";
  if (homeValid && awayValid) return "1P-2P";
  return "unknown";
}

export function formatInputRoute(mode: string, homeActive: string, awayActive: string): string {
  switch (mode) {
    case "1P-CPU":
      return `player1 likely controls home/team0 -> ${homeActive}; player2 inactive/CPU; route_verified=true`;
    case "CPU-1P":
      return `player1 likely controls away/team1 -> ${awayActive}; player2 inactive/CPU; route_verified=false`;
    case "1P-2P":
      return "player1/player2 likely map to home/away human teams; verify with pad words or live input; route_verified=false";
    default:
      return "no active input route known; route_verified=false";
  }
}

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

export interface ReadField {
  field: string;
  offset: number;
  width: string;
  fixed: boolean;
}

const RAW_FIELD = /^\+?(0x[0-9a-fA-F]+|\d+)(?::(u8|s8|u16|s16|u32|s32|u16_be|s16_be|u32_be|s32_be))?$/;

/**
 * Resolve a field token for nhl94_read into {field, offset, width, fixed}. A
 * token is either a KNOWN name (any key of OFF, e.g. "x", "impact", "pf") or a
 * RAW in-struct offset "+0xNN[:width]" / "0xNN[:width]" / "NN[:width]" (width
 * defaults to u8). This is the game-aware alternative to hand-computing
 * base+offset in eval_lua. Throws on an unknown name / malformed token.
 */
export function resolveField(token: string): ReadField {
  if (token in OFF) {
    return { field: token, offset: OFF[token], width: FIELD_WIDTH[token] ?? "u16_be", fixed: FIXED_FIELDS.has(token) };
  }
  const m = RAW_FIELD.exec(token);
  if (m) {
    const offset = m[1].startsWith("0x") ? parseInt(m[1], 16) : parseInt(m[1], 10);
    if (offset < 0 || offset >= SCSIZE) {
      throw new Error(`field offset ${token} out of struct range 0..0x${(SCSIZE - 1).toString(16)}`);
    }
    return { field: token, offset, width: m[2] ?? "u8", fixed: false };
  }
  throw new Error(`unknown field "${token}" (use a name like x/y/impact/pf/wgt8/nopuck or a raw offset like "+0x32:s16_be")`);
}

/** Default field set for nhl94_read — the extended per-entity fields nhl94_state
 * does NOT decode (the ones agents keep hand-reading via eval_lua). */
export const READ_DEFAULT_FIELDS = ["impact", "impactp", "pos", "nopuck", "pf", "pf2", "pf3", "wgt8"];

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
  xv?: number;
  yv?: number;
  zv?: number;
}

/**
 * Per provided POSITION axis (x/y/z): one u32_be write of the 16.16 fixed-point
 * value. Per provided VELOCITY axis (xv/yv/zv): one u16_be write of the raw
 * signed word (velocities are s16, NOT fixed-point — no scaling). Optionally a
 * leading carrier-detach write.
 */
export function teleportOps(entries: TeleportEntry[], detachPuck: boolean): MemOp[] {
  const ops: MemOp[] = [];
  if (detachPuck) {
    ops.push({ op: "write", address: G.carrier, value: 0xffff, width: "u16_be" });
  }
  for (const e of entries) {
    const { base } = resolveTarget(e.target);
    let wrote = false;
    // Positions: whole pixels → 16.16 fixed-point longword.
    const posAxes: [string, number | undefined][] = [["x", e.x], ["y", e.y], ["z", e.z]];
    for (const [axis, v] of posAxes) {
      if (v === undefined) continue;
      checkCoord(axis, v);
      ops.push({ op: "write", address: base + OFF[axis], value: toFixed(v), width: "u32_be" });
      wrote = true;
    }
    // Velocities: signed 16-bit words, written raw (two's-complement), no scaling.
    const velAxes: [string, number | undefined][] = [["xv", e.xv], ["yv", e.yv], ["zv", e.zv]];
    for (const [axis, v] of velAxes) {
      if (v === undefined) continue;
      checkCoord(axis, v);
      ops.push({ op: "write", address: base + OFF[axis], value: (v & 0xffff) >>> 0, width: "u16_be" });
      wrote = true;
    }
    if (!wrote) throw new Error(`teleport entry for "${e.target}" set no axis (pass x/y/z and/or xv/yv/zv)`);
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

// Off-ice parking geometry (fixed — no longer caller-tunable). Parked skaters
// sit at a far off-rink Y latitude and are spread evenly across the full X range
// so they never overlap regardless of how many are parked.
export const PARK_Y = 32000; // off-rink Y latitude
export const PARK_X_HALF = 32000; // parked skaters span [-PARK_X_HALF, +PARK_X_HALF]

/**
 * Park every skater (slots 0-11) not in `keep` off-ice: freeze x and y at the
 * computed 16.16 values and freeze xv/yv/zv at 0 (5 ops each). z is deliberately
 * left untouched (parked skaters sit on the ground).
 *
 * Y is fixed at PARK_Y. X positions are spread evenly across
 * [-PARK_X_HALF, +PARK_X_HALF] based on how many skaters are parked (N):
 * N=1 → x=0; N≥2 → the endpoints hit ±PARK_X_HALF with equal spacing between,
 * i.e. spacing = 2·PARK_X_HALF/(N-1) (N=2 → ±32000; N=3 → -32000,0,+32000;
 * N=4 → -32000,-10667,+10667,+32000; …).
 */
export function parkOps(
  keep: string[],
): { ops: MemOp[]; assignments: { target: string; x: number }[] } {
  const kept = new Set(keep);
  const slots: number[] = [];
  for (let slot = 0; slot <= 11; slot++) {
    if (!kept.has(`s${slot}`)) slots.push(slot);
  }
  if (slots.length === 0) throw new Error("nothing to park (every skater is in keep)");
  const n = slots.length;
  // Evenly distribute across the full X span; a lone skater sits dead center.
  const xAt = (i: number) =>
    n === 1 ? 0 : Math.round(-PARK_X_HALF + (i * (2 * PARK_X_HALF)) / (n - 1));
  const ops: MemOp[] = [];
  const assignments: { target: string; x: number }[] = [];
  slots.forEach((slot, i) => {
    const target = `s${slot}`;
    const x = xAt(i);
    checkCoord("x", x);
    const base = SORTCORDS + slot * SCSIZE;
    ops.push({ op: "freeze", address: base + OFF.x, value: toFixed(x), width: "u32_be" });
    ops.push({ op: "freeze", address: base + OFF.y, value: toFixed(PARK_Y), width: "u32_be" });
    ops.push({ op: "freeze", address: base + OFF.xv, value: 0, width: "u16_be" });
    ops.push({ op: "freeze", address: base + OFF.yv, value: 0, width: "u16_be" });
    ops.push({ op: "freeze", address: base + OFF.zv, value: 0, width: "u16_be" });
    assignments.push({ target, x });
  });
  return { ops, assignments };
}

// ── nhl94_recipes: the self-documenting use-case guide ───────────────────────
// Static prose returned verbatim by the nhl94_recipes tool. It is the intended
// one-time first read before driving NHL94: it maps intent onto the right
// nhl94_* tool + experiment sequence. Keep it in sync with schemas, handlers,
// and actual side effects whenever any nhl94_* tool changes.
export const RECIPES_GUIDE = `NHL94 PRIMER — read once at the start of an NHL94 task; do not repeat before every call.

── CORE MODEL ────────────────────────────────────────────────────────────────
• Targets are game entities: s0-s11 are skater slots; pk is the puck slot.
• Position x/y/z uses WHOLE pixels. Velocity xv/yv/zv uses game motion units.
  The nhl94_* tools own address, domain, width, endian, signedness, and 16.16
  conversion details; agents should not supply memory widths for named fields.
• Placement is not a state reset. Teleporting preserves animation, flags, and
  other latched state. A live entity may move again on later frames.
• A freeze is a per-frame rewrite, not a pause and not an undo. Releasing it
  leaves the last value in RAM until the game changes it. Clock freeze holds
  only the game timer; it does NOT close the collision stoppage gate.
• Freeze cleanup is separate from exec-trap cleanup. nhl94_unfreeze all:true,
  nhl94_stage clear_freezes:true, and rig apply clear bridge freezes only; they
  do NOT stop bizhawk_trap_exec hooks. Stop traps explicitly when done.
• Start unfamiliar experiments with nhl94_state. If existing freezes are not
  intentional, use nhl94_unfreeze {"all":true} before staging. Applying a rig
  already clears all freezes first, so do not pre-clear merely to apply a rig.

── TOOL ROUTER ───────────────────────────────────────────────────────────────
• nhl94_state — baseline and post-action verification. Default describe:true
  combines compact structured RAM with visual placement/contact/animation
  evidence. Use describe:false only for a fast RAM-only read. Dense groups are
  explicit: sections:"all" or sections:["anim","control","ratings","camera",
  "context","debug","freezes"]. verbose:true is an all-sections debug alias.
  A trailing * marks that exact frozen word.
• nhl94_rules — game mode, player matchup, penalties, and offside. Use this
  for the retail penalty enum: $FFD056 0=OFF, 1=ON, 2=ON except OFFSIDE.
• nhl94_read — curated entity snapshots by known field list. Use this instead
  of calculating a slot address or using eval_lua for entity reads. Named
  assignment fields include assidx and assq0..assq7.
• nhl94_fields — semantic field read/write/freeze/unfreeze for selected entity
  and global fields. Raw offsets/addresses require allow_raw:true and should be
  temporary verification scaffolding, not the default path. Named fields hide
  memory width/sign/endian details, including velocity fields. fdir accepts raw
  integers or compass strings: north=0, northeast=1, east=2, southeast=3,
  south=4, southwest=5, west=6, northwest=7.
• nhl94_stage — batch clean/rig/park/place/possession/field setup for one
  experiment scene. Use it when a multi-step setup would otherwise drift across
  frames or leave stale freezes. place and fields accept the same semantic
  values as nhl94_teleport/nhl94_fields. Default settle_frames is 0; it does
  not advance frames unless requested. clear_freezes does not stop exec traps.
• nhl94_teleport — set any subset of x/y/z and/or xv/yv/zv atomically. Moving
  pk automatically detaches it so the result is a loose puck. It does not pin
  and does not advance frames unless settle_frames > 0 is requested.
• nhl94_freeze — pin targets at their CURRENT x/y/z and zero+pin velocity.
• nhl94_unfreeze — targets:[...] releases selected entity pins; all:true clears
  the ENTIRE bridge freeze table, including clock/carrier/camera and unmapped.
• nhl94_park — move every skater not in keep off-ice and freeze them; pk is
  untouched. Existing freezes are not cleared. It does not advance frames
  unless settle_frames > 0 is requested.
• nhl94_possession — assign the carrier directly and place pk on that skater,
  or target:"none" for loose. hold:true freezes the carrier word; verify it.
  It does not advance frames unless settle_frames > 0 is requested. The camera
  normally eases toward the puck/carrier once frames are driven.
• nhl94_clock — set, freeze, or release only the game clock.
• nhl94_camera — pin/release scroll. Direct pinning may jitter; possession-led
  focus is usually more reliable. Verify visually.
• nhl94_rig — save/apply/list/delete a savestate plus its exact freeze table.
  Save captures EVERY current freeze, including stale/unmapped ones. Apply
  clears freezes, loads the state PAUSED, then restores the saved freezes.

── EXPERIMENT LIFECYCLE ──────────────────────────────────────────────────────
1. BASELINE: nhl94_state. Inspect carrier, positions/velocity/animation,
   interaction_gate, and frozen_summary.
2. CLEAN: if the old freeze set is unwanted, nhl94_unfreeze {"all":true}.
3. STAGE: prefer nhl94_stage for multi-step setups; otherwise use park,
   teleport, possession, fields, and/or clock operations. When setting a moving
   target, include velocity in the same placement call.
4. VERIFY STIMULUS: nhl94_state with describe:true. Confirm actual positions,
   motion, carrier, visible contact/formation, and expected animation. Do this
   before interpreting code traps.
5. CHECK GATE: interaction_gate:CLOSED proves gmode.bit0 blocks collision/check
   dispatch. OPEN only proves this ONE prerequisite is clear; it does not prove
   contact, resolver entry, or a particular branch. Never infer this RAM gate
   from a frozen HUD clock or a motionless screenshot.
6. TRACE: arm bizhawk_trap_exec, drive frames/input, verify the stimulus again,
   then read_stop the traps (or read, then stop). read/status do NOT stop hooks.
   Use read_mode:"summary" for transcript output or jsonl_file/csv_file for
   large captures. ZERO HITS is inconclusive until frame advance,
   movement/contact/animation, and gate state are all confirmed.
7. CONCLUDE from measured preconditions plus trap/state results. Keep unverified
   interpretations labeled as hypotheses.

── COPYABLE RECIPES ─────────────────────────────────────────────────────────
Clean 1-on-1 baseline (s0 vs s6, s0 carrying):
  1. nhl94_stage {"clear_freezes":true,"park":{"keep":["s0","s6"]},
       "place":[{"target":"s0","x":0,"y":0,"xv":0,"yv":0,"zv":0},
                {"target":"s6","x":40,"y":0,"xv":0,"yv":0,"zv":0}],
       "possession":"s0"}
  2. nhl94_state {}

Force a facing/lockout value without address math:
  1. nhl94_fields {"ops":[
       {"op":"write","target":"s6","field":"lockout","value":0},
       {"op":"freeze","target":"s6","field":"fdir","value":"south"}]}
  2. nhl94_state {"describe":true}

Loose moving puck (teleport auto-detaches):
  1. nhl94_teleport {"targets":[
       {"target":"pk","x":0,"y":100,"z":0,"xv":0,"yv":-300,"zv":0}]}
  2. nhl94_state {}

Render-settle after placement only when you want it:
  1. nhl94_teleport {"settle_frames":5,"targets":[
       {"target":"s6","x":40,"y":0}]}
  2. nhl94_state {"describe":true}

Freeze the full entity scene for inspection:
  1. nhl94_freeze {"targets":["s0","s1","s2","s3","s4","s5",
       "s6","s7","s8","s9","s10","s11","pk"]}
  2. nhl94_clock {"freeze":true}
  3. nhl94_state {}
  Note: clock freeze does not change interaction_gate.

Save and restore a reproducible rig:
  1. Build the scene; call nhl94_state and require frozen_summary unmapped=0
     unless every unmapped freeze is intentional.
  2. nhl94_rig {"action":"save","name":"my-drill"}
  3. Later: nhl94_rig {"action":"apply","name":"my-drill"}
  4. The applied rig is paused; drive it with frame/input tools when ready.

── ADDRESS AND EVIDENCE SAFETY ───────────────────────────────────────────────
• Do not hand-compute an entity address when nhl94_state or nhl94_read can
  express the read. raw:true exposes absolute addresses only for genuine traps.
• Do not pass widths for named nhl94_fields/nhl94_stage fields. Use names like
  fdir/xv/yv and values like "south"/0/12000; the server handles memory shape.
• For passive frame capture, use bizhawk_observe_frames. Use
  bizhawk_play_input_sequence only when injecting scripted joypad input.
• Do not scrape screenshot paths from disk. Use returned image/caption content
  from bizhawk_screenshot, bizhawk_observe_frames, or play_input_sequence.
• Structured RAM fields are authoritative for RAM facts. Vision is evidence
  for visible geometry/action and must admit uncertainty from a single still.
• frozen_summary unmapped>0 is a contamination warning, not automatic proof of
  an error. Understand it, clear all freezes, or deliberately preserve it.
• Empirical carrier holds and camera pins may fight game writes; always verify.`;
