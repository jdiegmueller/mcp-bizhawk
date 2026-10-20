# NHL '94 Crowd-Level State and Control — Design

**Date:** 2026-07-30
**Status:** Approved for implementation

## Goal

Expose retail NHL '94's immediate arena-activity value, `crowdlevel` at
`$FFB89C`, in the normal `nhl94_state` snapshot and make it available through
the existing semantic field interface for reading, writing, freezing, and
unfreezing.

This feature covers `crowdlevel` only. The longer-lived excitement meter,
derived chant state, crowd animation registers, and penalty-box occupancy
remain outside this change.

## Source Semantics

`crowdlevel` is an unsigned big-endian word at M68K bus address `$FFB89C`.
Retail uses it as the immediate arena-noise and presentation-activity input.
It decays per frame and selects the bench/stands animation band:

| Raw value | Label | Band | Presentation cadence |
|---:|---|---:|---|
| `0–63` | `quiet` | 0 | slow, 12–24 frames |
| `64–127` | `active` | 1 | medium, 7–14 frames |
| `128–191` | `energetic` | 2 | medium, 7–14 frames |
| `192+` | `high` | 3 | fast, 3–6 frames |

Values above 280 additionally make the transient spectator-cheer overlays
eligible. This threshold is strict: 280 is not eligible; 281 is.

The semantic field accepts the full unsigned-word range rather than imposing a
600 ceiling. Retail normally caps the working sound-path level at 600, but
event code can produce larger transient values, including the decided-game
boost. Preserving the machine representation makes those experiments possible.

## Public Interface

### `nhl94_state`

Every normal, non-intermission-highlight state snapshot reads `crowdlevel` in
the existing globals batch and emits one compact line:

```text
crowdlevel: 200 (high, band=3, activity=bench+stands fast 3–6f, cheer_eligible=false)
```

The line reports:

- the raw unsigned value;
- the decoded label and band;
- the bench/stands animation cadence;
- whether the `>280` cheer-overlay condition is satisfied.

If `$FFB89C` is frozen, the raw value receives the same trailing `*` convention
used by other `nhl94_state` globals:

```text
crowdlevel: 300* (high, band=3, activity=bench+stands fast 3–6f, cheer_eligible=true)
```

The crowd line is part of the default compact state. It does not require a new
section flag. The terminal `intermission_highlight` response remains suppressed
and does not read or display `crowdlevel`.

### `nhl94_fields`

Add `crowdlevel` to the named global map. The existing mixed-operation contract
then supports all requested controls without a new MCP tool:

```json
{"ops":[{"op":"read","target":"global","field":"crowdlevel"}]}
```

```json
{"ops":[{"op":"write","target":"global","field":"crowdlevel","value":300}]}
```

```json
{"ops":[{"op":"freeze","target":"global","field":"crowdlevel","value":300}]}
```

```json
{"ops":[{"op":"freeze","target":"global","field":"crowdlevel"}]}
```

```json
{"ops":[{"op":"unfreeze","target":"global","field":"crowdlevel"}]}
```

An omitted freeze value keeps the current-RAM behavior already implemented by
`nhl94_fields`. A write with `freeze:true` also remains valid under the existing
interface. Named-field width resolution selects `u16_be`.

## Internal Design

`src/nhl94.ts` owns the address by adding:

```ts
crowdlevel: 0xffb89c
```

to `G`. This automatically enables semantic field resolution and reverse frozen
address mapping.

`src/tools.ts` adds `crowdlevel` to the normal state globals read. A small pure
decoder converts the raw value into the four presentation attributes used by
the formatter. It contains the threshold logic in one place so boundary tests
do not depend on parsing prose.

No Lua bridge or wire-protocol change is required. The existing `read_many`,
`memory_ops`, and `list_frozen` bridge operations already provide all needed
behavior.

## Validation and Errors

- Named reads and controls use unsigned 16-bit encoding.
- Existing `nhl94_fields` validation rejects non-integers; its established
  unsigned-word encoding masks integer inputs to 16 bits.
- `nhl94_state` treats a missing bridge value as zero, consistent with its
  existing global fallbacks.
- Freeze display is derived from `list_frozen`; no second source of freeze state
  is introduced.

## Tests

Automated coverage will prove:

1. `G.crowdlevel` resolves to `$FFB89C` with `u16_be`.
2. Decoder boundaries are exact at 0, 63, 64, 127, 128, 191, 192, 280, and 281.
3. Normal `nhl94_state` requests `$FFB89C` in its globals batch.
4. State output contains raw value, label, band, cadence, and cheer eligibility.
5. A frozen `$FFB89C` produces the `*` marker.
6. `nhl94_fields` read, write, explicit-value freeze, current-value freeze, and
   unfreeze all target `$FFB89C` as a big-endian word.
7. Intermission-highlight suppression remains terminal and does not perform the
   globals read.

Tests follow red-green-refactor: each new behavior is first demonstrated by a
failing focused test, followed by the minimum implementation and the relevant
focused and full-suite verification.

## Alternatives Considered

### Dedicated `nhl94_crowd` tool

A dedicated set/freeze/release tool would be discoverable but would duplicate
the already documented `nhl94_fields` contract and expand the public tool
surface without adding capability. Rejected.

### Raw state value only

Returning only `crowdlevel: 200` would expose RAM but hide the behaviorally
important animation thresholds. Rejected in favor of raw plus decoded context.

### Expose the entire crowd subsystem

Adding excitement, chant, animation-frame, cheer, and occupancy registers at
the same time would combine several independently decoded mechanisms and exceed
the requested scope. Deferred to separate work.
