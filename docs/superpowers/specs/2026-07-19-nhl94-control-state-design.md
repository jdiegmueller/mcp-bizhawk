# NHL94 Control Context in Game State

## Goal

Agents need `nhl94_state` to answer the practical input question: "If I send
`player:1` or `player:2`, which NHL94 skater, if any, will that controller steer
right now?" The state output should expose verified control pointers, current pad
RAM, and clear mode inference so agents can choose controller ports, switch
players, or restage rigs without guessing.

This follow-up extends the same output with decoded NHL94-specific per-skater
control and role facts from the updated retail offsets documentation. The goal
is for agents to consume `nhl94_state` as a game-state summary, not a raw RAM
dump that requires each agent to carry its own NHL94 decoder.

## Source Facts

Use verified retail offsets from `docs/rom-reference/RETAIL_OFFSETS.md`:

- Player structs: slots `s0..s5` are home/team0 and `s6..s11` are
  away/team1. Use this only as the expected slot/team range for sanity flags.
- Player `pf` byte (`slot +0x62`) has verified control/team bits:
  - bit `0x08` = human-active marker. The human's currently controlled skater
    carries this bit and it tracks `$C320/$C322`.
  - bit `0x20` = active-player marker for the current active/nearest skater,
    observed on one home and one away slot during engaged play. This is not the
    human marker.
  - bit `0x40` = away/team bit. Clear = home/team0, set = away/team1.
  - bit `0x80` = attack direction bit. Report as a raw directional fact without
    inventing a broader strategy label.
- Player assignment state:
  - `slot +0x36` = active assignment-queue index (`assidx`), word read but byte
    semantics.
  - `slot +0x38..+0x3F` = 8 role-enum bytes (`assq`), indexed by `assidx`.
  - Role enum values are the verified `asstab` indices from
    `RETAIL_OFFSETS.md`, including `asswingo`, `assdefd`, `assnearest`,
    `asspuckc`, `assgoaliecpu`, and `assgoaliectrl`.
- Active controlled slot: team0/home `0xFFC320`, team1/away `0xFFC322`, `u16_be`.
  Values `0..11` are absolute skater slots; `0xFFFF` means that team has no human
  pad driving a skater.
- `c1playernum` / `c2playernum`: player-1 `0xFFC656`, player-2 `0xFFC658`,
  `u16_be`. These are explicitly not active skater indices, but they are useful
  raw context and should be reported with a caveat.
- Switch debounce: home `0xFFBF06`, away `0xFFBF07`, `u8`.
  It reloads to `0x11` (17 frames) on a registered switch press and counts down.
- Decoded controller RAM: `0xFFBEEE`, `0xFFBEF0`, `0xFFBEF2`, `0xFFBEF4`,
  `u16_be`. The offsets doc only says these are held-vs-edge variants; it does
  not verify which word is held vs edge or which pair belongs to P1 vs P2. The
  first implementation must therefore label them as indexed raw words
  `pad_word_0..3` by address. The offsets doc only fully verifies B as bit
  `0x10`, so decoding must be conservative: report raw words always, decode B,
  and decode any other bits only if the implementation has a named mapping with
  a local comment.
- Existing line selection remains home `0xFFC6E5`, away `0xFFCA48`, `u8`.
- `gmode` at `0xFFC2EA` is a full `u16` state word for clock semantics: the
  clock decrements only when the full word is `0x0000`. The low-byte bit0 still
  functions as an interaction/stoppage gate, but it is not a complete
  clock-stopped detector because faceoff, goal, period-end, and other
  presentation states stop the clock through high-byte values.

## User-Facing Output

`nhl94_state` will add a block after the current clock/carrier/camera/context
lines:

```text
control:
  home(team0): human active=s4 switch_debounce=0(ready) line=Sc1 raw_active=0x0004
  away(team1): CPU active=none switch_debounce=12(gated 12f) line=Chk raw_active=0xFFFF
  mode: 1P-CPU inferred from active control slots; coop_unverified=true
  input_route: player1 likely controls home/team0 -> s4; player2 inactive/CPU; route_verified=true
  pad_words: word0@0xFFBEEE=0x0010(B) word1@0xFFBEF0=0x0000 word2@0xFFBEF2=0x0000 word3@0xFFBEF4=0x0000
  caveat: c1playernum=0x0000 c2playernum=0x0000 are reported raw only; they are not active skater indices and are not used for mode/input_route inference
```

The exact labels can be compact, but the block must always include:

- team0/home active control status
- team1/away active control status
- inferred mode
- controller-to-team route guidance plus `route_verified=true|false`
- pad raw words with conservative decoded button names
- raw `c1playernum` / `c2playernum` caveat

Always include raw hex for active slots, pad words, and `c1/c2` in this block.
`raw:true` does not add additional control-context fields in the first pass.

`nhl94_state` should also add per-slot decoded role/control labels from the
existing slot struct read. Compact normal output should expose the agent-critical
facts, while `verbose:true` may include more detail:

```text
s4: x=... | ... | dir=... frame=...
     anim=...
     role=assnearest(q7=17) team=home human_active=true active_player=false attack_dir=bottom pf=0x88
```

Required per-slot decoded labels:

- `team=home|away` from `pf & 0x40`
- `human_active=true|false` from `pf & 0x08`
- `active_player=true|false` from `pf & 0x20`
- `attack_dir=bottom|top` from `pf & 0x80` with wording treated as a raw
  direction bit label, not a strategic assertion
- `role=<name>(qN=<idx>)`, where `N` is `assidx` and `<idx>` is `assq[assidx]`
- raw `pf=0xNN`; in verbose output also show `assidx` and the eight `assq`
  bytes so unresolved role questions remain inspectable

The slot whose `human_active=true` should line up with the matching active
control word when `$C320/$C322` is a valid slot. If they disagree, print a
warning such as `control_pointer_mismatch=true` on the affected slot or control
block. Do not override either signal; both are reported facts.

The existing phase/clock lines should be corrected:

- `play: running` only when full `gmode == 0x0000`
- `play: stopped` when full `gmode != 0x0000`
- `interaction_gate` remains based on `gmode & 1`
- raw/diagnostic text should show `gmode` as a 16-bit word, not only the low byte

## Mode Inference

Infer from active controlled slot words:

- both teams active slots are `0xFFFF`: `CPU-CPU`
- team0 active and team1 `0xFFFF`: `1P-CPU`
- team0 `0xFFFF` and team1 active: `CPU-1P`
- both teams active: `1P-2P`
- any active word outside `0..11` and not `0xFFFF`: `unknown`
- `2P-CPU` / same-team co-op cannot be disambiguated from the active-slot words
  alone in the first implementation. Do not emit `2P-CPU` until manual capture
  proves how two human pads on one team appear in RAM; include
  `coop_unverified=true` on one-human-team snapshots (`1P-CPU` / `CPU-1P`) so
  agents know that co-op mode has not been ruled out by RAM alone.

Also validate team/slot consistency:

- team0/home should normally be slots `s0..s5`
- team1/away should normally be slots `s6..s11`
- if the pointer is a valid slot but on the other team's side, print
  `slot_team_unexpected=true` with the observed slot. Do not call the pointer
  invalid; the slot value itself is valid, but it disagrees with the documented
  normal home/away slot partition.

## Input Route Derivation

`input_route` must be paired with a machine-readable `route_verified` boolean.

- `route_verified=true` only when the route matches a verified source fact or a
  later manual-capture artifact.
- `route_verified=false` when the route is inferred from active slots but
  controller-port-to-team binding is not yet verified for that mode.
- `c1playernum` and `c2playernum` are never inputs to mode or route inference in
  this pass; they are reported raw only.

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
inference. Manual capture should also verify the held/edge and P1/P2 ordering of
`0xFFBEEE/BEF0/BEF2/BEF4` before those words are renamed from `pad_word_N`.

## Data Flow

Extend `src/nhl94.ts` with named globals for the control offsets, helper
formatters, and role/control decoders:

- `active_control_home`, `active_control_away`
- `c1playernum`, `c2playernum`
- `switch_debounce_home`, `switch_debounce_away`
- `pad_word_0`, `pad_word_1`, `pad_word_2`, `pad_word_3`
- `ROLE_NAMES` / `roleName(idx)` for verified `asstab` role labels
- `decodeSlotControl(rec)` or equivalent helper for `pf`, `assidx`, and `assq`

Extend the `nhl94_state` global `read_many` list in `src/tools.ts` to read those
fields in the same globals round-trip. Format the new block from those values
without adding bridge commands or changing Lua protocol. Prefer a read-only
control-offset table over adding these fields to the generic `G` map if adding
them would make `nhl94_fields` expose semantic writes to control state.

Extend the `nhl94_state` struct read field list to include `assidx` and
`assq0..assq7` at offsets `+0x36` and `+0x38..+0x3F`. `pf` is already present in
verbose output; it should now be interpreted for all state output that includes
slot lines.

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
- `nhl94_state` reports `CPU-1P` when team0 is `0xFFFF` and team1 points to a
  valid away slot.
- `nhl94_state` reports `1P-2P` when both active words point to valid team slots.
- `nhl94_state` reports `unknown` when an active word is outside `0..11` and not
  `0xFFFF`.
- `nhl94_state` marks `slot_team_unexpected=true` when a control pointer points
  to the other team's slot range.
- `input_route` and `route_verified` are asserted for the `1P-CPU` case.
- The `c1playernum` / `c2playernum` caveat line is present and not used as proof
  of CPU or human control.
- Nonzero switch debounce renders as gated, e.g. `switch_debounce=12(gated 12f)`.
- Pad output includes raw hex and decodes B from bit `0x10`.
- Tests assert the `read_many` request uses the verified addresses and widths.
- Tests assert the new control reads are included in the same existing
  `nhl94_state` globals `read_many` round-trip, not a new bridge call.
- `nhl94_state` decodes `pf` bit3 as `human_active=true` on the controlled
  skater.
- `nhl94_state` decodes `pf` bit5 as `active_player=true` without confusing it
  for the human-active bit.
- `nhl94_state` decodes `pf` bit6 as home/away team and bit7 as the attack
  direction label.
- `nhl94_state` reads `assidx` plus `assq0..assq7` in the slot struct request and
  prints the role name from `assq[assidx]`.
- `nhl94_state` reports unknown role indices as `role_unknown(<idx>)` instead of
  guessing.
- `nhl94_state` marks a mismatch when `$C320/$C322` points to a slot but that
  slot lacks `pf bit3`.
- `nhl94_state` treats full `gmode != 0` as `play: stopped` even when bit0 is
  clear, while `interaction_gate` still reports the bit0 gate separately.

## Non-Goals

- Do not reverse-engineer the unresolved meaning of `c1playernum`,
  `c2playernum`, or `$D05A/$D05C` in this pass.
- Do not mutate game control state.
- Do not extend the OSD overlay in this pass.
- Do not change `bizhawk_play_input_sequence` semantics.
- Do not add new public `nhl94_read` field aliases in this pass; focus the new
  NHL94-specific translation in `nhl94_state`.
- Do not bump `PROTOCOL_VERSION` / `BRIDGE.protocol`; this is a server-side tool
  surface and formatting change. Implementation release work still bumps
  `src/version.ts`, `package.json`, and `lua/bridge_JD.lua` `BRIDGE.version` +
  changelog together per `CLAUDE.md`.
- Do not claim a full button mapping unless every bit is verified or already
  documented elsewhere in this repo.
