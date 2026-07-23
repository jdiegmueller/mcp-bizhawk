import { SCSIZE, SORTCORDS } from "./nhl94.js";

export type LinesDetail = "summary" | "on_ice" | "lines" | "roster";
export type TeamSide = "home" | "away";

export const TEAM_BASE = {
  home: 0xffc6ce,
  away: 0xffca32,
} as const;
export const TEAM_IDENTITY = {
  home: 0xffc330,
  away: 0xffc332,
} as const;
export const SELECTED_LINE = {
  home: 0xffc6e5,
  away: 0xffca48,
} as const;
export const ENERGY_OFFSET = 0x32;
export const STATUS_OFFSET = 0x66;
export const ROSTER_SIZE = 26;
export const ROM_TEAM_POINTER_TABLE = 0x30e;
export const ROM_TEAM_COUNT = 28;
export const ROM_DOMAIN = "MD CART";
export const ROM_LAYOUT_VERSION = "nhl94-retail-roster-v1";
export const MAX_TEAM_SPAN = 4096;

const LINE_LABELS = ["Sc1", "Sc2", "Chk", "PP1", "PP2", "PK1", "PK2"] as const;
const POSITION_LABELS = ["G", "LD", "RD", "LW", "C", "RW"] as const;
const ROM_LINE_NAMES = ["NLC", "Sc1", "Sc2", "Chk", "PP1", "PP2", "PK1", "PK2"] as const;
const ROM_LINE_POSITIONS = ["G", "LD", "RD", "LW", "C", "RW", "EA"] as const;

export interface EnergyValue {
  raw: number;
  percent: number;
}

export interface AverageEnergy {
  raw: number | null;
  percent: number | null;
  contributors: number;
}

export interface RawLoadedPlayer {
  slot: number;
  currentLineupIndex: number;
  desiredLineupIndex: number;
  position: number;
}

export interface RawLinesSnapshot {
  frame: number;
  session: number;
  homeTeamId: number;
  awayTeamId: number;
  homeSelectedLine: number;
  awaySelectedLine: number;
  players: RawLoadedPlayer[];
  energy: Record<TeamSide, number[]>;
  status: Record<TeamSide, number[]>;
}

export interface LoadedPlayerResult {
  slot: string;
  team: TeamSide;
  currentLineupIndex: number;
  desiredLineupIndex: number | null;
  pendingSwap: boolean;
  position: { raw: number; label: string };
  energy: EnergyValue | null;
  status: { raw: number; label: string } | null;
  decodeErrors: string[];
}

export interface ParsedRosterRecord {
  lineupIndex: number;
  name: string;
  kind: "goalie" | "skater";
  attributes: number[];
}

export interface ParsedConfiguredLine {
  name: typeof ROM_LINE_NAMES[number];
  members: Record<typeof ROM_LINE_POSITIONS[number], number | null>;
}

export interface ParsedTeamStructure {
  pointer: number;
  span: number;
  records: ParsedRosterRecord[];
  lines: ParsedConfiguredLine[];
}

export class NhlRomLayoutError extends Error {
  constructor(public readonly code: string, message: string) {
    super(message);
    this.name = "NhlRomLayoutError";
  }
}

function round2(value: number): number {
  return Math.round((value + Number.EPSILON) * 100) / 100;
}

export function lineSelection(raw: number): { raw: number; label: string } {
  return { raw, label: LINE_LABELS[raw] ?? "unknown" };
}

export function energyValue(raw: number): EnergyValue {
  return { raw, percent: round2((raw / 0x1000) * 100) };
}

export function averageEnergy(values: number[]): AverageEnergy {
  if (values.length === 0) return { raw: null, percent: null, contributors: 0 };
  const raw = values.reduce((sum, value) => sum + value, 0) / values.length;
  return {
    raw,
    percent: round2((raw / 0x1000) * 100),
    contributors: values.length,
  };
}

export function decodeStatus(raw: number): { raw: number; label: string } {
  if (raw === 0xffff) return { raw, label: "on_ice" };
  if (raw === 0xfffe) return { raw, label: "bench_recovery_state" };
  return { raw, label: "unknown" };
}

export function positionValue(raw: number): { raw: number; label: string } {
  if (raw >= 0 && raw <= 5) return { raw, label: POSITION_LABELS[raw] };
  if (raw === 0xffff) return { raw, label: "off_ice" };
  return { raw, label: "unknown" };
}

export function playerSlotReadSpecs(domain: string): {
  name: string;
  address: number;
  width: string;
  domain: string;
}[] {
  const reads = [];
  for (let slot = 0; slot < 12; slot++) {
    const base = SORTCORDS + slot * SCSIZE;
    reads.push(
      { name: `s${slot}.current`, address: base + 0x66, width: "u8", domain },
      { name: `s${slot}.desired`, address: base + 0x61, width: "u8", domain },
      { name: `s${slot}.position`, address: base + 0x34, width: "u16_be", domain },
    );
  }
  return reads;
}

export function teamTableReadSpecs(domain: string): {
  name: string;
  address: number;
  width: string;
  domain: string;
}[] {
  const reads = [];
  for (const side of ["home", "away"] as const) {
    for (let index = 0; index < ROSTER_SIZE; index++) {
      reads.push(
        {
          name: `${side}.energy.${index}`,
          address: TEAM_BASE[side] + ENERGY_OFFSET + index * 2,
          width: "u16_be",
          domain,
        },
        {
          name: `${side}.status.${index}`,
          address: TEAM_BASE[side] + STATUS_OFFSET + index * 2,
          width: "u16_be",
          domain,
        },
      );
    }
  }
  return reads;
}

export function rawSnapshotFromReadValues(values: Record<string, number>): RawLinesSnapshot {
  const players = Array.from({ length: 12 }, (_, slot) => ({
    slot,
    currentLineupIndex: values[`s${slot}.current`],
    desiredLineupIndex: values[`s${slot}.desired`],
    position: values[`s${slot}.position`],
  }));
  const table = (side: TeamSide, kind: "energy" | "status") =>
    Array.from({ length: ROSTER_SIZE }, (_, index) => values[`${side}.${kind}.${index}`]);
  return {
    frame: values.frame,
    session: values.session,
    homeTeamId: values.home_team_id,
    awayTeamId: values.away_team_id,
    homeSelectedLine: values.home_selected_line,
    awaySelectedLine: values.away_selected_line,
    players,
    energy: { home: table("home", "energy"), away: table("away", "energy") },
    status: { home: table("home", "status"), away: table("away", "status") },
  };
}

function decodePlayer(raw: RawLoadedPlayer, snapshot: RawLinesSnapshot): LoadedPlayerResult {
  const team: TeamSide = raw.slot < 6 ? "home" : "away";
  const decodeErrors: string[] = [];
  const currentValid = raw.currentLineupIndex >= 0 && raw.currentLineupIndex < ROSTER_SIZE;
  const desiredInactive = raw.desiredLineupIndex === 0xff;
  const desiredValid = raw.desiredLineupIndex >= 0 && raw.desiredLineupIndex < ROSTER_SIZE;
  const rawEnergy = currentValid ? snapshot.energy[team][raw.currentLineupIndex] : undefined;
  const rawStatus = currentValid ? snapshot.status[team][raw.currentLineupIndex] : undefined;
  if (!currentValid) decodeErrors.push("invalid_lineup_index");
  if (!desiredInactive && !desiredValid) decodeErrors.push("invalid_desired_lineup_index");

  return {
    slot: `s${raw.slot}`,
    team,
    currentLineupIndex: raw.currentLineupIndex,
    desiredLineupIndex: desiredValid ? raw.desiredLineupIndex : null,
    pendingSwap: desiredValid && raw.desiredLineupIndex !== raw.currentLineupIndex,
    position: positionValue(raw.position),
    energy: Number.isInteger(rawEnergy) ? energyValue(rawEnergy!) : null,
    status: Number.isInteger(rawStatus) ? decodeStatus(rawStatus!) : null,
    decodeErrors,
  };
}

function duplicates(values: number[]): number[] {
  const seen = new Set<number>();
  const duplicates = new Set<number>();
  for (const value of values) {
    if (seen.has(value)) duplicates.add(value);
    seen.add(value);
  }
  return [...duplicates].sort((a, b) => a - b);
}

function teamSummary(
  side: TeamSide,
  selectedLine: number,
  players: LoadedPlayerResult[],
): Record<string, unknown> {
  const teamPlayers = players.filter((player) => player.team === side);
  const onIce = teamPlayers.filter((player) =>
    player.position.raw >= 0 &&
    player.position.raw <= 5 &&
    player.energy !== null
  );
  const validIndices = teamPlayers
    .filter((player) => player.energy !== null)
    .map((player) => player.currentLineupIndex);
  return {
    selectedLine: lineSelection(selectedLine),
    onIceAverage: averageEnergy(onIce.map((player) => player.energy!.raw)),
    duplicateCurrentLineupIndices: duplicates(validIndices),
  };
}

export function buildRamResult(
  detail: LinesDetail,
  snapshot: RawLinesSnapshot,
  ramDomain: string,
): Record<string, any> {
  const identitiesValid =
    snapshot.homeTeamId >= 0 && snapshot.homeTeamId < ROM_TEAM_COUNT &&
    snapshot.awayTeamId >= 0 && snapshot.awayTeamId < ROM_TEAM_COUNT;
  const anyValidPlayer = snapshot.players.some((player) =>
    player.currentLineupIndex >= 0 && player.currentLineupIndex < ROSTER_SIZE
  );
  const base = {
    detail,
    complete: true,
    available: identitiesValid && anyValidPlayer,
    unavailableReason: null as string | null,
    snapshot: {
      frame: snapshot.frame,
      session: snapshot.session,
      ramDomain,
    },
    summary: null as Record<string, unknown> | null,
    onIce: null as LoadedPlayerResult[] | null,
    configuredLines: null,
    rosters: null,
    rom: null,
    romError: null,
  };

  if (!base.available) {
    base.unavailableReason = "no_active_game";
    return base;
  }

  const players = snapshot.players.map((player) => decodePlayer(player, snapshot));
  base.summary = {
    home: {
      teamIdentity: snapshot.homeTeamId,
      ...teamSummary("home", snapshot.homeSelectedLine, players),
    },
    away: {
      teamIdentity: snapshot.awayTeamId,
      ...teamSummary("away", snapshot.awaySelectedLine, players),
    },
  };
  if (detail !== "summary") base.onIce = players;
  return base;
}

function readBe16(bytes: Uint8Array, offset: number): number {
  if (offset < 0 || offset + 2 > bytes.length) {
    throw new NhlRomLayoutError("unsupported_layout", `u16 read out of bounds at +0x${offset.toString(16)}`);
  }
  return bytes[offset] * 0x100 + bytes[offset + 1];
}

function printableAsciiName(bytes: Uint8Array): string {
  let end = bytes.length;
  while (end > 0 && bytes[end - 1] === 0) end--;
  for (let i = 0; i < end; i++) {
    if (bytes[i] < 0x20 || bytes[i] > 0x7e) {
      throw new NhlRomLayoutError("unsupported_layout", "roster name contains non-printable ASCII");
    }
  }
  for (let i = end; i < bytes.length; i++) {
    if (bytes[i] !== 0) {
      throw new NhlRomLayoutError("unsupported_layout", "roster name has non-NUL padding");
    }
  }
  return String.fromCharCode(...bytes.slice(0, end));
}

export function parseTeamStructure(bytes: Uint8Array, pointer: number): ParsedTeamStructure {
  if (bytes.length > MAX_TEAM_SPAN) {
    throw new NhlRomLayoutError("span_too_large", `team span ${bytes.length} exceeds ${MAX_TEAM_SPAN}`);
  }
  if (bytes.length < 0x92) {
    throw new NhlRomLayoutError("unsupported_layout", `team span ${bytes.length} is shorter than 0x92`);
  }
  if (!Number.isSafeInteger(pointer) || pointer < 0) {
    throw new NhlRomLayoutError("invalid_team_pointer", `invalid team pointer ${pointer}`);
  }
  const firstRecordOffset = readBe16(bytes, 0x00);
  const structuralConstant = readBe16(bytes, 0x02);
  const stringBlockOffset = readBe16(bytes, 0x04);
  if (firstRecordOffset !== 0x92 || structuralConstant !== 0x000c) {
    throw new NhlRomLayoutError(
      "unsupported_layout",
      `unexpected team header first=0x${firstRecordOffset.toString(16)} const=0x${structuralConstant.toString(16)}`,
    );
  }
  if (stringBlockOffset !== bytes.length || stringBlockOffset < firstRecordOffset) {
    throw new NhlRomLayoutError(
      "unsupported_layout",
      `string block offset ${stringBlockOffset} does not match validated span ${bytes.length}`,
    );
  }
  const defaults = [0x00, 0x52, 0x00, 0x4c, 0x00, 0x50];
  if (!defaults.every((value, index) => bytes[0x06 + index] === value)) {
    throw new NhlRomLayoutError("unsupported_layout", "unexpected engine-default bytes");
  }

  const rawRows: number[][] = [];
  for (let row = 0; row < ROM_LINE_NAMES.length; row++) {
    const offset = 0x52 + row * 8;
    const values = [...bytes.slice(offset, offset + 8)];
    if (values[7] !== 0) {
      throw new NhlRomLayoutError("unsupported_layout", `${ROM_LINE_NAMES[row]} line pad byte is nonzero`);
    }
    rawRows.push(values);
  }

  const records: ParsedRosterRecord[] = [];
  let cursor = firstRecordOffset;
  let sawSkater = false;
  while (cursor < stringBlockOffset) {
    const nameFieldLength = readBe16(bytes, cursor);
    if (nameFieldLength === 2 && cursor + 2 === stringBlockOffset) {
      cursor = stringBlockOffset;
      break;
    }
    if (nameFieldLength < 2 || nameFieldLength % 2 !== 0) {
      throw new NhlRomLayoutError(
        "unsupported_layout",
        `invalid roster record length/terminator 0x${nameFieldLength.toString(16).padStart(4, "0")}`,
      );
    }
    const recordEnd = cursor + nameFieldLength + 8;
    if (recordEnd > stringBlockOffset) {
      throw new NhlRomLayoutError("unsupported_layout", "roster record crosses string-block boundary");
    }
    const name = printableAsciiName(bytes.slice(cursor + 2, cursor + nameFieldLength));
    const attributes = [...bytes.slice(cursor + nameFieldLength, recordEnd)];
    const kind = attributes[5] === 0 ? "goalie" : "skater";
    if (kind === "goalie" && sawSkater) {
      throw new NhlRomLayoutError("unsupported_layout", "goalie record appears after skater records");
    }
    if (kind === "skater") sawSkater = true;
    records.push({ lineupIndex: records.length, name, kind, attributes });
    cursor = recordEnd;
  }
  if (cursor !== stringBlockOffset || records.length === 0) {
    throw new NhlRomLayoutError("unsupported_layout", "roster records do not terminate at string block");
  }

  const lines = rawRows.map((row, rowIndex): ParsedConfiguredLine => {
    const members = {} as Record<typeof ROM_LINE_POSITIONS[number], number | null>;
    for (let positionIndex = 0; positionIndex < ROM_LINE_POSITIONS.length; positionIndex++) {
      const position = ROM_LINE_POSITIONS[positionIndex];
      const stored = row[positionIndex];
      if (stored === 0) {
        if (position !== "EA") {
          throw new NhlRomLayoutError(
            "unsupported_layout",
            `${ROM_LINE_NAMES[rowIndex]} ${position} member is empty`,
          );
        }
        members[position] = null;
        continue;
      }
      const lineupIndex = stored - 1;
      const record = records[lineupIndex];
      if (!record) {
        throw new NhlRomLayoutError(
          "unsupported_layout",
          `${ROM_LINE_NAMES[rowIndex]} ${position} member ${stored} exceeds roster size ${records.length}`,
        );
      }
      if (position === "G" && record.kind !== "goalie") {
        throw new NhlRomLayoutError("unsupported_layout", `${ROM_LINE_NAMES[rowIndex]} G is not a goalie`);
      }
      if (position !== "G" && record.kind !== "skater") {
        throw new NhlRomLayoutError("unsupported_layout", `${ROM_LINE_NAMES[rowIndex]} ${position} is not a skater`);
      }
      members[position] = lineupIndex;
    }
    return { name: ROM_LINE_NAMES[rowIndex], members };
  });

  return { pointer, span: bytes.length, records, lines };
}

function configuredPlayer(
  team: TeamSide,
  record: ParsedRosterRecord,
  snapshot: RawLinesSnapshot,
): Record<string, unknown> {
  const rawEnergy = snapshot.energy[team][record.lineupIndex];
  const rawStatus = snapshot.status[team][record.lineupIndex];
  return {
    lineupIndex: record.lineupIndex,
    name: record.name,
    kind: record.kind,
    energy: Number.isInteger(rawEnergy) ? energyValue(rawEnergy) : null,
    status: Number.isInteger(rawStatus) ? decodeStatus(rawStatus) : null,
  };
}

function configuredLineResult(
  team: TeamSide,
  line: ParsedConfiguredLine,
  parsed: ParsedTeamStructure,
  snapshot: RawLinesSnapshot,
): Record<string, unknown> {
  const members: Record<string, unknown> = {};
  const standardIndices: number[] = [];
  for (const position of ROM_LINE_POSITIONS) {
    const index = line.members[position];
    if (index === null) {
      members[position] = null;
      continue;
    }
    members[position] = configuredPlayer(team, parsed.records[index], snapshot);
    if (position !== "EA") standardIndices.push(index);
  }
  return {
    name: line.name,
    members,
    configuredAverage: averageEnergy(
      standardIndices
        .map((index) => snapshot.energy[team][index])
        .filter((value) => Number.isInteger(value)),
    ),
    duplicateConfiguredLineupIndices: duplicates(standardIndices),
    extraAttacker: line.members.EA === null
      ? null
      : configuredPlayer(team, parsed.records[line.members.EA], snapshot),
  };
}

export function attachRomDetail(
  result: Record<string, any>,
  snapshot: RawLinesSnapshot,
  teams: Record<TeamSide, ParsedTeamStructure>,
  detail: "lines" | "roster",
  diagnostics: { domain: string; romHash: string },
): Record<string, any> {
  result.configuredLines = {
    home: teams.home.lines.map((line) => configuredLineResult("home", line, teams.home, snapshot)),
    away: teams.away.lines.map((line) => configuredLineResult("away", line, teams.away, snapshot)),
  };
  result.rom = {
    domain: diagnostics.domain,
    romHash: diagnostics.romHash,
    parserLayoutVersion: ROM_LAYOUT_VERSION,
    teams: {
      home: { pointer: teams.home.pointer, span: teams.home.span },
      away: { pointer: teams.away.pointer, span: teams.away.span },
    },
  };
  if (detail === "roster") {
    result.rosters = {};
    for (const side of ["home", "away"] as const) {
      const sidePlayers = snapshot.players.filter((player) => (player.slot < 6 ? "home" : "away") === side);
      result.rosters[side] = teams[side].records.map((record) => {
        const memberships: { line: string; position: string }[] = [];
        for (const line of teams[side].lines) {
          for (const position of ROM_LINE_POSITIONS) {
            if (line.members[position] === record.lineupIndex) memberships.push({ line: line.name, position });
          }
        }
        return {
          ...configuredPlayer(side, record, snapshot),
          currentlyLoadedInSlots: sidePlayers
            .filter((player) => player.currentLineupIndex === record.lineupIndex)
            .map((player) => `s${player.slot}`),
          desiredBySlots: sidePlayers
            .filter((player) =>
              player.desiredLineupIndex >= 0 &&
              player.desiredLineupIndex < ROSTER_SIZE &&
              player.desiredLineupIndex === record.lineupIndex &&
              player.desiredLineupIndex !== player.currentLineupIndex
            )
            .map((player) => `s${player.slot}`),
          memberships,
        };
      });
    }
  }
  return result;
}
