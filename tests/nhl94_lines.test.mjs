import test from "node:test";
import assert from "node:assert/strict";

import {
  averageEnergy,
  attachRomDetail,
  buildRamResult,
  decodeStatus,
  energyValue,
  lineSelection,
  parseTeamStructure,
} from "../dist/nhl94-lines.js";

function rawSnapshot(overrides = {}) {
  const players = Array.from({ length: 12 }, (_, slot) => ({
    slot,
    currentLineupIndex: slot < 6 ? slot : slot - 6,
    desiredLineupIndex: 0xff,
    position: slot % 6,
  }));
  return {
    frame: 12345,
    session: 0xff,
    homeTeamId: 6,
    awayTeamId: 20,
    homeSelectedLine: 0,
    awaySelectedLine: 2,
    players,
    energy: {
      home: Array.from({ length: 26 }, (_, i) => 0x1000 - i * 16),
      away: Array.from({ length: 26 }, (_, i) => 0x0f00 - i * 8),
    },
    status: {
      home: Array.from({ length: 26 }, (_, i) => i < 6 ? 0xffff : 0xfffe),
      away: Array.from({ length: 26 }, (_, i) => i < 6 ? 0xffff : 0xfffe),
    },
    ...overrides,
  };
}

test("line, energy, status, and average primitives preserve exact evidence", () => {
  assert.deepEqual(lineSelection(4), { raw: 4, label: "PP2" });
  assert.deepEqual(lineSelection(9), { raw: 9, label: "unknown" });
  assert.deepEqual(energyValue(0x1200), { raw: 0x1200, percent: 112.5 });
  assert.deepEqual(averageEnergy([]), { raw: null, percent: null, contributors: 0 });
  assert.deepEqual(averageEnergy([0x1000, 0x0b33]), {
    raw: 3481.5,
    percent: 85,
    contributors: 2,
  });
  assert.deepEqual(decodeStatus(0xfffe), { raw: 0xfffe, label: "bench_recovery_state" });
  assert.deepEqual(decodeStatus(0x1234), { raw: 0x1234, label: "unknown" });
});

test("RAM result includes goalies, current-vs-desired swaps, and entity-count averages", () => {
  const raw = rawSnapshot();
  raw.players[1].desiredLineupIndex = 8;
  raw.players[2].currentLineupIndex = 1; // duplicate current occupant: counted and diagnosed
  raw.players[4].position = 0xffff; // off ice: excluded

  const result = buildRamResult("on_ice", raw, "M68K BUS");

  assert.equal(result.available, true);
  assert.equal(result.onIce.length, 12);
  assert.equal(result.onIce[0].position.label, "G");
  assert.equal(result.onIce[1].pendingSwap, true);
  assert.equal(result.onIce[1].desiredLineupIndex, 8);
  assert.equal(result.summary.home.onIceAverage.contributors, 5);
  assert.deepEqual(result.summary.home.duplicateCurrentLineupIndices, [1]);
});

test("invalid current and desired lineup indices never decode energy or status", () => {
  const raw = rawSnapshot();
  raw.players[0].currentLineupIndex = 0xff;
  raw.players[0].desiredLineupIndex = 0xfe;

  const result = buildRamResult("on_ice", raw, "68K RAM");
  const player = result.onIce[0];

  assert.equal(player.energy, null);
  assert.equal(player.status, null);
  assert.equal(player.pendingSwap, false);
  assert.deepEqual(player.decodeErrors, [
    "invalid_lineup_index",
    "invalid_desired_lineup_index",
  ]);
  assert.equal(result.summary.home.onIceAverage.contributors, 5);
});

test("invalid team identities produce a clean unavailable result", () => {
  const result = buildRamResult("summary", rawSnapshot({ homeTeamId: 0xffff }), "M68K BUS");

  assert.equal(result.complete, true);
  assert.equal(result.available, false);
  assert.equal(result.unavailableReason, "no_active_game");
  assert.equal(result.summary, null);
  assert.equal(result.onIce, null);
});

function writeU16(bytes, offset, value) {
  bytes[offset] = (value >> 8) & 0xff;
  bytes[offset + 1] = value & 0xff;
}

function teamFixture({ duplicate = false, badPad = false } = {}) {
  const records = [
    ["Goalie One", "goalie"],
    ["Left D", "skater"],
    ["Right D", "skater"],
    ["Left Wing", "skater"],
    ["Center", "skater"],
    ["Right Wing", "skater"],
    ["Extra", "skater"],
  ];
  const encoded = [];
  for (const [name, kind] of records) {
    const ascii = [...Buffer.from(name, "ascii")];
    if (ascii.length % 2 === 1) ascii.push(0);
    const fieldLength = 2 + ascii.length;
    encoded.push((fieldLength >> 8) & 0xff, fieldLength & 0xff, ...ascii);
    const attrs = [1, 2, 3, 4, 5, kind === "goalie" ? 0 : 1, 7, 8];
    encoded.push(...attrs);
  }
  encoded.push(0, 2); // retail empty-record terminator before the string block

  const stringBlockOffset = 0x92 + encoded.length;
  const bytes = new Uint8Array(stringBlockOffset);
  writeU16(bytes, 0x00, 0x92);
  writeU16(bytes, 0x02, 0x000c);
  writeU16(bytes, 0x04, stringBlockOffset);
  bytes.set([0x00, 0x52, 0x00, 0x4c, 0x00, 0x50], 0x06);
  for (let row = 0; row < 8; row++) {
    const members = [1, 2, duplicate && row === 2 ? 2 : 3, 4, 5, 6, row === 0 ? 0 : 7, 0];
    bytes.set(members, 0x52 + row * 8);
  }
  if (badPad) bytes[0x52 + 7] = 1;
  bytes.set(encoded, 0x92);
  return bytes;
}

test("retail team parser resolves combined 1-based roster records and empty EA", () => {
  const parsed = parseTeamStructure(teamFixture(), 0x243e);

  assert.equal(parsed.records[0].name, "Goalie One");
  assert.equal(parsed.records[0].kind, "goalie");
  assert.equal(parsed.records[4].name, "Center");
  assert.equal(parsed.lines[0].name, "NLC");
  assert.equal(parsed.lines[0].members.G, 0);
  assert.equal(parsed.lines[0].members.C, 4);
  assert.equal(parsed.lines[0].members.EA, null);
});

test("configured line averages count six positions and diagnose duplicates", () => {
  const raw = rawSnapshot();
  const result = buildRamResult("lines", raw, "M68K BUS");
  const parsed = parseTeamStructure(teamFixture({ duplicate: true }), 0x1000);
  const attached = attachRomDetail(
    result,
    raw,
    { home: parsed, away: parsed },
    "lines",
    { domain: "MD CART", romHash: "fixture" },
  );

  const sc2 = attached.configuredLines.home.find((line) => line.name === "Sc2");
  assert.equal(sc2.configuredAverage.contributors, 6);
  assert.deepEqual(sc2.duplicateConfiguredLineupIndices, [1]);
  assert.equal(sc2.extraAttacker.name, "Extra");
  assert.equal(attached.rosters, null);
});

test("roster detail reports current and desired slot membership separately", () => {
  const raw = rawSnapshot();
  raw.players[0].desiredLineupIndex = 6;
  const result = buildRamResult("roster", raw, "M68K BUS");
  const parsed = parseTeamStructure(teamFixture(), 0x1000);
  const attached = attachRomDetail(
    result,
    raw,
    { home: parsed, away: parsed },
    "roster",
    { domain: "MD CART", romHash: "fixture" },
  );

  assert.deepEqual(attached.rosters.home[0].currentlyLoadedInSlots, ["s0"]);
  assert.deepEqual(attached.rosters.home[0].desiredBySlots, []);
  assert.deepEqual(attached.rosters.home[6].currentlyLoadedInSlots, []);
  assert.deepEqual(attached.rosters.home[6].desiredBySlots, ["s0"]);
});

test("ROM parser rejects bad row padding and oversized spans", () => {
  assert.throws(
    () => parseTeamStructure(teamFixture({ badPad: true }), 0),
    (error) => error.code === "unsupported_layout" && /pad/.test(error.message),
  );
  assert.throws(
    () => parseTeamStructure(new Uint8Array(4097), 0),
    (error) => error.code === "span_too_large",
  );
  const zeroTerminator = teamFixture();
  zeroTerminator[zeroTerminator.length - 1] = 0;
  assert.throws(
    () => parseTeamStructure(zeroTerminator, 0),
    (error) => error.code === "unsupported_layout" && /terminator|length/.test(error.message),
  );
});

test("ROM parser rejects malformed records, names, and line members", () => {
  const malformedLength = teamFixture();
  writeU16(malformedLength, 0x92, 3);
  assert.throws(
    () => parseTeamStructure(malformedLength, 0),
    (error) => error.code === "unsupported_layout" && /length/.test(error.message),
  );

  const nonAsciiName = teamFixture();
  nonAsciiName[0x94] = 0x1f;
  assert.throws(
    () => parseTeamStructure(nonAsciiName, 0),
    (error) => error.code === "unsupported_layout" && /non-printable/.test(error.message),
  );

  const outOfRange = teamFixture();
  outOfRange[0x52 + 1] = 99;
  assert.throws(
    () => parseTeamStructure(outOfRange, 0),
    (error) => error.code === "unsupported_layout" && /exceeds roster size/.test(error.message),
  );

  const emptyStandard = teamFixture();
  emptyStandard[0x52 + 1] = 0;
  assert.throws(
    () => parseTeamStructure(emptyStandard, 0),
    (error) => error.code === "unsupported_layout" && /member is empty/.test(error.message),
  );
});
