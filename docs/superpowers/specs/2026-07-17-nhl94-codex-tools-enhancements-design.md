# NHL94 Codex tool-flow enhancements

## Problem

Recent agent transcripts show a consistent failure pattern in NHL94 reverse
engineering sessions: agents escape from the game-semantic `nhl94_*` tools to
raw BizHawk reads, raw Lua writes, and hand-built trap captures whenever an
experiment needs exact staging, uncommon fields, conditional forcing, or rich
exec-trap context.

That escape path is where the mistakes happen:

- hand-computed M68K bus addresses and hex/decimal conversions get fat-fingered;
- vision and coarse heuristics overrule stronger RAM evidence;
- `nhl94_teleport` render-settle behavior can race precise RE staging;
- agents use `bizhawk_eval_lua` to reassert fields every frame because no
  semantic field/override tool exists;
- agents construct native trap capture tokens by hand, including register-relative
  offsets and widths;
- line-change / pre-faceoff mode is currently collapsed into a generic
  faceoff/stoppage phase, even though retail RAM has a clean detector.

The goal is not to hide native BizHawk. Disassembly, ROM search, ordinary frame
advance, input playback, and raw traps are still valid emulator-level operations.
The goal is to make NHL94 RAM mutation, staging, field reads, and common trap
captures semantic enough that agents choose the safer tool first.

## Approved Approach

Use guarded semantic RE support: add a small set of NHL94-aware tools and
enhance existing `nhl94_state`, `nhl94_read`, `nhl94_unfreeze`, and
`nhl94_recipes` guidance.

This was chosen over minimal hardening because the transcripts show real needs
for exact staging and bounded field forcing. It was chosen over a high-level
experiment DSL because RE workflows are still exploratory; hiding too much of
the emulator would make the tool brittle.

## Scope

Add or enhance these NHL94 surfaces:

- `nhl94_state`: add RAM-backed line-change / pre-drop detection and selected
  line reporting.
- `nhl94_fields`: semantic read/write/freeze/unfreeze for known entity fields
  and globals.
- `nhl94_stage`: atomic experiment setup for rigs, placement, possession,
  selected field writes/freezes, and readback.
- `nhl94_trap_exec`: NHL94-aware wrapper over native exec traps with hex PCs,
  register-bound roles, and semantic captures.
- `nhl94_exec_override`: bounded one-shot and persistent hooks for controlled
  per-frame or PC-hit forcing.
- `nhl94_read`: improve compact selected entity/global snapshots.
- `nhl94_unfreeze`: keep `all:true` canonical; optionally accept `"ALL"` as a
  discoverability alias if it can be implemented without ambiguity.
- `nhl94_recipes`: update the primer around the preferred experiment lifecycle,
  cleanup flow, raw-offset policy, and native-tool escape hatches.

Out of scope:

- wrapping `bizhawk_disassemble`, ROM search, RAM snapshots, ordinary frame
  advance, or input playback;
- replacing native `bizhawk_trap_exec` for unsupported non-NHL94 captures;
- a general experiment DSL;
- goalie- or roster-specific abstractions beyond the current slot model.

## Field Dictionary

The shared NHL94 resolver is part of the API contract. This table documents the
field names, offsets, widths, signedness, units, and encodings that prevent
agents from guessing addresses and widths.

Authoritative implementation source: `src/nhl94.ts`, reconciled with
`lua/bridge_JD.lua` `TRACE_FIELDS` / `TRACE_G` and the retail ROM docs.

ROM scope for newly decoded faceoff/line-change globals: exact retail
`nhl94.gen`, MD5 `8356B3F0D091B9CC441E2FF8721AD063`. Do not assume other ROM
regions or revisions until verified.

Conventions:

- All addresses are M68K bus addresses and all multi-byte values are big-endian.
- Entity offsets are relative to the entity base.
- Skaters `s0-s11` use base `0xFFB04A + slot * 0x80`.
- Puck `pk` uses slot 14, base `0xFFB74A`.
- Position fields are 16.16 signed fixed-point longwords. Tool inputs use whole
  pixels and write the corresponding fixed-point value.
- Velocity fields are raw signed 16-bit game units. They are not whole pixels
  and are not scaled by the tool.
- `fdir` is a direction index. Range and direction-to-compass mapping still
  need a ROM-doc verification pass before user-facing names are added.

Entity fields:

| Field | Offset | Width | Signed | Units / Encoding | Notes |
|---|---:|---|---|---|---|
| `x` | `0x00` | `s32_be` | yes | 16.16 position, whole-pixel API | X coordinate |
| `y` | `0x14` | `s32_be` | yes | 16.16 position, whole-pixel API | Y coordinate |
| `z` | `0x18` | `s32_be` | yes | 16.16 height, whole-unit API | Puck/skater height |
| `xv` | `0x28` | `s16_be` | yes | raw velocity word | No position scaling |
| `yv` | `0x2A` | `s16_be` | yes | raw velocity word | No position scaling |
| `zv` | `0x2C` | `s16_be` | yes | raw velocity word | No position scaling |
| `frame` | `0x06` | `u16_be` | no | resolved sprite frame | Existing state/read field |
| `attr` | `0x04` | `u16_be` | no | sprite attributes | Includes flip bits |
| `fdir` | `0x54` | `u16_be` | no | direction index | Direction mapping unverified |
| `anim` | `0x58` | `u16_be` | no | animation selector | Existing state/read field |
| `spanum` | `0x5A` | `u16_be` | no | SPA record offset | Existing read field |
| `spacnt` | `0x5C` | `s16_be` | yes | animation dwell countdown | Existing read field |
| `impact` | `0x32` | `s16_be` | yes | body-check accumulator | Existing verbose/read field |
| `impactp` | `0x2E` | `s16_be` | yes | prior/body-check accumulator | Existing verbose/read field |
| `pos` | `0x34` | `u16_be` | no | state/position word | Existing verbose/read field |
| `lockout` | `0x5E` | `u8` | no | lockout / no-puck timer | Alias for existing `nopuck` |
| `nopuck` | `0x5E` | `u8` | no | lockout / no-puck timer | Keep for compatibility |
| `team_flags` | `0x62` | `u8` | no | player flag byte | Alias for existing `pf` |
| `pf` | `0x62` | `u8` | no | player flag byte | Existing read field |
| `pf2` | `0x63` | `u8` | no | player flag byte | Existing read field |
| `pf3` | `0x64` | `u8` | no | player flag byte | Existing read field |
| `energy` | `0x66` | `u8` | no | rating/energy byte | Existing carrier rating |
| `wgt8` | `0x67` | `u8` | no | weight byte | Existing verbose/read field |
| `shotpwr` | `0x6C` | `u8` | no | rating byte | Existing carrier rating |
| `shotacc` | `0x6D` | `u8` | no | rating byte | Existing carrier rating |
| `passacc` | `0x6E` | `u8` | no | rating byte | Existing carrier rating |
| `puck_control_rating` | `0x71` | `u8` | no | puck-control/stickhandling rating | From possession RE; verify menu name |
| `hitrating` | unverified | `u8` expected | no | hit/check rating | Do not expose until offset is pinned |

Global fields:

| Field | Address | Width | Signed | Units / Encoding | Notes |
|---|---:|---|---|---|---|
| `carrier` | `0xFFB7AA` | `u16_be` | no | `0-11 = sN`, other = loose/none | Observed loose sentinel `0xFF02`; explicit none write uses `0xFFFF` |
| `clock` / `gameclock` | `0xFFC468` | `u16_be` | no | seconds remaining | Render as `M:SS` |
| `period` / `gsp` | `0xFFC466` | `u16_be` | no | `0=1st`, `1=2nd`, `2=3rd`, `3=OT` | Existing state field |
| `gmode` | `0xFFC2EA` | `u8` | no | bitfield | bit 0 = stoppage gate closed; bit 8 is line-change corroboration when read as word |
| `session_byte` | `0xFFC735` | `u8` | no | coarse screen/session signal | Existing phase heuristic input |
| `vpos` | `0xFFBD18` | current impl reads raw | unverified | camera Y scroll | Existing state field |
| `hpos` | `0xFFBD1C` | current impl reads raw | unverified | camera X scroll | Existing state field |
| `yleader` | `0xFFBF92` | current impl reads raw | unverified | camera bias accumulator | Existing state field |
| `shotplayer` | `0xFFBED8` | `s16_be` | yes | slot or `-1` | Existing play-context field |
| `lastplayer` | `0xFFBEDA` | `s16_be` | yes | slot or `-1` | Existing play-context field |
| `passdir` | `0xFFBEDC` | `s16_be` | yes | raw pass direction | Existing play-context field |
| `passspeed` | `0xFFBEDE` | `s16_be` | yes | raw pass speed | Existing play-context field |
| `line_change_latch` | `0xFFC304` | `u16_be` | no | nonzero = pre-drop line-change window | Set to `0x2710`, cleared at puck drop; do not call this a countdown unless decrementing is verified |
| `home_line` | `0xFFC6E5` | `u8` | no | `0=Sc1`, `1=Sc2`, `2=Chk`, other=`unknown` | Low byte of word `0xFFC6E4` |
| `away_line` | `0xFFCA48` | `u8` | no | `0=Sc1`, `1=Sc2`, `2=Chk`, other=`unknown` | Treat as the selected-line byte; verify any surrounding word semantics separately |

Unresolved field-table work that must happen before implementation:

- confirm `fdir` range and direction labels;
- confirm `puck_control_rating` menu-facing name;
- pin `hitrating` offset before exposing it as a named field;
- verify camera field widths if the implementation expands camera writes;
- live-check whether `0xFFC304` decrements. If it does not, keep the
  `line_change_latch` name and avoid `countdown` terminology.

## `nhl94_state` Line-Change Detection

On retail `nhl94.gen` with ROM MD5 `8356B3F0D091B9CC441E2FF8721AD063`, the
pre-drop line-change window is cleanly detectable from work RAM.

Primary detector:

- M68K bus word `$FFC304 != 0`

Documented provenance:

- set to `0x2710` by the faceoff-setup routine at PC `0xF952`;
- cleared to `0` at the puck-drop routine at PC `0xFE4C`;
- documented in `docs/rom-reference/RETAIL_OFFSETS.md` under
  "Game-mode / faceoff + line-change selection".

Corroborating evidence:

- `$FFC2EA` bit 8 (`0x0100`) set;
- stoppage gate / clock-not-running evidence from readable mode flags;
- puck carrier `$FFB7AA` high byte `0xFF`, meaning loose puck.

Important negative rule:

- Do not use `$FFC2EE` bit 0 for this. It was an early guess and is wrong; it
  reads `0` during the confirmed window.

Selected line fields:

- home line: low byte of word `$FFC6E4`, exposed as address `$FFC6E5`;
- away line: byte at `$FFCA48`;
- encoding: `0 = Sc1`, `1 = Sc2`, `2 = Chk`, any other value = `unknown`
  with the raw byte preserved.

When `$FFC304 != 0`, `nhl94_state` should report the distinct machine-stable
phase before the generic faceoff/stoppage bucket:

```ts
{
  phase: "faceoff_line_change",
  phase_label: "faceoff / line-change (pre-drop)",
  line_change: {
    active: true,
    latch: 10000,
    latch_hex: "0x2710",
    home: "Chk",
    away: "Sc1",
    home_raw: 2,
    away_raw: 0,
    evidence: {
      latch_nonzero: true,
      c2ea_bit8: true,
      stoppage_gate_closed: true,
      puck_loose: true
    }
  }
}
```

`$FFC2EA` bit 8, stoppage-gate evidence, and puck-loose are evidence fields,
not required gates. `clock_frozen` is intentionally not part of the one-snapshot
state contract because frozen-ness is a cross-frame property.

The primary detector is `$FFC304 != 0`. If live verification finds false
positives for this exact ROM MD5, tighten the detector by promoting the
corroborating fields to required gates in this order: puck loose, stoppage gate
closed, `$FFC2EA` bit 8.

Vision captions are not authoritative for this mode. `nhl94_state` should
prefer the RAM-backed phase even if vision says "mid-gameplay".

## Raw Offset Policy

Named fields are the default. Raw offsets are available but must be explicit:

- entity raw offsets require `allow_raw:true`;
- raw global addresses require `allow_raw:true`;
- trap captures and override writes follow the same rule.

This gives agents a safe path for newly decoded fields while making raw offset
usage visible in call JSON and logs.

Example:

```ts
{ target: "s0", offset: "0x71", width: "u8", value: 21, allow_raw: true }
{ target: "global", address: "0xFFC304", width: "u16_be", value: 0x2710, allow_raw: true }
```

Without `allow_raw:true`, the tool should reject the call and point the caller
to named fields or the explicit raw form.

## `nhl94_fields`

`nhl94_fields` is the common semantic API for arbitrary selected field reads,
writes, freezes, and unfreezes. It is not a curated state summary; use
`nhl94_read` bundles or `nhl94_state` for situational snapshots.

Schema:

```ts
{
  ops: [
    { op: "read", target: "s0", field: "fdir" },
    { op: "write", target: "s6", field: "lockout", value: 0 },
    { op: "write", target: "s6", field: "fdir", value: 4, freeze: true },
    { op: "write", target: "global", field: "carrier", value: "none" },
    { op: "write", target: "s0", offset: "0x71", width: "u8", value: 21, allow_raw: true },
    { op: "read", target: "global", address: "0xFFC304", width: "u16_be", allow_raw: true }
  ],
  readback?: "none" | "post_write"
}
```

Rules:

- each op has its own `op`; do not use a top-level action with mixed op shapes;
- `freeze:true` on a write means "write this value and freeze this same field";
- `op:"freeze"` freezes the current value unless `value` is supplied;
- `op:"unfreeze"` releases only that field/address;
- raw entity access uses `offset`, relative to the target base;
- raw global access uses absolute `address`;
- default `readback` for any write/freeze operation is `post_write`.

Echo-on-write contract:

- write-side responses must report post-mutation decoded readback from RAM, not
  only the intended value;
- if readback differs from the intended value, report both values and mark the
  op as contested or overwritten;
- `readback:"none"` is allowed only for performance-sensitive calls and should
  be explicit in the request.

Specialized tools remain preferred where clearer:

- broad placement: `nhl94_teleport` or `nhl94_stage`;
- possession: `nhl94_possession`;
- clock setup: `nhl94_clock`.

`nhl94_fields` may allow those writes for batch convenience, but responses
should include a short note when a specialized tool would be clearer.

## `nhl94_stage`

`nhl94_stage` is an atomic setup tool for RE experiments. It exists to avoid
the transcript pattern where agents combine teleport, raw Lua writes, freezes,
and frame advances manually.

Schema:

```ts
{
  rig?: "netcannon",
  clear_freezes?: true,
  stop_overrides?: true,
  stop_traps?: true,
  park?: { keep: ["s0", "s6", "pk"] },
  place?: [
    { target: "s0", x: -2, y: -16, xv: 0, yv: 0, fdir: 4 },
    { target: "pk", x: -2, y: -16, xv: 25000, yv: 0 }
  ],
  possession?: "s0" | "none",
  fields?: [
    { target: "s0", field: "lockout", value: 0 },
    { target: "s6", field: "fdir", value: 4, freeze: true }
  ],
  settle_frames?: 0,
  readback?: true
}
```

Behavior:

- apply operations in a deterministic order: stop semantic overrides if
  requested, stop semantic traps if requested, rig, clear freezes, park, place,
  possession, field writes/freezes, optional settle, readback;
- default `settle_frames` to `0` for RE precision;
- let agents request render settle explicitly when they need a fresh screenshot;
- echo decoded values written and any auto-detach or freeze behavior.

The default of `settle_frames: 0` is intentional. Existing `nhl94_teleport`
settles for screenshot freshness, but exact RE staging sometimes needs no
frames to run between memory setup and trap arming.

Conflict handling:

- reject `place` entries for `pk` when `possession` is a skater, because
  possession will immediately reposition the puck on the carrier and defeat the
  puck placement/velocity intent;
- allow `place` entries for `pk` when `possession:"none"` or when no possession
  operation is requested;
- `clear_freezes` clears the bridge freeze table only. It does not stop
  `nhl94_exec_override` hooks or native Lua hooks.

Park semantics:

- `park.keep` leaves listed targets untouched;
- every other skater is moved off-rink, has x/y frozen, and has xv/yv/zv frozen
  at zero;
- z is left untouched unless implementation discovers this causes a collision
  or visibility issue;
- parking does not disable AI logic. It prevents practical interaction by
  holding position and velocity out of play.

## `nhl94_trap_exec`

`nhl94_trap_exec` wraps native exec traps with NHL94 semantics.

Schema:

```ts
{
  action: "start" | "read" | "status" | "stop" | "stop_all",
  traps?: [
    {
      name: "pickup_gate",
      pc: "0x14E40",
      roles: { A2: "candidate" },
      captures: [
        "candidate.slot",
        "candidate.fdir",
        "candidate.lockout",
        "global.carrier",
        "puck.x",
        "puck.y"
      ],
      max_hits?: 50
    }
  ]
}
```

Behavior:

- accept PCs as hex strings such as `"0x14E40"` and decimal numbers;
- reject ambiguous non-hex strings;
- compile semantic captures to the native capture token format internally;
- support register-bound entity roles such as `A2 = candidate`, `A2 = victim`,
  `A3 = checker`;
- fail unknown semantic captures with a useful message.
- reject `start` when a trap name already exists, unless a future schema adds an
  explicit `replace:true`;
- `read` drains and returns buffered hits;
- `status` reports active trap names, hit counts, and buffer sizes without
  draining;
- `stop` returns a final drained hit set and unregisters the named trap;
- when `max_hits` is reached, the semantic trap auto-stops after recording the
  final hit.

Native `bizhawk_trap_exec` remains available for unsupported captures or
non-NHL94 work.

## `nhl94_exec_override`

`nhl94_exec_override` provides bounded one-shot and persistent hooks for cases
where an experiment needs controlled per-frame or PC-hit forcing, such as
holding `fdir` stable while AI logic tries to rotate a skater.

Schema:

```ts
{
  action: "start" | "status" | "stop" | "stop_all",
  name?: "hold_s6_fdir",
  mode?: "pc_hit" | "frame",
  pc?: "0x14E40",
  when?: { role: "A2", target: "s6" },
  writes?: [
    { target: "s6", field: "fdir", value: 4 },
    { target: "s6", field: "x", value: 0 },
    { target: "s6", field: "y", value: 0 }
  ],
  max_hits?: 120,
  max_frames?: 120
}
```

Rules:

- persistent hooks require `max_hits`, `max_frames`, or both;
- hooks are named and visible via `status`;
- starting an override with an existing name is an error unless a future schema
  adds explicit `replace:true`;
- when a bound is reached, the override auto-stops;
- `stop_all` stops only hooks created by `nhl94_exec_override`;
- raw writes inside hooks require `allow_raw:true`;
- responses should show hit counts, remaining bounds, and active hook names.

One-shot hooks are allowed for single PC-hit corrections. Persistent hooks are
allowed because the transcript evidence shows agents need them, but bounds are
mandatory to prevent stale hooks from contaminating later experiments.

Mode-specific validation:

- `mode:"pc_hit"` requires `pc`; `when` may bind a register role such as
  `{ role:"A2", target:"s6" }`; `max_hits` is the natural bound.
- `mode:"frame"` rejects `pc` and register-role `when`; it applies once per
  frame until `max_frames` is reached or the hook is stopped.
- Savestate loads, ROM resets, and bridge reconnects must be specified by the
  implementation. The safe default is to clear semantic overrides on bridge
  reconnect/reload and report that cleanup in `status`.

## `nhl94_read`

Enhance `nhl94_read` so agents can get compact curated snapshots without
dropping to `bizhawk_read_many`. Keep it distinct from `nhl94_fields`.

Desired capabilities:

- curated bundles such as `bundle:"on_ice_context"` and
  `bundle:"possession_context"` for common RE observations;
- selected entities/globals can narrow a bundle;
- output preserves target/field labels in stable order;
- no raw offsets here. Use `nhl94_fields` for arbitrary named fields or guarded
  raw offsets.

`nhl94_fields` is the arbitrary-field reader/writer. `nhl94_read` is the
situational-awareness reader.

## `nhl94_unfreeze`

`nhl94_unfreeze` already supports `all:true` for clearing the whole bridge
freeze table. Keep `all:true` canonical.

Optionally add target `"ALL"` as an alias only if it remains unambiguous and
does not weaken validation. The tool description should strongly prefer
`all:true`, because it is explicit and JSON-shaped.

## `nhl94_recipes`

Update the one-time primer so agents learn the preferred flow:

```text
nhl94_recipes
  -> nhl94_state / nhl94_rig
  -> nhl94_stage
  -> nhl94_fields / nhl94_read
  -> nhl94_trap_exec / nhl94_exec_override
  -> nhl94_state or trap readback
```

Native BizHawk remains the right choice for:

- disassembly;
- ROM search and RAM snapshots;
- ordinary frame advance;
- input playback;
- unsupported trap captures.

The primer should also teach cleanup:

```text
stop semantic traps
stop semantic overrides
unfreeze all
restore or apply rig
verify state
```

Important limitation: semantic `stop_all` cleanup can only stop semantic traps
and overrides created by the new tools. Native `bizhawk_eval_lua` hooks are
outside this lifecycle and should be called out as an escape hatch with manual
cleanup responsibility.

Also call out the separate cleanup mechanisms explicitly: `nhl94_unfreeze
{"all":true}` and `nhl94_stage { clear_freezes:true }` clear bridge freezes,
but do not stop semantic overrides or native Lua hooks.

## Error Handling

Errors should be corrective and specific:

- unknown field: list close valid names and explain raw offsets require
  `allow_raw:true`;
- raw offset without `allow_raw:true`: reject with a minimal valid example;
- invalid target: list valid targets `s0-s11`, `pk`, and `global`;
- unsafe persistent override: reject if no `max_hits` or `max_frames`;
- trap PC parse failure: accept `"0x..."` strings and decimal numbers, reject
  ambiguous strings;
- unsupported semantic capture: name the unsupported capture and suggest native
  `bizhawk_trap_exec` as the escape hatch.

Responses from write-side tools should echo decoded values, not only raw words.
This keeps conversion mistakes visible in the same result that made the write.

Error responses should carry a stable code and structured details internally,
even if MCP ultimately renders them as text:

```ts
{
  code: "RAW_REQUIRES_ALLOW_RAW",
  message: "raw global address 0xFFC304 requires allow_raw:true",
  details: {
    target: "global",
    address: "0xFFC304",
    valid_named_fields: ["carrier", "clock", "line_change_latch", "home_line", "away_line"]
  },
  example: { op: "read", target: "global", address: "0xFFC304", width: "u16_be", allow_raw: true }
}
```

At minimum, define codes for:

- `UNKNOWN_FIELD`
- `INVALID_TARGET`
- `RAW_REQUIRES_ALLOW_RAW`
- `INVALID_RAW_OFFSET`
- `INVALID_RAW_ADDRESS`
- `UNBOUNDED_OVERRIDE`
- `DUPLICATE_HOOK_NAME`
- `INVALID_MODE_ARGUMENT`
- `UNSUPPORTED_CAPTURE`
- `CONFLICTING_STAGE_REQUEST`

## Testing

Add focused tests at three levels.

Pure helper tests:

- line-change detector maps `$FFC304 != 0` to `faceoff_line_change`;
- negative-rule regression: detector fires when `$FFC2EE` bit 0 is `0` but
  `$FFC304 != 0`;
- evidence-not-gates regression: detector fires when `$FFC2EA` bit 8,
  stoppage-gate evidence, and puck-loose evidence are all false but
  `$FFC304 != 0`;
- line values `0`, `1`, and `2` map to `Sc1`, `Sc2`, and `Chk`;
- out-of-range line values map to `unknown` and preserve `*_raw`;
- raw entity offset guard rejects without `allow_raw:true`;
- raw global address guard rejects without `allow_raw:true`;
- hex PC parser accepts `"0xF952"` and preserves the exact value;
- unknown fields and invalid targets produce corrective errors.

Tool behavior tests with mocked bridge:

- `nhl94_state` includes `line_change` and gives it phase priority;
- `nhl94_fields` compiles named entity/global reads, writes, freezes, and
  unfreezes;
- `nhl94_fields` write/freeze responses return post-mutation decoded readback;
- `nhl94_stage` emits operations in the specified order: stop overrides/traps,
  rig, clear freezes, park, place, possession, writes/freezes, settle, readback;
- `nhl94_stage` defaults `settle_frames` to `0`;
- `nhl94_stage` rejects `pk` placement plus skater possession in one request;
- `clear_freezes` does not stop overrides;
- `nhl94_trap_exec` compiles semantic captures to native capture tokens;
- `nhl94_trap_exec read` drains while `status` peeks;
- `nhl94_exec_override` rejects unbounded persistent hooks and reports bounded
  hook lifecycle state;
- duplicate trap/override names are rejected.

Surface and guidance tests:

- the default exposed tool set includes the new NHL94 tools;
- `nhl94_recipes` includes the preferred flow and cleanup language;
- tool descriptions mention `allow_raw:true`, `faceoff_line_change`, and
  native-tool escape hatches.

## Implementation Notes

Prefer reusing the existing NHL94 helper module and patterns where possible:

- keep layout constants and field resolution in one shared module;
- keep bridge communication server-side in TypeScript unless an operation truly
  requires new Lua bridge support;
- avoid broad refactors of native BizHawk tools;
- preserve existing tools and response compatibility unless the implementation
  plan identifies a concrete incompatibility.

Atomicity requirement:

- `nhl94_fields` batches, `nhl94_stage`, and semantic override setup must avoid
  emulated frame slippage between dependent writes/freezes.
- Existing `memory_ops` already gives atomic memory write/freeze batches. Use it
  when it covers the full operation.
- If an operation combines actions that cannot be expressed as one existing
  bridge command, add a small Lua-side batch executor instead of issuing chatty
  sequential round-trips that allow frames to advance between dependent steps.
- This is the explicit exception to the "prefer TypeScript-side translation"
  rule. The semantic API remains TypeScript-facing, but the bridge must provide
  the frame-boundary primitive when correctness requires it.

Because this spec covers multiple tools, implementation should be staged in a
written plan before code changes. A reasonable implementation order is:

1. Reconcile the field dictionary with `src/nhl94.ts` and ROM docs; pin or
   withhold unresolved fields.
2. `nhl94_state` line-change detection and tests.
3. Shared field/global resolver and `allow_raw:true` guard.
4. `nhl94_fields` and `nhl94_read` enhancements.
5. Bridge atomic batch primitive if existing commands cannot satisfy
   `nhl94_stage` without frame slippage.
6. `nhl94_stage`.
7. `nhl94_trap_exec`.
8. `nhl94_exec_override`.
9. `nhl94_recipes` and tool-description guidance updates.
