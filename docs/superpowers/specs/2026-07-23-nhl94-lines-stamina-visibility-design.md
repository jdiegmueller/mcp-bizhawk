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
- `on_ice`: summary plus all 12 loaded player entities—six per team, including
  the goalie. Each entry includes team, current lineup index, desired lineup
  index during a pending personnel swap, position, raw energy, percentage, and
  decoded status.
- `lines`: on-ice data plus all eight configured personnel rows for each team:
  `NLC`, `Sc1`, `Sc2`, `Chk`, `PP1`, `PP2`, `PK1`, and `PK2`. Each row reports
  position-to-player membership and average live stamina.
- `roster`: line data plus every roster record for both teams, including name,
  lineup index, goalie/skater kind, live energy, decoded status, whether the
  player is currently loaded, and all configured line memberships.

The default intentionally remains small. Agents must explicitly request the
larger `on_ice`, `lines`, or `roster` levels.

`nhl94_state` gains a compact, always-present line/stamina summary. Its optional
`lines` section emits both the same compact summary and the same `onIce` entity
objects as `nhl94_lines detail:"on_ice"`, formatted into the existing state
text. It does not include ROM-backed configured lines or full rosters. The
dedicated tool is the route for deeper inspection.

No stamina or roster mutation interface is added.

## Stable result contract

`nhl94_lines` returns a JSON document as text content. Formatting is secondary
to the typed internal result. The top-level shape is:

```json
{
  "detail": "summary",
  "complete": true,
  "available": true,
  "snapshot": {
    "frame": 12345,
    "ramDomain": "M68K BUS"
  },
  "summary": {
    "home": {},
    "away": {}
  },
  "onIce": null,
  "configuredLines": null,
  "rosters": null,
  "rom": null,
  "romError": null
}
```

Fields above the requested detail remain `null` rather than being silently
omitted. `onIce` is `null` at `summary`, not an empty array. A requested
ROM-backed level that cannot be decoded returns the valid RAM sections,
`complete:false`, `rom:null`, and a structured `romError`; it does not fail the
whole tool or discard RAM evidence.

Every selected line retains evidence:

```json
{"raw": 1, "label": "Sc2"}
```

Every individual energy value is:

```json
{"raw": 3584, "percent": 87.5}
```

An average is:

```json
{"raw": 3515.3333333333335, "percent": 85.82, "contributors": 6}
```

Average arithmetic uses unrounded raw values. `raw` preserves the JavaScript
numeric quotient; `percent` is `(raw / 4096) * 100`, rounded to two decimal
places using ordinary nearest rounding. Individual percentages use the same
rule, so insignificant trailing zeroes are naturally absent in JSON. Values
above `0x1000` are not clamped. With zero valid contributors, `raw` and
`percent` are `null` and `contributors` is `0`; zero energy is a valid numeric
zero, not missing data.

## Data model and sources

The server reads authoritative live values from NHL '94 RAM:

- Home team block: `0xFFC6CE`
- Away team block: `0xFFCA32`
- Selected line: home `0xFFC6E5`, away `0xFFCA48`, each `u8`
- Energy entry: `teamBase + 0x32 + lineupIndex*2`, `u16_be`
- Status entry: `teamBase + 0x66 + lineupIndex*2`, `u16_be`
- Current lineup index: player entity `+0x66`, `u8`; valid range `0..25`
- Desired lineup index during a change: player entity `+0x61`, `u8`; valid
  range `0..25`, inactive/settled sentinel `0xFF`
- Line position: player entity `+0x34`, `u16_be`; on-ice positions are exactly
  `0..5` (`G`, `LD`, `RD`, `LW`, `C`, `RW`), and `0xFFFF` is off ice
- Team identity: home `0xFFC330`, away `0xFFC332`, each `u16_be`; valid range
  `0..27`
- VBlank frame counter: `0xFFB03E`, `u32_be`

Home identity and away identity are indices into the 28-entry ROM team-pointer
table at cartridge offset `0x30E`. An identity outside `0..27` is never used to
calculate a ROM address.

Energy is an unsigned 16-bit scalar where `0x1000` is 100%. Output always
includes the raw value and a percentage so callers can preserve exact evidence
while humans get an immediately readable value. Values above `0x1000` remain
visible rather than being silently clamped.

Status words decode as:

- `0xFFFF`: on ice
- `0xFFFE`: `bench_recovery_state`
- Any other value: `unknown`, with the raw word retained. This is deliberate:
  penalty, injury, and transient values are not yet fully enumerated and are
  evidence, not parser errors.

The `0xFFFE` meaning is ROM-verified by the recovery routine at `0x79F8`, which
adds energy only to entries with that exact status. The user-facing label is
`bench_recovery_state` to avoid asserting more physical-location detail than
the status word alone proves.

For each loaded entity:

```text
pendingSwap =
  desiredLineupIndex is in 0..25
  AND desiredLineupIndex != currentLineupIndex
```

`desiredLineupIndex == 0xFF` means no requested replacement. Other invalid
desired values produce `decodeError:"invalid_desired_lineup_index"` and
`pendingSwap:false`. An invalid current index never reaches address arithmetic;
the entity instead returns:

```json
{
  "currentLineupIndex": 255,
  "energy": null,
  "status": null,
  "decodeError": "invalid_lineup_index"
}
```

Team on-ice averages count valid loaded entities whose decoded `position` is
exactly `0..5`. They count entities, not unique lineup indices, so a pulled
goalie replacement naturally contributes while the off-ice goalie does not.
During a personnel change, the current occupant's energy is used until the
replacement actually occupies the entity. Invalid-index and off-ice entities
are excluded, the contributor count is returned, and duplicate current lineup
indices are counted but surfaced in a `duplicateCurrentLineupIndices` diagnostic.

If either team identity is invalid or no loaded entity has a valid current
lineup index, the result is a successful non-game response:

```json
{
  "complete": true,
  "available": false,
  "unavailableReason": "no_active_game"
}
```

No selected line, energy, or roster value is decoded from menu garbage. The
session/phase byte is retained as context but is not the sole availability
gate, because valid line and stamina state also exists during faceoffs and
intermissions.

Configured-line and roster detail comes from the loaded teams' ROM records:

- Select the exact cartridge domain name `MD CART`. If it is absent, ROM detail
  is unavailable; do not guess among other cartridge-like domain names.
- Read the team pointer from the 28-entry table at cartridge-domain offset
  `0x30E`. Each entry is a 4-byte big-endian absolute file/domain offset. No
  68000 bus normalization is applied.
- Index that table with the validated home/away identity word (`0..27`).
- Read and validate the team header, then read only its bounded validated span.

The complete supported byte grammar is copied from
`nvnhl94-2/docs/rom-reference/roster-format.md`, sections “Team pointer table,”
“Region table,” “Line config,” and “Records”:

```text
team P+0x00: u16_be firstRecordOffset; retail/layout-compatible value 0x0092
team P+0x02: u16_be structural constant 0x000C
team P+0x04: u16_be stringBlockOffset, relative to P
team P+0x06..0x0B: six engine-default bytes 00 52 00 4C 00 50
team P+0x52..0x91: eight rows × eight bytes
team P+firstRecordOffset: variable roster records
team P+stringBlockOffset: team string block; exclusive roster boundary

line row bytes: [G, LD, RD, LW, C, RW, EA, pad]
line row order: [NLC, Sc1, Sc2, Chk, PP1, PP2, PK1, PK2]
member value: 1-based index into the single combined record array
              (goalies first, then skaters); 0 means empty
pad byte: 0x00

record:
  nameFieldLength: u16_be, includes its own two-byte length word
  namePayload: nameFieldLength - 2 bytes, printable ASCII plus optional
               trailing NUL padding; strip trailing NULs
  attributes: exactly 8 bytes
  recordSpan: nameFieldLength + 8 bytes

goalie discriminator: attributes[5] == 0x00
record termination: cursor reaches stringBlockOffset, or a zero length word
                    begins padding and every remaining byte before
                    stringBlockOffset is zero
```

`nameFieldLength` must be at least 2, even, and contained within the roster
boundary. Non-padding name bytes must be printable ASCII. Leading goalie
records form one contiguous run. Standard line positions must resolve to
non-empty in-range members of the appropriate kind (`G` goalie; `LD` through
`RW` skaters). `EA=0` is legitimate and becomes `null`; any other zero standard
position or out-of-range member yields a structured layout error.

The parser caps `stringBlockOffset` and each team read span at 4096 bytes, the
existing bridge `read_range` limit, before issuing the span read. It also
validates pointer arithmetic as a safe non-negative integer. A corrupt boundary
can therefore never trigger an unbounded cartridge read.

Compatibility is layout-based, not hash-gated: roster hacks that retain this
grammar are supported. Parser diagnostics include the exact cartridge domain,
the bridge-reported ROM hash, parser layout version `nhl94-retail-roster-v1`,
team identities, team pointers, and validated team-span sizes. The existing
bridge does not expose cartridge-domain size; adding that field solely for
diagnostics would change the bridge API, so this release does not claim a
detected ROM size. Known retail reference hashes are CRC32 `9438F5DD`, MD5
`8356B3F0D091B9CC441E2FF8721AD063`, and SHA-256
`ccc0298c118d580863c877abd470c71186ef0a1b60f1e7c6ff1e5a38f48fd053`,
but they are diagnostic evidence rather than an allowlist.

If the active ROM does not match the decoded layout, `detail:"lines"` and
`detail:"roster"` return `complete:false`, all valid RAM data, and an actionable
`romError` such as `missing_cartridge_domain`, `invalid_team_identity`,
`invalid_team_pointer`, `span_too_large`, or `unsupported_layout`.
`summary` and `on_ice` remain RAM-only.

## Line semantics

Expand selected-line decoding:

- `0`: `Sc1`
- `1`: `Sc2`
- `2`: `Chk`
- `3`: `PP1`
- `4`: `PP2`
- `5`: `PK1`
- `6`: `PK2`
- Other values: label `unknown`, with the raw byte retained in the selected-line
  object

The ROM configuration's row zero is `NLC`; it is a configured personnel row,
not a selected-line byte label.

Each configured row returns `configuredAverage`, calculated from the six
position entries `G`, `LD`, `RD`, `LW`, `C`, and `RW`. The denominator is valid
positions, not unique players. A duplicate member therefore contributes once
for each configured position and is also reported in
`duplicateConfiguredLineupIndices`. The result always includes its contributor
count. `EA` is returned separately as `extraAttacker`, with that player's live
energy when non-empty, and never changes `configuredAverage`.

This configured-row metric is intentionally distinct from `onIceAverage`,
which counts the valid player entities actually on ice at the RAM snapshot.
That rule handles pulled goalies, incomplete bench transitions, and temporary
entity duplication without mixing current live state into candidate-line
freshness.

On-ice entries distinguish:

- `currentLineupIndex`: player currently occupying the entity
- `desiredLineupIndex`: requested replacement, or `null` for `0xFF`
- `pendingSwap`: decoded boolean

Roster entries expose `currentlyLoadedInSlots` and `desiredBySlots` as arrays
of entity labels. A desired replacement is not reported as currently loaded.

## Implementation structure

Create a focused `src/nhl94-lines.ts` module responsible for:

- NHL team-block constants and line labels
- Energy/status decoding and percentage formatting
- Team/slot snapshot assembly from already-read RAM values
- Retail ROM team, roster, and line-config parsing
- Stable result types, JSON serialization, and shared state-text formatting

`src/tools.ts` owns MCP schemas, bridge reads, detail routing, and integration
with `nhl94_state`. Existing NHL domain detection remains the authority for RAM
reads. ROM reads explicitly use the Genesis cartridge domain discovered from
the backend's memory-domain list; the tool must not assume RAM and ROM share a
domain or address base.

For `nhl94_lines`, all RAM fields needed for summary and on-ice output are sent
in one existing `read_many` RPC. `read_many` already accepts an explicit
`domain` on every read specification and executes the full loop within one Lua
command dispatch without advancing emulation. The RAM result is therefore one
same-frame snapshot and includes the VBlank frame counter for evidence. No new
bridge command or command field is required, so protocol `3` remains correct.

`nhl94_state` continues to use its canonical `read_struct_array` entity
snapshot plus globals read rather than independently rescanning entities.
Line/stamina decoding is shared with `nhl94_lines`, so field names and semantics
stay identical. Because the existing state tool uses more than one bridge
dispatch, its combined snapshot remains explicitly best-effort/non-atomic; the
dedicated `nhl94_lines` tool is the authoritative same-frame answer for line
transitions.

ROM detail uses the already-existing arbitrary-domain `read_range` RPC:

1. Read the pointer table/header fields with bounded reads.
2. Validate both team headers and spans.
3. Fetch each team span in one `read_range` call, never one call per player.

Parsed team structures are cached by `target + ROM hash + team identity +
parser-layout-version`. A changed ROM hash or team identity naturally misses
the cache; reconnects may retain the safe static ROM parse because the hash is
part of the key.

## Lua OSD

Add a small Lua helper that reads player energy from a validated team plus
lineup index. Correct the carrier rating row so `en` calls that helper using the
carrier entity's team and current lineup index. It must no longer label entity
`+0x66` as energy.

Add one compact team line/stamina row showing each team's decoded selected line
and current on-ice average energy. This is display-only and does not change the
bridge RPC contract.

OSD safety behavior is exact:

- No carrier: `en--`
- Invalid carrier/team: `en??`
- Invalid lineup index: `en??`
- Energy above `0x1000`: display the raw value without clamping
- No valid team-average contributors: display `--`

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
- ROM-backed levels retain RAM output and set `complete:false` plus structured
  `romError` on a missing cartridge domain, invalid team index, invalid
  pointer, malformed record, or out-of-range line member.
- Existing `nhl94_state` sections and output remain compatible; the compact
  summary is additive.
- Existing `read_many` and `read_range` already accept arbitrary explicit
  memory domains. RPC framing and bridge command shapes do not change, so
  protocol remains `3`.

## Versioning and deployment

Bump all release strings from `2026.7.57-jd` to `2026.7.58-jd`:

- `src/version.ts`
- `package.json`
- `lua/bridge_JD.lua`, including a top-of-file changelog entry

Do not modify `package-lock.json` or the RPC protocol number.

The lockfile was inspected during design review: its root version is already
the intentionally stale `2026.7.53-jd` while the current release is
`2026.7.57-jd`. Project instructions explicitly exclude it from the display
release scheme, so leaving it unchanged preserves the established convention
rather than introducing a new inconsistency.

Build `dist/`, restart `bizhawk-daemon-multiplex.service`, and verify the
running daemon reports `2026.7.58-jd`. The Lua source is updated in place; live
BizHawk instances may require script reload to display the new OSD.

## Testing and verification

Follow test-first development:

1. Pure tests for all line labels, energy/status decoding, percentage
   formatting, ROM team parsing, line membership, malformed layouts, and line
   averages. Explicit cases cover no contributors (`null`, not zero),
   over-100% energy, duplicate configured members, and duplicate loaded
   indices.
2. MCP tool tests for all four cumulative detail levels, default behavior,
   bounded bridge reads, RAM-only operation, ROM errors, pending swaps, and
   agent-facing descriptions. A transition fixture keeps current and desired
   indices distinct while both referenced roster entries have valid
   energy/status.
3. `nhl94_state` tests for the compact summary and optional on-ice section.
4. Lua syntax validation and a focused behavioral Lua helper test proving `en`
   resolves through the team energy table rather than treating entity `+0x66`
   as the value.
5. Full `npm test`, `npm run build`, and `luac -p lua/bridge_JD.lua`.
6. Restart the multiplex daemon, inspect its status, and query its running
   version.

Committed ROM parser tests use small generated/sanitized structures for
malformed and boundary cases and a generated successful structure following
the exact grammar above. They do not ship copyrighted ROM bytes. A local
integration test reads the actual available `nhl94.gen`, verifies its known
hash/layout and at least one known line-to-name mapping, and skips with an
explicit reason when that ROM is absent. The implementation run for this
release must execute that integration test locally. Tests also enforce the
4096-byte maximum validated team span before any cartridge range read.

The final implementation commit must exclude the user's existing unrelated
`CLAUDE.md` modification and untracked CSV artifacts.

## Acceptance criteria

For a paused known retail game, `nhl94_lines detail:"on_ice"` identifies all
twelve loaded player entities, including both goalies, and reports energies
matching direct team-table reads from the same command dispatch. During a
pending line change, current and desired lineup indices remain distinct and
the current occupant supplies the on-ice energy.

For a layout-compatible ROM, every non-empty configured line member resolves
to the correct combined roster record. `configuredAverage` follows the exact
six-position, position-denominator rule and reports its contributor count and
any duplicates. `EA` remains separate.

Invalid current indices never generate energy-table addresses. No-contributor
averages are null, over-full energy remains visible, menu/no-game state does
not produce decoded garbage, and unsupported ROM layouts retain valid RAM data
without returning guessed roster or line content.

The tool catalog and `nhl94_recipes` direct agents toward the lowest sufficient
detail level and explicitly warn that `pnum`/entity `+0x66` is an index, not
stamina.
