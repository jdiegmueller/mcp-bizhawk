# NHL94 Control Context in Game State

## Goal

Agents need `nhl94_state` to answer the practical input question: "If I send
`player:1` or `player:2`, which NHL94 skater, if any, will that controller steer
right now?" The state output should expose verified control pointers, current pad
RAM, and clear mode inference so agents can choose controller ports, switch
players, or restage rigs without guessing.

## Source Facts

This spec targets `/mnt/8tb/jason/mcp-bizhawk_jd` on the branch containing
`src/nhl94.ts`, `src/tools.ts`, `tests/nhl94_tools.test.mjs`, and
`docs/rom-reference/RETAIL_OFFSETS.md`. It is an incremental change to the
existing NHL94 tool surface, not a greenfield MCP server design.

Use verified retail offsets from `docs/rom-reference/RETAIL_OFFSETS.md`. The
constants stored in `src/nhl94.ts` are absolute Genesis 68K bus addresses
(`0xFFxxxx`). NHL94 tools must continue to read via `backend.nhlDomain()`:
prefer the `M68K BUS` domain when present, otherwise use `68K RAM` and rebase
through `d.addr(abs)` / `d.rebase(...)` so `0xFFC320` becomes `0xC320` only when
the active BizHawk domain is `68K RAM`.

- Active controlled slot: team0/home `0xFFC320`, team1/away `0xFFC322`, `u16_be`.
  Values `0..11` are absolute skater slots; `0xFFFF` means that team has no human
  pad driving a skater.
- `c1playernum` / `c2playernum`: player-1 `0xFFC656`, player-2 `0xFFC658`,
  `u16_be`. These are explicitly not active skater indices, but they are useful
  raw context and should be reported with a caveat.
- Switch debounce: home `0xFFBF06`, away `0xFFBF07`, `u8`.
- Decoded controller RAM: p1 held `0xFFBEEE`, p1 edge `0xFFBEF0`, p2 held
  `0xFFBEF2`, p2 edge `0xFFBEF4`, all `u16_be`. The offsets doc only fully
  verifies B as bit `0x10`, so decoding must be conservative: report raw words
  always, decode B, and decode any other bits only if the implementation has a
  named mapping with a local comment.
- Existing line selection remains home `0xFFC6E5`, away `0xFFCA48`, `u8`.

## User-Facing Output

`nhl94_state` will add a block after the current clock/carrier/camera/context
lines:

```text
control:
  team0/home: human active=s4 switch_debounce=0 line=Sc1 raw_active=0x0004
  team1/away: CPU active=none switch_debounce=0 line=Chk raw_active=0xFFFF
  control_snapshot: 1P-CPU inferred from active control slots
  input_route: player1 likely controls the sole human team team0/home -> s4; player2 inactive/CPU
  pad: p1_held=0x0010(B) p1_edge=0x0000 p2_held=0x0000 p2_edge=0x0000
  caveat: c1playernum=0x0000 c2playernum=0xFFFF are reported raw; they are not active skater indices
```

The exact labels can be compact, but the block must always include:

- team0/home active control status
- team1/away active control status
- inferred control snapshot
- controller-to-team route guidance
- pad raw words with conservative decoded button names
- raw `c1playernum` / `c2playernum` caveat

Always include raw hex for active slots, pad words, and `c1/c2`. When
`raw:true`, include raw hex for every control field.

## Control Snapshot Inference

Infer an instantaneous `control_snapshot` from active controlled slot words. This
is not a permanent menu-selected game-mode declaration. It can read like CPU
control during menus, cutscenes, stoppages, goalie-only moments, or any phase
where the game temporarily has no human-driven skater. The `phase` and
`interaction_gate` lines remain the authority for whether gameplay input should
matter right now.

- both teams active slots are `0xFFFF`: `CPU-CPU snapshot`
- team0 active and team1 `0xFFFF`: `1P-CPU snapshot`
- team0 `0xFFFF` and team1 active: `CPU-1P snapshot`
- both teams active: `1P-2P snapshot`
- any active word outside `0..11` and not `0xFFFF`: `unknown`

Also validate team/slot consistency:

- team0/home should normally be slots `s0..s5`
- team1/away should normally be slots `s6..s11`
- if the pointer is a valid slot but on the other team's side, print
  `active_valid=false` with the observed slot and make `control_snapshot:
  unknown` rather than counting that team as active.

## Input Route Derivation

The active-slot words prove which teams currently have a human-driven skater.
They do not fully prove controller-port-to-team binding. Route guidance must
therefore be explicit about confidence:

- In `1P-CPU snapshot` or `CPU-1P snapshot`, say `player1 likely controls the
  sole human team ...` because one-human games normally route through P1, but the
  source offsets do not prove menu-side assignment.
- In `1P-2P snapshot`, say `player1/player2 likely map to the two human teams;
  verify with pad words or live input` unless `c1/c2` is later decoded by a
  separately verified source.
- In `CPU-CPU snapshot` or `unknown`, say no active input route is known.
- Never use `c1playernum` / `c2playernum` as active skater indices.

## Data Flow

Extend `src/nhl94.ts` with named absolute-bus globals for the control offsets
and helper formatters:

- `active_control_home`, `active_control_away`
- `c1playernum`, `c2playernum`
- `switch_debounce_home`, `switch_debounce_away`
- `pad_p1_held`, `pad_p1_edge`, `pad_p2_held`, `pad_p2_edge`

Extend the `nhl94_state` global `read_many` list in `src/tools.ts` to read those
fields in the same globals round-trip, with every address passed through
`d.addr(...)` and every read carrying the detected NHL domain. Format the new
block from those values without adding bridge commands or changing Lua protocol.

## Pad Decoding

The implementation should always show raw pad words. It may decode:

- `0x10` as `B`, verified in the offsets doc.

If additional bits are decoded from established project knowledge, the mapping
must live in one small helper in `src/nhl94.ts`, be covered by tests, and avoid
claiming more certainty than the docs support.

## Testing

Add focused tests in `tests/nhl94_tools.test.mjs`:

- `nhl94_state` reports `1P-CPU`, routes player1 to team0/home, and names active
  slot `s4` when `0xFFC320=4` and `0xFFC322=0xFFFF`.
- `nhl94_state` reports `CPU-CPU` when both active words are `0xFFFF`.
- `nhl94_state` reports `CPU-1P` when only team1/away has a valid active slot.
- `nhl94_state` reports `1P-2P` when both active words point to valid team slots.
- `nhl94_state` marks `active_valid=false` when a control pointer points to the
  other team's slot range and reports `control_snapshot: unknown`.
- `nhl94_state` reports `control_snapshot: unknown` when an active word is
  outside `0..11` and not `0xFFFF`.
- `nhl94_state raw:true` includes raw hex for every control field.
- Nonzero switch debounce is rendered for the matching team.
- Pad output includes raw hex and decodes B from bit `0x10`.
- Tests assert the `read_many` request uses the verified addresses and widths.
  In a harness that exposes `M68K BUS`, expected addresses are full `0xFFxxxx`;
  in a `68K RAM`-only harness, expected addresses are rebased to `0xCxxx`.

## Non-Goals

- Do not reverse-engineer the unresolved meaning of `c1playernum`,
  `c2playernum`, or `$D05A/$D05C` in this pass.
- Do not mutate game control state.
- Do not change `bizhawk_play_input_sequence` semantics.
- Do not claim a full button mapping unless every bit is verified or already
  documented elsewhere in this repo.
