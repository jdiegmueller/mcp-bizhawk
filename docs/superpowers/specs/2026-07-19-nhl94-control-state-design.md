# NHL94 Control Context in Game State

## Goal

Agents need `nhl94_state` to answer the practical input question: "If I send
`player:1` or `player:2`, which NHL94 skater, if any, will that controller steer
right now?" The state output should expose verified control pointers, current pad
RAM, and clear mode inference so agents can choose controller ports, switch
players, or restage rigs without guessing.

## Source Facts

Use verified retail offsets from `docs/rom-reference/RETAIL_OFFSETS.md`:

- Active controlled slot: team0/home `0xFFC320`, team1/away `0xFFC322`, `u16_be`.
  Values `0..11` are absolute skater slots; `0xFFFF` means that team has no human
  pad driving a skater.
- `c1playernum` / `c2playernum`: player-1 `0xFFC656`, player-2 `0xFFC658`,
  `u16_be`. These are explicitly not active skater indices, but they are useful
  raw context and should be reported with a caveat.
- Switch debounce: home `0xFFBF06`, away `0xFFBF07`, `u8`.
- Decoded controller RAM: `0xFFBEEE`, `0xFFBEF0`, `0xFFBEF2`, `0xFFBEF4`,
  `u16_be`. The offsets doc only fully verifies B as bit `0x10`, so decoding
  must be conservative: report raw words always, decode B, and decode any other
  bits only if the implementation has a named mapping with a local comment.
- Existing line selection remains home `0xFFC6E5`, away `0xFFCA48`, `u8`.

## User-Facing Output

`nhl94_state` will add a block after the current clock/carrier/camera/context
lines:

```text
control:
  team0/home: human active=s4 switch_debounce=0 line=Sc1 raw_active=0x0004
  team1/away: CPU active=none switch_debounce=0 line=Chk raw_active=0xFFFF
  mode: 1P-CPU inferred from active control slots
  input_route: player1 likely controls team0/home -> s4; player2 likely inactive/CPU
  pad: p1_held=0x0010(B) p1_edge=0x0000 p2_held=0x0000 p2_edge=0x0000
  caveat: c1playernum=0x0000 c2playernum=0xFFFF are reported raw; they are not active skater indices
```

The exact labels can be compact, but the block must always include:

- team0/home active control status
- team1/away active control status
- inferred mode
- controller-to-team route guidance
- pad raw words with conservative decoded button names
- raw `c1playernum` / `c2playernum` caveat

When `raw:true`, include raw hex for all control fields. In non-raw mode, include
raw hex for active slots, pad words, and `c1/c2` anyway because these fields are
new and still partly empirical.

## Mode Inference

Infer from active controlled slot words:

- both teams active slots are `0xFFFF`: `CPU-CPU`
- team0 active and team1 `0xFFFF`: `1P-CPU`
- team0 `0xFFFF` and team1 active: `CPU-1P`
- both teams active: `1P-2P`
- any active word outside `0..11` and not `0xFFFF`: `unknown`

Also validate team/slot consistency:

- team0/home should normally be slots `s0..s5`
- team1/away should normally be slots `s6..s11`
- if the pointer is a valid slot but on the other team's side, print
  `active_valid=false` with the observed slot.

## Manual Capture Plan

The first implementation should expose the verified RAM fields above and label
controller routing as inferred where necessary. We will then manually capture the
ambiguous controller/team mappings from live gameplay so the heuristic can become
verified behavior.

Capture target modes:

- `2P-CPU`
- `1P-2P`
- `CPU-1P`
- any other menu/player assignment that makes the active-slot words disagree
  with the simple `player1 -> home` assumption

For each capture, record:

- selected menu mode and which side is home/away
- which physical controller port is being used
- which team and visible skater that controller moves
- `0xFFC320`, `0xFFC322`, `0xFFC656`, `0xFFC658`
- `0xFFBEEE`, `0xFFBEF0`, `0xFFBEF2`, `0xFFBEF4`
- `0xFFBF06`, `0xFFBF07`
- current `phase`, `carrier`, and whether the clock/input gate is open

Useful artifacts are named savestates/rigs plus one `nhl94_state raw:true`
snapshot per mode. Once captured, update the source facts and tests so
`input_route` can distinguish verified controller-port binding from fallback
inference.

## Data Flow

Extend `src/nhl94.ts` with named globals for the control offsets and helper
formatters:

- `active_control_home`, `active_control_away`
- `c1playernum`, `c2playernum`
- `switch_debounce_home`, `switch_debounce_away`
- `pad_p1_held`, `pad_p1_edge`, `pad_p2_held`, `pad_p2_edge`

Extend the `nhl94_state` global `read_many` list in `src/tools.ts` to read those
fields in the same globals round-trip. Format the new block from those values
without adding bridge commands or changing Lua protocol.

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
- `nhl94_state` reports `1P-2P` when both active words point to valid team slots.
- `nhl94_state` marks `active_valid=false` when a control pointer points to the
  other team's slot range.
- Pad output includes raw hex and decodes B from bit `0x10`.
- Tests assert the `read_many` request uses the verified addresses and widths.

## Non-Goals

- Do not reverse-engineer the unresolved meaning of `c1playernum`,
  `c2playernum`, or `$D05A/$D05C` in this pass.
- Do not mutate game control state.
- Do not change `bizhawk_play_input_sequence` semantics.
- Do not claim a full button mapping unless every bit is verified or already
  documented elsewhere in this repo.
