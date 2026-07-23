import test from "node:test";
import assert from "node:assert/strict";
import { startHarness, textOf } from "./helpers/harness.mjs";

const DOMAINS = ["M68K BUS", "68K RAM", "MD CART"];

function ramValues(reads, overrides = {}) {
  const out = {};
  for (const read of reads) {
    const name = read.name;
    if (name === "frame") out[name] = 12345;
    else if (name === "session") out[name] = 0xff;
    else if (name === "home_team_id") out[name] = 6;
    else if (name === "away_team_id") out[name] = 20;
    else if (name === "home_selected_line") out[name] = 0;
    else if (name === "away_selected_line") out[name] = 2;
    else if (/^s(\d+)\.current$/.test(name)) out[name] = Number(name.match(/\d+/)[0]) % 6;
    else if (/^s\d+\.desired$/.test(name)) out[name] = 0xff;
    else if (/^s(\d+)\.position$/.test(name)) out[name] = Number(name.match(/\d+/)[0]) % 6;
    else if (/^(home|away)\.energy\.(\d+)$/.test(name)) {
      const [, side, index] = name.match(/^(home|away)\.energy\.(\d+)$/);
      out[name] = (side === "home" ? 0x1000 : 0x0f00) - Number(index) * 4;
    } else if (/^(home|away)\.status\.(\d+)$/.test(name)) {
      const index = Number(name.match(/\d+$/)[0]);
      out[name] = index < 6 ? 0xffff : 0xfffe;
    } else out[name] = 0;
  }
  return { ...out, ...overrides };
}

function writeU16(bytes, offset, value) {
  bytes[offset] = (value >> 8) & 0xff;
  bytes[offset + 1] = value & 0xff;
}

function teamFixture() {
  const records = [
    ["Goalie One", 0],
    ["Left D", 1],
    ["Right D", 1],
    ["Left Wing", 1],
    ["Center", 1],
    ["Right Wing", 1],
    ["Extra", 1],
  ];
  const encoded = [];
  for (const [name, kind] of records) {
    const ascii = [...Buffer.from(name, "ascii")];
    if (ascii.length % 2 === 1) ascii.push(0);
    const fieldLength = 2 + ascii.length;
    encoded.push((fieldLength >> 8) & 0xff, fieldLength & 0xff, ...ascii);
    encoded.push(1, 2, 3, 4, 5, kind, 7, 8);
  }
  encoded.push(0, 2);
  const bytes = new Uint8Array(0x92 + encoded.length);
  writeU16(bytes, 0x00, 0x92);
  writeU16(bytes, 0x02, 0x000c);
  writeU16(bytes, 0x04, bytes.length);
  bytes.set([0x00, 0x52, 0x00, 0x4c, 0x00, 0x50], 0x06);
  for (let row = 0; row < 8; row++) {
    bytes.set([1, 2, 3, 4, 5, 6, row === 0 ? 0 : 7, 0], 0x52 + row * 8);
  }
  bytes.set(encoded, 0x92);
  return bytes;
}

test("nhl94_lines catalog guides cumulative detail and pnum semantics", async () => {
  const h = await startHarness({});
  try {
    const tools = (await h.client.listTools()).tools;
    const tool = tools.find((entry) => entry.name === "nhl94_lines");
    assert.ok(tool);
    assert.deepEqual(tool.inputSchema.required, ["target"]);
    assert.deepEqual(tool.inputSchema.properties.detail.enum, ["summary", "on_ice", "lines", "roster"]);
    assert.match(tool.description, /lowest sufficient detail/i);
    assert.match(tool.description, /pnum.*index.*not.*stamina/i);
    for (const relatedName of ["nhl94_state", "nhl94_read", "nhl94_fields"]) {
      const related = tools.find((entry) => entry.name === relatedName);
      assert.match(related.description, /nhl94_lines/);
    }
  } finally {
    await h.close();
  }
});

test("nhl94_lines summary uses one same-dispatch RAM snapshot and no ROM calls", async () => {
  const h = await startHarness({
    list_memory_domains: () => DOMAINS,
    read_many: (p) => ramValues(p.reads),
  });
  try {
    const response = await h.client.callTool({
      name: "nhl94_lines",
      arguments: { target: h.target },
    });
    const result = JSON.parse(textOf(response));
    assert.equal(result.detail, "summary");
    assert.equal(result.summary.home.selectedLine.label, "Sc1");
    assert.equal(result.summary.away.onIceAverage.contributors, 6);
    assert.equal(result.onIce, null);
    const calls = h.bridge.calls.filter((call) => call.method === "read_many");
    assert.equal(calls.length, 1);
    assert.ok(calls[0].params.reads.some((read) => read.name === "s0.current" && read.width === "u8"));
    assert.ok(calls[0].params.reads.some((read) => read.name === "home.energy.25" && read.width === "u16_be"));
    assert.ok(!h.bridge.calls.some((call) => call.method === "get_info" || call.method === "read_range"));
  } finally {
    await h.close();
  }
});

test("nhl94_lines on_ice includes all twelve player entities", async () => {
  const h = await startHarness({
    list_memory_domains: () => DOMAINS,
    read_many: (p) => ramValues(p.reads, { "s0.desired": 8 }),
  });
  try {
    const response = await h.client.callTool({
      name: "nhl94_lines",
      arguments: { target: h.target, detail: "on_ice" },
    });
    const result = JSON.parse(textOf(response));
    assert.equal(result.onIce.length, 12);
    assert.equal(result.onIce[0].position.label, "G");
    assert.equal(result.onIce[0].pendingSwap, true);
    assert.equal(h.bridge.calls.filter((call) => call.method === "read_many").length, 1);
  } finally {
    await h.close();
  }
});

test("nhl94_lines retains RAM evidence when ROM domain is unavailable", async () => {
  const h = await startHarness({
    list_memory_domains: () => ["M68K BUS"],
    read_many: (p) => ramValues(p.reads),
    get_info: () => ({ rom_hash: "fixture", memory_domains: ["M68K BUS"] }),
  });
  try {
    const response = await h.client.callTool({
      name: "nhl94_lines",
      arguments: { target: h.target, detail: "lines" },
    });
    const result = JSON.parse(textOf(response));
    assert.equal(result.complete, false);
    assert.equal(result.summary.home.selectedLine.label, "Sc1");
    assert.equal(result.onIce.length, 12);
    assert.equal(result.rom, null);
    assert.equal(result.romError.code, "missing_cartridge_domain");
  } finally {
    await h.close();
  }
});

test("nhl94_lines roster detail resolves bounded MD CART structures", async () => {
  const pointer = 0x1000;
  const team = teamFixture();
  const pointers = new Uint8Array(28 * 4);
  for (const teamId of [6, 20]) {
    const offset = teamId * 4;
    pointers[offset] = (pointer >>> 24) & 0xff;
    pointers[offset + 1] = (pointer >>> 16) & 0xff;
    pointers[offset + 2] = (pointer >>> 8) & 0xff;
    pointers[offset + 3] = pointer & 0xff;
  }
  const h = await startHarness({
    list_memory_domains: () => DOMAINS,
    read_many: (p) => ramValues(p.reads),
    get_info: () => ({ rom_hash: "roster-fixture", memory_domains: DOMAINS }),
    read_range: (p) => {
      if (p.address === 0x30e && p.length === pointers.length) return [...pointers];
      if (p.address === pointer && p.length === 6) return [...team.slice(0, 6)];
      if (p.address === pointer && p.length === team.length) return [...team];
      throw new Error(`unexpected ROM read 0x${p.address.toString(16)} length ${p.length}`);
    },
  });
  try {
    const response = await h.client.callTool({
      name: "nhl94_lines",
      arguments: { target: h.target, detail: "roster" },
    });
    const result = JSON.parse(textOf(response));
    assert.equal(result.complete, true);
    assert.equal(result.rom.domain, "MD CART");
    assert.equal(result.rom.parserLayoutVersion, "nhl94-retail-roster-v1");
    assert.equal(result.configuredLines.home[1].members.G.name, "Goalie One");
    assert.equal(result.rosters.away[4].name, "Center");
    assert.deepEqual(result.rosters.home[0].currentlyLoadedInSlots, ["s0"]);
    assert.ok(h.bridge.calls
      .filter((call) => call.method === "read_range")
      .every((call) => call.params.length <= 4096));
  } finally {
    await h.close();
  }
});

test("nhl94_lines returns no_active_game instead of decoding menu garbage", async () => {
  const h = await startHarness({
    list_memory_domains: () => DOMAINS,
    read_many: (p) => ramValues(p.reads, { home_team_id: 0xffff }),
  });
  try {
    const response = await h.client.callTool({
      name: "nhl94_lines",
      arguments: { target: h.target },
    });
    const result = JSON.parse(textOf(response));
    assert.equal(result.available, false);
    assert.equal(result.unavailableReason, "no_active_game");
    assert.equal(result.summary, null);
  } finally {
    await h.close();
  }
});

test("nhl94_state shares compact line stamina and opt-in player detail", async () => {
  const h = await startHarness({
    list_memory_domains: () => DOMAINS,
    read_struct_array: (p) => Array.from({ length: p.count }, (_, index) => {
      const record = { _index: index };
      for (const field of p.fields) record[field.name] = 0;
      record.pnum = index % 6;
      record.roster_index = 0xff;
      record.pos = index <= 11 ? index % 6 : 0xffff;
      return record;
    }),
    read_many: (p) => ({
      ...ramValues(p.reads),
      carrier: 0,
      gameclock: 300,
      gsp: 0,
      gmode: 0,
      session: 0xff,
      home_line: 0,
      away_line: 2,
      home_team_id: 6,
      away_team_id: 20,
      line_snapshot_frame: 12345,
    }),
    list_frozen: () => ({ frozen: [] }),
  });
  try {
    const response = await h.client.callTool({
      name: "nhl94_state",
      arguments: { target: h.target, sections: ["lines"], describe: false },
    });
    const text = textOf(response);
    assert.match(text, /line_stamina: home=Sc1\(0\).*away=Chk\(2\)/);
    assert.match(text, /line_players:/);
    assert.match(text, /s0 team=home current=0 desired=— pending=false pos=G\(0\) energy=4096\(100%\)/);
  } finally {
    await h.close();
  }
});
