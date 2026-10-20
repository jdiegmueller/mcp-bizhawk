# Intermission Highlight Suppression

## Problem

During NHL '94 intermissions, the game plays highlights from a synthetic
other-game matchup. The entity slots, puck, score, and rendered footage are
internally coherent, so agents can mistake them for the active game. This has
caused false diagnoses of corrupted state, dropped callbacks, invalid rigs, and
attract mode.

Warnings alongside the data are insufficient because both the structured data
and vision description look plausible. Highlight-reel data must not leave the
semantic state tool.

## Detection

`nhl94_state` performs a minimal preflight read of the full 16-bit `gmode` word
and the session byte before reading entities or capturing an image.

Any word satisfying:

```text
(gmode & 0xF000) == 0x1000
```

is an intermission highlight. The high nibble is the context selector. The low
12 bits are orthogonal play substates and do not participate in detection.

The session byte at `0xFFC735` is returned as secondary raw evidence only. It
does not gate detection because highlight footage may use an on-ice session
value.

## Suppressed Behavior

When a highlight is detected, `nhl94_state` immediately returns:

```text
phase: intermission_highlight
INTERMISSION HIGHLIGHT — footage is not part of the active game.
Active-game entities, puck, score, screenshot, and vision intentionally suppressed.
evidence: gmode=0xNNNN high_nibble=0x1 session=0xNN
```

The tool does not:

- read `s0`–`s11` or `pk`;
- inspect freezes or other active-game globals;
- capture a screenshot;
- request a vision description;
- honor any bypass through `raw`, `verbose`, `sections`, or `describe`.

There is no override. Highlight-reel gameplay data is never authoritative for
an agent-facing NHL '94 state report.

## Normal Path

All non-`0x1xxx` values continue through the existing `nhl94_state` behavior.
The preflight adds one small bridge round trip to normal calls.

The tool description identifies `intermission_highlight` as a terminal context
result and tells agents not to infer a team, score, rig failure, callback
failure, emulator reset, or attract mode from it.

## Tests

Tests cover:

- observed values `0x1000`, `0x1200`, `0x1500`, and `0x1700`;
- raw session evidence without using it as a gate;
- no entity read, freeze inspection, screenshot, or vision request;
- suppression despite `raw`, `verbose`, `sections`, and `describe`;
- adjacent non-highlight bands continuing through the normal path;
- the exact terminal response and raw evidence formatting.

## Release

Increment the server and Lua bridge patch versions by `0.0.1`, restart
`bizhawk-daemon`, verify the test suite and live service state, and commit only
the scoped files.
