# NHL '94 Lines and Stamina Visibility Design

## Goal

Give agents complete, semantic, read-only visibility into NHL '94 selected
lines, currently loaded personnel, configured line membership, full rosters,
and live stamina without making ordinary state snapshots excessively large.

## Public interface

Add a dedicated `nhl94_lines` tool with a required `target` and an optional
`detail` enum. Detail levels are cumulative:

- `summary` (default): selected line and average on-ice stamina for home and
  away.
- `on_ice`: summary plus all 12 loaded skater slots, including team, current
  lineup index, desired lineup index during a pending personnel swap, position,
  raw energy, percentage, and decoded status.
- `lines`: on-ice data plus all eight configured personnel rows for each team:
  `NLC`, `Sc1`, `Sc2`, `Chk`, `PP1`, `PP2`, `PK1`, and `PK2`. Each row reports
  position-to-player membership and average live stamina.
- `roster`: line data plus every roster record for both teams, including name,
  lineup index, goalie/skater kind, live energy, decoded status, whether the
  player is currently loaded, and all configured line memberships.

The default intentionally remains small. Agents must explicitly request the
larger `on_ice`, `lines`, or `roster` levels.

`nhl94_state` gains a compact, always-present line/stamina summary. Its optional
`lines` section adds the equivalent of `nhl94_lines detail:"on_ice"` without
including ROM-backed configured lines or full rosters. The dedicated tool is
the route for deeper inspection.

No stamina or roster mutation interface is added.

## Data model and sources

The server reads authoritative live values from NHL '94 RAM:

- Home team block: `0xFFC6CE`
- Away team block: `0xFFCA32`
- Selected line: home `0xFFC6E5`, away `0xFFCA48`
- Energy entry: `teamBase + 0x32 + lineupIndex*2`
- Status entry: `teamBase + 0x66 + lineupIndex*2`
- Loaded-slot lineup index: skater entity `+0x66`
- Desired lineup index during a change: skater entity `+0x61`
- Line position: skater entity `+0x34`
- Team identity: home `0xFFC330`, away `0xFFC332`

Energy is an unsigned 16-bit scalar where `0x1000` is 100%. Output always
includes the raw value and a percentage so callers can preserve exact evidence
while humans get an immediately readable value. Values above `0x1000` remain
visible rather than being silently clamped.

Status words decode as:

- `0xFFFF`: on ice
- `0xFFFE`: benched and recovery-eligible
- Any other value: `unknown`, with the raw word retained

Configured-line and roster detail comes from the loaded teams' ROM records:

- Read the team pointer from the 28-entry big-endian table at ROM `0x30E`.
- Validate the selected team index and pointer.
- Parse the team structure boundaries at `+0x00` and `+0x04`.
- Parse the eight 8-byte line rows at `+0x52`.
- Parse variable-length goalie/skater records beginning at `+0x92`.
- Resolve each 1-based line member to the corresponding zero-based roster
  record.

The parser validates bounds, record lengths, ASCII names, line indices, and
record termination. If the active ROM does not match the decoded retail
layout, `detail:"lines"` and `detail:"roster"` return an actionable unsupported
ROM/layout error rather than guessed data. `summary` and `on_ice` remain
RAM-only and do not depend on ROM parsing.

## Line semantics

Expand selected-line decoding:

- `0`: `Sc1`
- `1`: `Sc2`
- `2`: `Chk`
- `3`: `PP1`
- `4`: `PP2`
- `5`: `PK1`
- `6`: `PK2`
- Other values: `unknown(raw)`

The ROM configuration's row zero is `NLC`; it is a configured personnel row,
not a selected-line byte label.

Line averages use the unique roster members configured in that row. The goalie
is included because goalies have live energy and drain through the same retail
mechanism. Output identifies the six standard positions (`G`, `LD`, `RD`,
`LW`, `C`, `RW`) plus the `EA` extra-attacker entry separately. The average
uses the six standard on-ice positions; `EA` is shown but excluded unless it is
actually loaded due to a pulled-goalie situation, which is visible in
`on_ice`.

The team on-ice average uses loaded slots whose live line position is
non-negative/on-ice. Pending swaps show both current and desired roster indices
so transient bench changes are not misreported as settled personnel.

## Implementation structure

Create a focused `src/nhl94-lines.ts` module responsible for:

- NHL team-block constants and line labels
- Energy/status decoding and percentage formatting
- Team/slot snapshot assembly from already-read RAM values
- Retail ROM team, roster, and line-config parsing
- Text formatting for each cumulative detail level

`src/tools.ts` owns MCP schemas, bridge reads, detail routing, and integration
with `nhl94_state`. Existing NHL domain detection remains the authority for RAM
reads. ROM reads explicitly use the Genesis cartridge domain discovered from
the backend's memory-domain list; the tool must not assume RAM and ROM share a
domain or address base.

The implementation may use multiple bounded reads for `lines` and `roster`,
but must avoid one bridge round-trip per player. It should read team headers
first, then fetch each validated team-structure span in one read.

## Lua OSD

Correct the carrier rating row so `en` reads the actual team energy table using
the carrier slot's team and lineup index. It must no longer label entity
`+0x66` as energy.

Add one compact team line/stamina row showing each team's decoded selected line
and current on-ice average energy. This is display-only and does not change the
bridge RPC contract.

## Agent guidance

Update tool descriptions and `nhl94_recipes` with explicit routing:

- Use `nhl94_state` for ordinary game-state verification and its compact
  selected-line/stamina summary.
- Use `nhl94_lines` with default `summary` when the question is simply which
  lines are selected or how tired each team is.
- Request `detail:"on_ice"` for current slot personnel and individual stamina.
- Request `detail:"lines"` only for configured line composition and candidate
  line freshness.
- Request `detail:"roster"` only when every roster player, name, status, and
  membership is needed.
- Do not infer stamina from `pnum`; it is a lineup index used to locate the
  separate energy table.
- Prefer this semantic tool over manually deriving team-block or ROM
  addresses.

Related descriptions for `nhl94_state`, `nhl94_read`, and `nhl94_fields` must
point to `nhl94_lines` for table-backed stamina and roster questions.

## Errors and compatibility

- Unknown `detail` values fail schema validation.
- RAM-only levels report unknown/raw values rather than hiding unexpected
  states.
- ROM-backed levels fail clearly on a missing cartridge domain, invalid team
  index, invalid pointer, malformed record, or out-of-range line member.
- Existing `nhl94_state` sections and output remain compatible; the compact
  summary is additive.
- The RPC framing and bridge command shapes do not change, so protocol remains
  `3`.

## Versioning and deployment

Bump all release strings from `2026.7.57-jd` to `2026.7.58-jd`:

- `src/version.ts`
- `package.json`
- `lua/bridge_JD.lua`, including a top-of-file changelog entry

Do not modify `package-lock.json` or the RPC protocol number.

Build `dist/`, restart `bizhawk-daemon-multiplex.service`, and verify the
running daemon reports `2026.7.58-jd`. The Lua source is updated in place; live
BizHawk instances may require script reload to display the new OSD.

## Testing and verification

Follow test-first development:

1. Pure tests for all line labels, energy/status decoding, percentage
   formatting, ROM team parsing, line membership, malformed layouts, and line
   averages.
2. MCP tool tests for all four cumulative detail levels, default behavior,
   bounded bridge reads, RAM-only operation, ROM errors, pending swaps, and
   agent-facing descriptions.
3. `nhl94_state` tests for the compact summary and optional on-ice section.
4. Lua syntax validation and focused OSD tests/static assertions proving `en`
   uses the energy table rather than entity `+0x66`.
5. Full `npm test`, `npm run build`, and `luac -p lua/bridge_JD.lua`.
6. Restart the multiplex daemon, inspect its status, and query its running
   version.

The final implementation commit must exclude the user's existing unrelated
`CLAUDE.md` modification and untracked CSV artifacts.
