# NHL '94 Lines and Stamina Visibility Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Add complete, tiered, read-only NHL '94 line, roster, and live-stamina visibility through a new semantic tool and compact state/OSD integration.

**Architecture:** A focused `src/nhl94-lines.ts` module owns stable result types, RAM decoding, averaging, retail-compatible ROM parsing, and formatting. `src/tools.ts` performs one-dispatch RAM reads, bounded/cached ROM reads, MCP routing, and `nhl94_state` integration; Lua uses small energy helpers for the OSD. Deep ROM failures retain valid RAM data.

**Tech Stack:** TypeScript/Node MCP server, Node test runner, BizHawk Lua bridge, `read_many` and `read_range` bridge RPCs.

## Global Constraints

- Detail levels are cumulative: `summary`, `on_ice`, `lines`, `roster`; default is `summary`.
- Current energy is `u16_be` at `teamBase + 0x32 + lineupIndex*2`; `0x1000` is 100%.
- Current lineup index is entity `+0x66` `u8`; it is not energy.
- One `read_many` bridge dispatch must capture every RAM field used by `nhl94_lines`.
- ROM team spans are capped at 4096 bytes and use exact domain `MD CART`.
- Unsupported ROM layout returns `complete:false` plus `romError` while retaining RAM data.
- No stamina mutation interface and no RPC protocol bump.
- Release version becomes exactly `2026.7.58-jd`; protocol remains `3`.
- Do not modify `package-lock.json`, the user's `CLAUDE.md`, or untracked CSV artifacts.

---

### Task 1: Pure RAM semantics and stable result types

**Files:**
- Create: `src/nhl94-lines.ts`
- Create: `tests/nhl94_lines.test.mjs`

**Interfaces:**
- Produces: `lineSelection(raw)`, `energyValue(raw)`, `averageEnergy(values)`, `decodeStatus(raw)`, `decodeLoadedPlayer(raw)`, `buildRamResult(detail, rawSnapshot, ramDomain)`, and exported result interfaces.
- Consumes: NHL slot base/stride constants from `src/nhl94.ts`.

- [ ] **Step 1: Write failing pure tests**

Add tests asserting:

```js
assert.deepEqual(lineSelection(4), { raw: 4, label: "PP2" });
assert.deepEqual(energyValue(0x1200), { raw: 0x1200, percent: 112.5 });
assert.deepEqual(averageEnergy([]), { raw: null, percent: null, contributors: 0 });
assert.equal(decodeStatus(0xfffe).label, "bench_recovery_state");
```

Build a 12-entity snapshot fixture covering a goalie at position `0`, invalid
index `0xFF`, duplicate loaded indices, an off-ice `0xFFFF` position, and a
pending desired index. Assert invalid indices produce null energy/status and no
unchecked table lookup; current occupants determine averages.

- [ ] **Step 2: Run the tests and verify RED**

Run: `npm run build && node --test tests/nhl94_lines.test.mjs`

Expected: failure because `dist/nhl94-lines.js` does not exist.

- [ ] **Step 3: Implement minimal RAM decoding**

Create typed constants and functions for the exact widths/sentinels in the
design. Percentages round to two decimals; averages retain the unrounded raw
quotient. Count loaded entities with position `0..5`, preserve duplicate
diagnostics, and represent desired/current indices separately.

- [ ] **Step 4: Run focused tests and verify GREEN**

Run: `npm run build && node --test tests/nhl94_lines.test.mjs`

Expected: all Task 1 tests pass.

### Task 2: Bounded retail-compatible ROM parser

**Files:**
- Modify: `src/nhl94-lines.ts`
- Modify: `tests/nhl94_lines.test.mjs`
- Create: `scripts/verify-nhl94-lines-rom.mjs`

**Interfaces:**
- Produces: `parseTeamStructure(bytes, pointer)`, `attachRomDetail(result, teams, detail, diagnostics)`, parser layout constant `nhl94-retail-roster-v1`.
- Consumes: team-structure spans fetched by the tool layer.

- [ ] **Step 1: Write failing parser tests**

Generate a sanitized team buffer using the exact grammar:

```text
+0x00=0x0092, +0x02=0x000C, +0x04=rosterEnd
+0x52 eight [G,LD,RD,LW,C,RW,EA,0] rows
records [u16 nameFieldLength][ASCII+NUL padding][8 attributes]
```

Assert combined 1-based member indices resolve across goalie and skater
records; `EA=0` becomes null; configured averages count six positions and count
duplicates by position. Add malformed length, nonzero pad, out-of-range member,
zero standard member, non-ASCII name, and span-over-4096 cases.

- [ ] **Step 2: Run focused tests and verify RED**

Run: `npm run build && node --test tests/nhl94_lines.test.mjs`

Expected: parser exports/behaviors are missing.

- [ ] **Step 3: Implement the parser**

Parse only validated bounded buffers. Enforce first-record/header constants,
ASCII/padding rules, leading goalie run, combined record indices, and line
position kinds. Return structured parser errors rather than guessed data.

- [ ] **Step 4: Add the optional real-ROM verifier**

The script reads `/mnt/8tb/jason/nvnhl94-2/rom/nhl94.gen` when present,
validates SHA-256, parses MTL index 11, and asserts MTL Sc1 includes Patrick Roy
at G and Kirk Muller at C. If absent, print a skip reason and exit zero.

- [ ] **Step 5: Run parser tests and local integration**

Run:

```bash
npm run build
node --test tests/nhl94_lines.test.mjs
node scripts/verify-nhl94-lines-rom.mjs
```

Expected: pure tests pass and the available local retail ROM verifies.

### Task 3: MCP tool, state integration, and agent guidance

**Files:**
- Modify: `src/tools.ts`
- Modify: `src/nhl94.ts`
- Modify: `tests/nhl94_tools.test.mjs`
- Modify: `tests/tool_surface.test.mjs`
- Modify: `tests/nhl94.test.mjs`

**Interfaces:**
- Produces: public `nhl94_lines` MCP tool and `nhl94_state` section `lines`.
- Consumes: Task 1/2 result builders and parsers.

- [ ] **Step 1: Write failing catalog and tool tests**

Assert:

- `nhl94_lines` is exposed with required `target` and detail enum.
- Default detail performs one RAM `read_many`, no ROM reads, and returns summary JSON.
- `on_ice` returns 12 entries and still performs one RAM dispatch.
- `lines`/`roster` use `get_info`, exact `MD CART`, bounded `read_range`, and cumulative data.
- Missing/malformed ROM returns `complete:false` with RAM output.
- No-active-game returns `available:false`.
- `nhl94_state` compact output contains selected-line/on-ice average summary.
- `sections:["lines"]` adds shared per-entity stamina semantics.
- Descriptions and recipes route detail levels and warn that `pnum` is an index.

- [ ] **Step 2: Run focused tests and verify RED**

Run:

```bash
npm run build
node --test tests/nhl94_tools.test.mjs tests/tool_surface.test.mjs tests/nhl94.test.mjs
```

Expected: missing tool/schema/section assertions fail.

- [ ] **Step 3: Implement MCP routing**

Add the schema, tool surface entry, handler, ROM cache, exact domain discovery,
pointer/header/span reads, JSON serialization, and partial ROM errors. Add all
RAM reads—including 12 current/desired/position fields, both 26-entry
energy/status tables, identities, lines, session, and frame counter—to one
`read_many`.

- [ ] **Step 4: Integrate state and descriptions**

Add `lines` to state sections, reuse the same decoders/field names, append the
compact summary always, and append on-ice detail only when requested. Update
`nhl94_recipes`, `nhl94_state`, `nhl94_read`, and `nhl94_fields` descriptions.

- [ ] **Step 5: Run focused tests and verify GREEN**

Run the focused command from Step 2.

Expected: all focused tests pass.

### Task 4: Lua OSD stamina correction and line summary

**Files:**
- Modify: `lua/bridge_JD.lua`
- Modify: `tests/osd_helpers.test.lua`

**Interfaces:**
- Produces: Lua helpers for validated player energy and per-team on-ice average.

- [ ] **Step 1: Write failing Lua behavioral tests**

Load the OSD helper test harness with fake memory and assert:

- carrier `pnum=9`, energy table value `0x0E00` displays `en3584`, not `en9`
- no carrier displays `en--`
- invalid lineup index displays `en??`
- energy `0x1200` remains `4608`
- team average includes goalie position `0` and excludes position `0xFFFF`

- [ ] **Step 2: Run Lua tests and verify RED**

Run: `lua5.4 tests/osd_helpers.test.lua`

Expected: the energy-table assertions fail because OSD currently displays
entity `+0x66`.

- [ ] **Step 3: Implement Lua helpers and OSD row**

Add validated `player_energy(team, lineupIndex)` and
`team_on_ice_average(team)` helpers, correct carrier `en`, expand line labels
through PP/PK, and add the compact home/away line/average row with exact safety
tokens.

- [ ] **Step 4: Run Lua verification**

Run:

```bash
lua5.4 tests/osd_helpers.test.lua
luac -p lua/bridge_JD.lua
```

Expected: behavioral tests pass and Lua syntax is valid.

### Task 5: Version, full verification, deployment, and local commits

**Files:**
- Modify: `src/version.ts`
- Modify: `package.json`
- Modify: `lua/bridge_JD.lua`
- Modify: `CHANGELOG.md`

**Interfaces:**
- Produces: release `2026.7.58-jd`, built daemon, restarted service.

- [ ] **Step 1: Add version assertions or update existing fixtures**

Ensure tests/catalog expect `2026.7.58-jd` and protocol `3`.

- [ ] **Step 2: Bump versions and release notes**

Change server/package/Lua versions to `2026.7.58-jd`, add the Lua top changelog
entry and repository changelog entry, and leave `package-lock.json` untouched.

- [ ] **Step 3: Run fresh full verification**

Run:

```bash
npm test
npm run build
luac -p lua/bridge_JD.lua
lua5.4 tests/osd_helpers.test.lua
node scripts/verify-nhl94-lines-rom.mjs
git diff --check
```

Expected: every command exits zero.

- [ ] **Step 4: Commit only scoped files**

Review `git status`, stage only plan/feature/test/version/changelog files, and
commit with a descriptive local message. Do not stage `CLAUDE.md` or CSV files.

- [ ] **Step 5: Restart and verify the multiplex daemon**

Run:

```bash
systemctl --user restart bizhawk-daemon-multiplex.service
systemctl --user status bizhawk-daemon-multiplex.service --no-pager -l
```

Then query the live MCP endpoint or process startup log and confirm server
version `2026.7.58-jd`.

- [ ] **Step 6: Final repository verification**

Run `git status --short`, `git log -5 --oneline`, and the version query again.
Confirm only the user's pre-existing unrelated files remain dirty.
