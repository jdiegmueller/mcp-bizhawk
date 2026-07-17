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
- game clock `$FFC468` frozen;
- puck carrier `$FFB7AA` high byte `0xFF`, meaning loose puck.

Important negative rule:

- Do not use `$FFC2EE` bit 0 for this. It was an early guess and is wrong; it
  reads `0` during the confirmed window.

Selected line fields:

- home line: low byte of word `$FFC6E4`, exposed as address `$FFC6E5`;
- away line: `$FFCA48`;
- encoding: `0 = Sc1`, `1 = Sc2`, `2 = Chk`.

When `$FFC304 != 0`, `nhl94_state` should report the distinct machine-stable
phase before the generic faceoff/stoppage bucket:

```ts
{
  phase: "faceoff_line_change",
  phase_label: "faceoff / line-change (pre-drop)",
  line_change: {
    active: true,
    countdown: 10000,
    countdown_hex: "0x2710",
    home: "Chk",
    away: "Sc1",
    home_raw: 2,
    away_raw: 0,
    evidence: {
      countdown_nonzero: true,
      c2ea_bit8: true,
      clock_frozen: true,
      puck_loose: true
    }
  }
}
```

`$FFC2EA` bit 8, clock-frozen, and puck-loose are evidence fields, not required
gates. The primary detector is `$FFC304 != 0` unless live verification later
finds false positives.

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
```

Without `allow_raw:true`, the tool should reject the call and point the caller
to named fields or the explicit raw form.

## `nhl94_fields`

`nhl94_fields` is the common semantic API for selected field reads, writes,
freezes, and unfreezes.

Schema:

```ts
{
  action: "read" | "write" | "freeze" | "unfreeze",
  ops: [
    { target: "s0", field: "fdir" },
    { target: "s6", field: "lockout", value: 0 },
    { target: "global", field: "carrier", value: "none" },
    { target: "s0", offset: "0x71", width: "u8", value: 21, allow_raw: true }
  ],
  readback?: true
}
```

Initial named fields should include:

- entity fields: `x`, `y`, `z`, `xv`, `yv`, `zv`, `fdir`, `anim`, `frame`,
  `lockout`, `team_flags`, `hitrating`, `puck_control_rating`;
- globals: `carrier`, `clock`, `period`, `gmode`, `faceoff_countdown`,
  `home_line`, `away_line`.

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

- apply operations in a deterministic order: rig, clear freezes, park, place,
  possession, field writes/freezes, optional settle, readback;
- default `settle_frames` to `0` for RE precision;
- let agents request render settle explicitly when they need a fresh screenshot;
- echo decoded values written and any auto-detach or freeze behavior.

The default of `settle_frames: 0` is intentional. Existing `nhl94_teleport`
settles for screenshot freshness, but exact RE staging sometimes needs no
frames to run between memory setup and trap arming.

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
- `stop_all` stops only hooks created by `nhl94_exec_override`;
- raw writes inside hooks require `allow_raw:true`;
- responses should show hit counts, remaining bounds, and active hook names.

One-shot hooks are allowed for single PC-hit corrections. Persistent hooks are
allowed because the transcript evidence shows agents need them, but bounds are
mandatory to prevent stale hooks from contaminating later experiments.

## `nhl94_read`

Enhance `nhl94_read` so agents can get compact semantic snapshots without
dropping to `bizhawk_read_many`.

Desired capabilities:

- selected entities and selected fields in one call;
- selected globals in the same call;
- named fields by default;
- raw offset escape hatch with `allow_raw:true`;
- output preserves target/field labels in request order.

This can overlap with `nhl94_fields action:"read"`. The implementation plan
should decide whether `nhl94_read` becomes a thin alias over the read path or
keeps its current shape with expanded capabilities. The user-facing goal is
clear: common NHL94 observation should not require raw address reads.

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

## Testing

Add focused tests at three levels.

Pure helper tests:

- line-change detector maps `$FFC304 != 0` to `faceoff_line_change`;
- line values `0`, `1`, and `2` map to `Sc1`, `Sc2`, and `Chk`;
- raw offset guard rejects without `allow_raw:true`;
- hex PC parser accepts `"0xF952"` and preserves the exact value;
- unknown fields and invalid targets produce corrective errors.

Tool behavior tests with mocked bridge:

- `nhl94_state` includes `line_change` and gives it phase priority;
- `nhl94_fields` compiles named entity/global reads, writes, freezes, and
  unfreezes;
- `nhl94_stage` emits one ordered setup sequence with `settle_frames: 0` by
  default;
- `nhl94_trap_exec` compiles semantic captures to native capture tokens;
- `nhl94_exec_override` rejects unbounded persistent hooks and reports bounded
  hook lifecycle state.

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

Because this spec covers multiple tools, implementation should be staged in a
written plan before code changes. A reasonable implementation order is:

1. `nhl94_state` line-change detection and tests.
2. Shared field/global resolver and `allow_raw:true` guard.
3. `nhl94_fields` and `nhl94_read` enhancements.
4. `nhl94_stage`.
5. `nhl94_trap_exec`.
6. `nhl94_exec_override`.
7. `nhl94_recipes` and tool-description guidance updates.

