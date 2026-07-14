# Changelog

All notable changes to this project will be documented in this file.

The format is based on [Keep a Changelog](https://keepachangelog.com/en/1.1.0/),
and this project adheres to [Semantic Versioning](https://semver.org/spec/v2.0.0.html).

## [Unreleased]

<!-- No unreleased changes yet. -->

## [2026.7.3-jd] - 2026-07-14

### Changed

- **Wall-clock link watchdog** — the bridge's dead-link detection is now
  measured against the real clock (`now_ms()` via .NET `DateTime.Now.Ticks`)
  instead of frame counts. `DEAD_AFTER_MS` (10 s) and `RECONNECT_INTERVAL_MS`
  (5 s) now mean actual seconds regardless of emulation speed. The old
  frame-counted timers drifted with speed — turbo fired "~10 s" in under a
  second, pause stretched it — because the poll loop is `emu.yield()`-driven.
- **Wider per-call state block, minus the static bits** — the compact `state`
  summary that rides along on state-mutating tools now carries the *dynamic*
  fields an agent re-checks after acting: `framecount`, `paused`, `lag_count`,
  `is_lagged`, `current_memory_domain`. `rom_hash` (static, ~40 chars) was
  dropped from the block — it remains in `get_info`. Net effect: the state line
  is *cheaper* than before while carrying more useful signal.

### Added

- **Inline state on more tools** — `press_buttons`, `load_slot`, `pause`,
  `unpause`, and `reset` now append the `State: …` line (joining `load_state` /
  `frame_advance` / `play_input_sequence` / `run_trials`), so agents stop firing
  `get_info` just to re-read framecount / pause / domain after acting. Additive
  and back-compatible: the bridge handlers now return `{state}` instead of a
  bare `true`, and the server prints nothing extra if the block is absent.

### Fixed

- **Freeze address validation** — freezing an address outside its target
  domain (classic case: a full 68K bus address like `0xFFB04A` frozen into the
  64 KB `68K RAM` domain) previously slipped past `write_*` (which only *warns*)
  and then re-logged `attempted write to N outside the memory size of M` every
  single frame, since freeze re-asserts per frame — flooding the console until
  unfrozen. The bridge now range-checks against the domain size up front and
  rejects the freeze call once with a clear message (suggesting the `& 0xFFFF`
  mask or the full-address bus domain — `System Bus` on NES/SNES, `M68K BUS` on
  Genesis). Best-effort: skipped on builds lacking `memory.getmemorydomainsize`.

## [2026.7.2-jd] - 2026-07-14

> Version scheme change: the mcp-bizhawk server and the `bridge_JD.lua` client
> both move to calendar versioning (server version.ts + npm `package.json`, and
> the bridge's `BRIDGE.version`, all kept in lockstep).

### Added

- **Millisecond timestamps on bridge console output** — every `bridge_JD.lua`
  console line is now prefixed with a friendly local-timezone timestamp to the
  millisecond, e.g. `[09:19:32.947] [mcp-bizhawk] << get_info {}`. Sourced from
  .NET `DateTime.Now` via `luanet` (the only sub-second wall clock the build
  exposes), with a second-resolution `os.date` fallback.
- **`bizhawk_run_trials`** — a savestate-anchored input sweep. Give it a
  `state_path` and a list of `trials` (each with its own `frames`); it reloads
  the baseline before every trial (so trials are independent), plays that
  trial's inputs, and reads a shared `observe_memory` set at the final frame,
  optionally capturing one screenshot per trial. Replaces the manual loop of
  `load_state` → `play_input_sequence` → read repeated once per candidate
  (3+ round-trips each) with a single call and one compact per-trial table.
  Requires bridge_JD.lua ≥ 2026.7.2-jd.
- **`load_state_path` on `bizhawk_play_input_sequence`** — optionally reload a
  baseline `.State` immediately before playback, in the same round-trip. The
  load lands before the `stop_on_memory_change` baseline read and frame 0,
  collapsing the common `load_state` + `play` trial loop into one call.
- **`observe_every` on `bizhawk_play_input_sequence`** — capture `observe_memory`
  readings every N frames WITHOUT taking a screenshot, for a dense per-frame RAM
  trace that returns as text only (no inlined PNGs). Decouples the memory
  cadence from `screenshot_every`, which previously forced a screenshot at every
  observation point. `screenshot_every` still wins if both are given.
- **`describe` (local vision model) on `bizhawk_screenshot`,
  `bizhawk_play_input_sequence`, and `bizhawk_run_trials`** — with `describe:
  true` (+ optional `describe_prompt`), the server sends each screenshot to a
  configured local OpenAI-compatible vision model and returns its **text**
  description instead of the binary image — a large token saving on dense or
  multi-screenshot runs. Configured via server env: `VISION_BASE_URL`,
  `VISION_MODEL` (both required), `VISION_API_KEY`, `VISION_DEFAULT_PROMPT`,
  `VISION_TIMEOUT_MS`, `VISION_MAX_BYTES`. Requesting `describe` without config
  errors clearly; a per-image vision failure degrades to an inline note without
  losing the run's memory data.
- **Lag frames + server version in the live OSD** — the overlay header now
  shows cumulative lag frames (`lag N`, with a trailing `*` when the current
  frame is a lag frame), and the version line now shows the paired
  mcp-bizhawk **server** version (`srv vX`) next to the bridge version.

### Changed

- **State summary on frame-changing commands** — `bizhawk_load_state`,
  `bizhawk_frame_advance`, and `bizhawk_play_input_sequence` now append a
  `State: frame N, running|paused, rom HASH` line when the bridge supplies it
  (bridge_JD.lua ≥ 2026.7.2-jd), so agents stop calling `bizhawk_get_info`
  just to re-check framecount/pause after acting. Older bridges omit the block
  and the line simply doesn't appear. Internally the bridge's `frame_advance`
  now returns `{framecount, state}` instead of a bare number; the server
  accepts either shape, so a new bridge against an older server degrades
  gracefully.
- **Version scheme** — reported server version and the bridge (`bridge_JD.lua`)
  version both move to calendar versioning, `2026.7.2-jd`.

## [0.5.8-jd] - 2026-07-14

### Changed

- **phys_trace gains a `frac` column** (bridge_JD.lua ≥ 0.16.0) — the low word
  of the 32-bit skater heading longword @ slot struct +0x54, appended LAST so
  existing column order/values are unchanged. `fdir` (already emitted) is the
  octant high word; `frac` @+0x56 is the fine fraction. Columns are now
  `tick,frame,d7,pad,x,xsub,y,ysub,xv,yv,fdir,frac`. Updated the
  `bizhawk_phys_trace_tail` description accordingly (11 → 12 columns).

## [0.5.7-jd] - 2026-07-13

### Added

- **`bizhawk_phys_trace_start` / `_stop` / `_status` / `_tail`** — first-class
  MCP tools for the bridge's physics-sync trace (one CSV row per NHL94
  `updateplayers` physics tick, each carrying the per-pass D7 step multiplier),
  replacing the `eval_lua` global-alias workaround. `_start` is retail
  nhl94.gen ONLY (hash-guarded, requires `event.on_bus_exec`) and suppresses
  the per-video-frame `bizhawk_trace_*` writer while active; `_stop` re-enables
  it. Columns: `tick,frame,d7,pad,x,xsub,y,ysub,xv,yv,fdir`; default path
  `/tmp/nhl94_phys_<port>.csv`. Requires bridge_JD.lua ≥ 0.15.0.

## [0.5.6-jd] - 2026-07-13

> Version note: jumps from 0.5.2-jd directly to 0.5.6-jd. The numbers
> 0.5.3–0.5.5 were historically used by the bridge script's own versioning
> (bridge_JD v0.5.3 per-port trace, v0.5.4 animation OSD, v0.5.5 rename)
> before it diverged onto its own line (0.10+); the server skips them so no
> number ever refers to two different things.

### Added

- **`bizhawk_memory_ops`** — apply a mixed batch of memory operations
  (`ops: [{op: "write"|"freeze"|"unfreeze", address, value?, width?,
  domain?}, ...]`) in one bridge round-trip, all landing between the same
  two frames so the game never runs on a half-applied set. Top-level
  `width`/`domain` act as per-op defaults; ops apply in order, and an op
  that errors aborts the rest but keeps earlier ops applied. Requires
  bridge_JD.lua ≥ 0.12.0.

### Changed

- **Live OSD shows gameplay state in its own window** — the per-slot readout
  now displays x/y position, facing direction, and x/y velocity (plus puck
  position/velocity) instead of sprite/animation internals; the animation
  fields remain available in the trace CSV (`s<n>_frame/anim/spanum/attr`).
  When the BizHawk build supports `gui.createcanvas`, the OSD renders into a
  separate LuaCanvas window instead of overlaying the game; it falls back to
  the on-game `gui.text` overlay if the canvas can't be created or dies
  mid-run. bridge_JD.lua 0.13.0.
- **OSD 2x size + puck carrier and game globals** — the canvas window is
  doubled (24pt font, 32px lines); a header line shows the game clock as
  M:SS (0xFFC468 stores seconds remaining), the clock run/stop bit, and
  which slot is carrying the puck (0xFFB7AA = slot index, negative when
  loose — both verified against live gameplay); the carrier's row is
  starred; a footer line shows shotplayer/lastplayer and pass
  direction/speed. bridge_JD.lua 0.14.0. (0.14.1: the run/stop indicator
  was reversed — `gmode` bit 0 set means the clock is *stopped*; note the
  trace CSV's `clockrun` column records the raw bit and is therefore
  actually a clock-stopped flag.)
- **HELLO banner de-decorated** — the bridge's "connected to mcp server
  vX.Y.Z" console line is no longer wrapped in `***`. bridge_JD.lua 0.14.2.

### Fixed

- **bridge_JD.lua no longer loops forever when BizHawk is launched without
  `--socket_ip`/`--socket_port`** — the `comm.socketServer*` functions exist
  even with no target configured, so the script used to pass its capability
  check and then spin the auto-reconnect loop ("link dead — re-dialing...")
  every ~5s indefinitely. It now detects the unconfigured target at startup
  (reading GetIp/GetPort via pcall, since some builds throw when
  uninitialized) and exits cleanly with a FATAL message. bridge_JD.lua
  0.12.1.

## [0.5.2-jd] - 2026-07-13

### Added

- **HELLO greeting** — the server now answers the first message of every
  bridge connection with `HELLO {"server_version": "..."}` instead of `NONE`;
  bridge_JD.lua (≥ 0.11.0) logs
  `*** [mcp-bizhawk] bizhawk connected to mcp server vX.Y.Z ***` to the Lua
  Console, including after auto-reconnect redials (a reprinted banner
  doubles as reconnect confirmation). An older bridge meeting a new server
  logs a one-time parse-error RESULT that the server safely ignores; a new
  bridge meeting an older server simply never prints the banner.

## [0.5.1-jd] - 2026-07-13

### Added

- **Batch freeze/unfreeze** — `bizhawk_freeze` accepts
  `entries: [{address, value, width?, domain?}, ...]` to pin many addresses
  in one call (top-level `width`/`domain` act as per-entry defaults), and
  `bizhawk_unfreeze` accepts `addresses: [...]` to release a batch sharing
  the top-level `domain`. Single-address calls are unchanged. Requires
  bridge_JD.lua ≥ 0.10.0 (an older bridge errors with "address required"
  on batch calls).

## [0.5.0-jd] - 2026-07-13

### Added

- **`bizhawk_get_input`** — read the current joypad state for a player
  (held buttons + analog axes) without advancing frames; complements
  `bizhawk_record_input`'s per-frame sampling.
- **`bizhawk_disassemble`** — decode one or more machine instructions at a
  given address or the current PC (`emu.disassemble`), for reading the
  code around a `bizhawk_trap_memory` hit.
- **`bizhawk_osd_message`** — draw a short message in BizHawk's on-screen
  OSD area (`gui.addmessage`), for annotating recorded GIFs/demos or
  marking progress during a live session.
- **`unpause` option on `bizhawk_eval_lua`** — runs the chunk via the
  bridge's pause-safe path, temporarily unpausing so `emu.frameadvance()`
  calls inside the chunk don't block forever, then restores the prior
  pause state afterward.

### Changed

- **`bizhawk_get_info` reports more emulator state** — `system_id`,
  `paused`, `lag_count`/`is_lagged`, and `movie_loaded`/`movie_mode` are
  now included when the loaded core/build exposes them.
- **Bridge echoes received commands to the Lua Console** — every
  dispatched RPC (and any handler error) now logs a
  `[mcp-bizhawk] << <method> <params>` line, making it possible to watch
  exactly what the server is sending in real time from BizHawk's Lua
  Console.
- Bridge bumped to v0.9.0 for this release (get_info+, get_input,
  disassemble, osd_message, eval_lua unpause, console command-echo).

## [0.4.0-jd] - 2026-07-13

### Added

- **`bizhawk_get_registers` / `bizhawk_set_register`** — CPU register
  access (core-dependent; 68K cores expose PC/D0-D7/A0-A7).
- **`bizhawk_trap_memory`** — run until the CPU writes/reads/executes an
  address (event.on_bus_*, core-dependent) and report the registers (PC)
  at the moment of access. Timeout is a result, not an error.
- **`bizhawk_record_input`** — sample the human's joypad per frame (RLE,
  optional stop-on-memory-change) into a play_input_sequence-ready list.
- **Native movie control** — `bizhawk_movie_play` / `movie_stop` /
  `movie_status` wrap BizHawk's movie engine for deterministic .bk2
  playback (recording new movies from Lua is not exposed; out of scope).
- **Named savestate slots** — `bizhawk_save_slot` / `load_slot` /
  `list_slots`, stored server-side under $MCP_BIZHAWK_STATE_DIR (default
  ~/.mcp-bizhawk/states) namespaced by ROM hash. No path bookkeeping.
- **Trace control** — `bizhawk_trace_start` / `trace_stop` /
  `trace_status` manage the bridge's per-frame CSV at runtime;
  `bizhawk_trace_tail` returns the header + last N rows.

### Changed

- Bridge bumped to v0.8.0 for this release (registers, trap_memory,
  record_input, movie control, trace control).

## [0.3.0-jd] - 2026-07-13

### Added

- **`bizhawk_freeze` / `bizhawk_unfreeze` / `bizhawk_list_frozen`** —
  cheat-style pinned writes re-asserted after every emulated frame
  (including frames inside batched commands). Freeze runs before the trace
  hook, so the trace records enforced values.
- **`bizhawk_eval_lua`** — arbitrary-Lua escape hatch; the chunk runs in
  the bridge with BizHawk's full Lua API, result comes back JSON-encoded.
- **RAM search sessions** (`bizhawk_search_begin` / `search_filter` /
  `search_results` / `search_end`) — Cheat-Engine-style two-snapshot
  hunting with the snapshot held bridge-side. Conditions:
  eq/ne/gt/lt/changed/unchanged/increased/decreased. Window cap 2 MiB.

### Changed

- **Version visibility.** The server version now appears on the
  `bizhawk.ts` client-lifecycle log lines (`[mcp-bizhawk vX.Y.Z-jd] ...`),
  and the bridge version appears on the in-game OSD overlay
  (`bridge_JD vX.Y.Z`), so both sides of the connection are identifiable
  at a glance. Bridge bumped to v0.7.0 for this release (freeze, eval_lua,
  RAM search).

### Fixed

- **Bridge trace-open can no longer crash the poll loop.** A failed
  trace-file open (e.g. a stale path) previously threw from `assert()`
  before the main loop started, leaving the bridge TCP-connected but
  never polling (silent-dead). It now warns and disables the trace
  instead of throwing.

## [0.2.0-jd] - 2026-07-13

### Added

- **Inline screenshots.** `bizhawk_screenshot` now returns the PNG as an
  inline image content block (and `path` is optional — defaults to a temp
  file). Agents see the screen in the tool response, no filesystem access
  needed.
- **`bizhawk_read_many`** — labeled batch reads (`{name, address, width,
  domain}` specs) in one bridge round-trip; output is `name = value` lines
  in request order.
- **`bizhawk_read_struct_array`** — decode N fixed-stride records (entity
  tables) into labeled fields in one call. Cap: count × fields ≤ 4096.
- **Signed + big-endian widths everywhere** — the width set is now
  u8/s8/u16/s16/u32/s32 plus `_be` variants, accepted by `read_many`,
  `read_struct_array`, `observe_memory`, `stop_on_memory_change`, and
  `wait_for_memory`.
- **`turbo` option** on `bizhawk_frame_advance`, `bizhawk_wait_for_memory`,
  and `bizhawk_play_input_sequence` — runs the batch at max speed with
  rendering disabled (rendering stays on when screenshots are requested);
  restores 100% speed + visible rendering afterwards.
- **Test suite** — `npm test` drives the real tool layer through an MCP
  in-memory client against a `FakeBridge` that speaks the Lua bridge's TCP
  protocol; plus `scripts/smoke-live.cjs` for verification against a live
  BizHawk.
- **Genesis-friendly big-endian memory access.** `bizhawk_read16`/`read32`/
  `write16`/`write32` take an optional `byteorder: "le" | "be"` parameter
  (default `"le"`, backward compatible), mapped to BizHawk's native
  `memory.*_u16_be`/`*_u32_be` functions. `observe_memory`,
  `stop_on_memory_change`, and `wait_for_memory` accept the new widths
  `"u16_be"` / `"u32_be"`. No more read_range + manual `(hi << 8) | lo`.
- **`bizhawk_wait_for_memory` tool** — frame-advance until a memory value
  satisfies a condition (`eq`/`ne`/`gt`/`lt`/`change`) or a frame budget
  (default 600) runs out. Returns `matched`, `frames_waited`, and the final
  value; a timeout is a result, not an error. Replaces "guess how many
  frames until RAM initializes" with an explicit synchronization primitive.
- **Run-length-encoded input: `hold` on `bizhawk_play_input_sequence`
  frame entries** — `{buttons: {...}, hold: 60}` repeats the input for 60
  consecutive frames (re-asserted each frame). Long sequences no longer
  need one JSON entry per frame, eliminating oversized-payload truncation.
- **Bridge identity in `bizhawk_get_info`** — the bridge now reports
  `bridge: {name, version, pause_safe}`; the tool output surfaces it as a
  positive "pause-safe" signal instead of inferring health from the absence
  of a missing-capabilities warning.

### Changed

- **Frame-scaled RPC timeouts.** `bizhawk_play_input_sequence`,
  `bizhawk_frame_advance`, and `bizhawk_wait_for_memory` now compute their
  timeout from the requested frame count (20 ms/frame + 5 s margin, never
  below the flat default) instead of dying at the flat 10 s limit —
  multi-thousand-frame batches are now safe.
- **Bridge renamed: `lua/bridge.lua` → `lua/bridge_JD.lua`** (v0.5.5) —
  the modified bridge carries its own name/version so `get_info` can
  positively identify which script is loaded. It also gains an optional
  per-frame NHL94 trace CSV + on-screen animation overlay (game-specific;
  set `TRACE_PATH`/`TRACE_OSD` to nil/false to disable for other ROMs).
- **Pause overhaul in `lua/bridge_JD.lua`** — pause control uses
  `client.pause`/`client.unpause`/`client.ispaused` (the previous
  `emu.pause`/`emu.unpause` don't exist in BizHawk), and the main poll loop
  idles on `emu.yield()` instead of `emu.frameadvance()` so the bridge
  keeps servicing RPCs while paused — pausing (from the API *or* the
  keyboard) no longer wedges the bridge. Frame-locked handlers
  (`frame_advance`, `play_input_sequence`, `wait_for_memory`) briefly
  unpause and restore the paused state afterwards.
- **`bizhawk_load_state` preserves pause state.** The bridge re-pauses in
  the same Lua callback as `savestate.load`, so zero frames run between
  load and re-pause. New optional `pause: true` parameter forces a paused
  state after load regardless of prior state; output reports
  `(paused/running)`.
- **Bridge auto-reconnect reworked** (verified against BizHawk 2.11.1
  source): `comm.socketServerConnect` does not exist in 2.11.x — the
  re-dial primitive is `comm.socketServerSetIp(comm.socketServerGetIp())`,
  which rebuilds and re-dials the socket. Liveness is now "bytes received
  recently" (the server answers every frame's READY with at least NONE);
  `socketServerIsConnected` is ignored because its backing flag is never
  cleared. The watchdog re-dials every ~5 s once the link is silent for
  ~10 s or a send fails, and re-applies the receive timeout after each
  re-dial (a fresh socket otherwise blocks forever).
- **BREAKING: minimum Node version raised from >=18 to >=22.** Node 18 (EOL
  April 2025) and 20 (EOL April 2026) are no longer supported; only active
  LTS lines are. CI matrix now tests Node 22 + 24, and workflow actions
  bumped to `actions/checkout@v5` / `actions/setup-node@v5` (the v4 actions'
  Node 20 runtime is deprecated by GitHub as of June 2026).

### Fixed

- **`bizhawk_play_input_sequence` no longer crashes when zero observations
  are captured.** A Lua empty table serializes to JSON `{}` (object, not
  array), which broke the Node handler's iteration whenever neither
  `screenshot_every` nor `observe_memory` was requested. The bridge now
  omits the key entirely and the server guards with `Array.isArray`.
- **Batched frames are no longer missing from the bridge's trace CSV** —
  `trace_tick()` runs after every `emu.frameadvance()` inside command
  handlers (`play_input_sequence`, `frame_advance`, `wait_for_memory`),
  and dedupes on `emu.framecount()` so re-entrant `emu.yield()` can't
  write duplicate rows.

## [0.1.5] - 2026-05-15

Tier 3 of agent-vision: labeled memory observations alongside screenshots,
and stop-on-memory-change for goal-driven play that terminates early
instead of running fixed-length batches past the goal.

### Added

- **`observe_memory` parameter on `bizhawk_play_input_sequence`** —
  array of `{name, domain, address, width}` reads to perform at each
  observation point (alongside any screenshot from `screenshot_every`).
  Each observation in the result includes a `memory: {name: value, ...}`
  field with the labeled readings. Width is `"u8"` | `"u16"` | `"u32"`.
  Lets the agent see screenshot + Samus's HP + X/Y + room ID all in one
  observation block instead of having to make follow-up reads.
- **`stop_on_memory_change` parameter on `bizhawk_play_input_sequence`** —
  `{domain, address, width}`. The bridge reads the value before the
  first frame, re-reads after every frame, and aborts the sequence the
  moment it changes. Result includes `stopped_early: true` and
  `stop_reason: 'memory_changed'`. A final observation is always
  captured at the stop frame regardless of the normal cadence. Killer
  use case: watch the room ID — Samus walks through a door, room ID
  changes, play stops at the exact transition frame.

### Why this matters

With Tier 2 (v0.1.4) the agent could SEE Samus's trajectory inline.
With Tier 3 the agent can ALSO see numerical state at each
observation point (HP, position, room ID, etc.) AND have the bridge
auto-terminate when a goal is reached, instead of overshooting by 100
frames because the play batch was sized too long. The pattern:

```
play 200 frames with:
  screenshot_every: 60
  observe_memory: [{name:"x",domain:"WRAM",address:0xAF6,width:"u16"},
                   {name:"room",domain:"WRAM",address:0x79B,width:"u16"}]
  stop_on_memory_change: {domain:"WRAM",address:0x79B,width:"u16"}
→ stopped at frame 134, screenshots show approach to door,
  per-obs x position confirms forward progress, final obs shows
  new room ID
```

That's a complete "walk forward until I reach the next room"
abstraction in one tool call.

[0.1.5]: https://github.com/dmang-dev/mcp-bizhawk/releases/tag/v0.1.5

## [0.1.4] - 2026-05-15

Agent-vision pass — inline screenshots during input playback, so agents
driving the bridge can SEE the trajectory of an input batch in the
same tool call that runs it.

### Added

- **`screenshot_every` parameter on `bizhawk_play_input_sequence`** —
  if set, the bridge captures a PNG every N frames during playback
  (plus one extra at the final frame). The Node side reads each PNG
  back from disk, base64-encodes, and returns the screenshots as
  inline `image` content blocks in the MCP tool response. The agent
  sees Samus's whole trajectory in one round-trip — no separate
  screenshot/read calls, no temp-file management.
- **`screenshot_dir` and `screenshot_prefix` parameters** — control
  where screenshots land on disk and what they're named. Defaults:
  `C:/temp` and `obs`. Files are named `<prefix>-NNNN.png` where NNNN
  is the zero-padded frame offset within the batch.

### Why this matters for agent-driven play

Without inline observation, an agent playing the game has to:
1. Send an input batch
2. Wait for it to finish
3. Call screenshot to a path
4. Read the PNG back to view it
5. Decide next move
6. Send next batch

Each "look" between batches is multiple tool calls AND lets the bridge
idle-tick the game forward during the agent's thinking time (which we
empirically measured at ~1800 frames lost per 30 seconds of agent
think-time during the Super Metroid play session in v0.1.3). With
`screenshot_every` baked into the play call itself, observation
happens DURING the play (at exact frame offsets), and the agent sees
multiple snapshots inline in the same response. No drift, full
observability, one round-trip.

### Empirical validation

Tested against Super Metroid Ceres opening: a 200-frame batched play
with `screenshot_every: 60` returned 4 PNGs inline showing Samus's
exact trajectory (walking right, falling mid-air, landing, walking
right again). All visible in one tool response without any follow-up
read calls.

## [0.1.3] - 2026-05-15

Batched input-playback RPC delivers a 5× wall-clock speedup for multi-frame
input sequences — enabling near-native-speed `.bk2` movie replay through the
bridge instead of a 12-fps stuttery crawl.

### Added

- **`bizhawk_play_input_sequence`** — new MCP tool that takes a `frames`
  array (each element is `{buttons, player}`) and runs `joypad.set +
  emu.frameadvance` per element ENTIRELY SERVER-SIDE in a single bridge
  round-trip. Empirically validated against a 1242-frame Super Metroid
  `.bk2` movie: per-frame mode (looping `press_buttons` +
  `frame_advance(1)` from the client) took 103.3 seconds at 12 fps
  wall-clock; batched mode (one RPC per 200 frames) took **20.9 seconds
  at 59.4 fps** — within 1% of native 60fps emulation speed.
- **`play_input_sequence` Lua handler** in `bridge.lua` — the batch
  driver. Iterates `frames`, calls `joypad.set` then `emu.frameadvance`
  per element, returns `{played, final_framecount}`. Blocks the bridge's
  outer poll loop for the duration of the call (no interleaving with
  other RPCs, no heartbeat), so callers should chunk long sequences
  into batches of ≤200 frames to keep the bridge responsive.
- **`scripts/replay-bk2.cjs` now uses batched mode by default** — chunks
  the parsed input log into 200-frame batches and ships each via
  `play_input_sequence`. The per-batch progress log now reports
  `final_framecount` for verification.

[Unreleased]: https://github.com/dmang-dev/mcp-bizhawk/compare/v0.5.0-jd...HEAD
[0.5.0-jd]: https://github.com/dmang-dev/mcp-bizhawk/releases/tag/v0.5.0-jd
[0.4.0-jd]: https://github.com/dmang-dev/mcp-bizhawk/releases/tag/v0.4.0-jd
[0.3.0-jd]: https://github.com/dmang-dev/mcp-bizhawk/releases/tag/v0.3.0-jd
[0.2.0-jd]: https://github.com/dmang-dev/mcp-bizhawk/releases/tag/v0.2.0-jd
[0.1.4]: https://github.com/dmang-dev/mcp-bizhawk/releases/tag/v0.1.4
[0.1.3]: https://github.com/dmang-dev/mcp-bizhawk/releases/tag/v0.1.3

## [0.1.2] - 2026-05-15

Bug fixes discovered during a live Super Metroid RAM-hunt session.

### Fixed

- **Orphan process on MCP client restart.** When the MCP client (Claude
  Code, Claude Desktop, etc.) exited, our stdio handshake closed but
  the TCP listener for `bridge.lua` kept the event loop alive — leaving
  an orphaned `node` process bound to port 8766. Every subsequent
  client restart then failed with `EADDRINUSE` until the orphan was
  manually killed. Added shutdown handlers in `src/index.ts` that
  listen for stdin close, `SIGINT`, and `SIGTERM` and call `bh.stop()`
  to release the port.
- **`bizhawk_press_buttons` description was misdocumented.** Previous
  text claimed `press_buttons + frame_advance(count=N)` would hold the
  button for all N frames. Empirically false: BizHawk's `joypad.set`
  is single-frame, so frames 2-N of the advance see no input.
  Confirmed on Super Metroid — a 60-frame advance after one
  `press_buttons(Right)` moved Samus the same +1 pixel as a 10-frame
  advance, proving frames 2-60 had no input held. Rewrote USAGE to
  mandate INTERLEAVED `press_buttons + frame_advance(1)` for
  multi-frame holds.

### Added

- **`docs/SUPER-METROID-ADDRESSES.md`** — WRAM address map for Super
  Metroid (Japan, USA), discovered live via `mcp-bizhawk`. Covers the
  Samus stats block (HP at `0x09C2` verified, missiles/supers/PBs/
  reserves at canonical offsets) and Samus position
  (`0x0AF6`-`0x0AFC`). Includes snapshot-diff hunt recipe and
  snap-rollback experimentation pattern.

## [0.1.1] - 2026-05-15

Tool description quality pass — written to Glama's Tool Definition Quality
Score (TDQS) rubric so every tool maximizes Purpose Clarity, Usage
Guidelines, Behavioral Transparency, Parameter Semantics, Conciseness,
and Contextual Completeness.

### Added

- **`current_memory_domain`** field in `bizhawk_get_info` output — reports
  which domain memory r/w tools default to when `domain` is omitted.
  BizHawk's "current" domain can drift after savestate loads or other
  Lua scripts changing it, so surfacing it explicitly avoids silent
  reads from the wrong address space.

### Changed

- **Every tool description rewritten to the PURPOSE / USAGE / BEHAVIOR /
  RETURNS template** — explicit error conditions ("Returns an error if
  domain is unknown / address out of range / value exceeds max"),
  explicit when-to-use-this-vs-sibling guidance ("for spans use
  bizhawk_read_range — one round-trip vs N frame-latency hops"),
  explicit destructive-behavior notes for every state-mutating tool
  ("DESTRUCTIVE: overwrites with no undo; snapshot via
  bizhawk_save_state first"), and explicit return-value shape.
- **Every parameter now has a `description`** that adds context beyond
  the JSON Schema (alignment requirements, address-space conventions,
  range justifications, units). Domain-parameter and address-parameter
  descriptions are factored into shared constants for consistency.
- **`additionalProperties: false`** added to all tool schemas to fail
  fast on misspelled parameter names.

## [0.1.0] - 2026-05-15

Initial public release.

### Added

- **Lua bridge (`lua/bridge.lua`)** that runs inside BizHawk's Lua Console,
  polling an external TCP server once per frame to ferry commands and replies.
  Runs on BizHawk 2.6.2+.
- **Pure-Lua JSON encode/decode (`lua/json.lua`)** with no external deps.
- **Node.js MCP server (`dist/index.js`)** that hosts the TCP listener
  BizHawk dials into. Inverted transport pattern compared to mGBA-style
  bridges: BizHawk's Lua doesn't have native server sockets, only an
  outbound `comm.socketServer*` client.
- **18 MCP tools**: `bizhawk_ping`, `bizhawk_get_info`,
  `bizhawk_list_memory_domains`, `bizhawk_read8/16/32`,
  `bizhawk_write8/16/32`, `bizhawk_read_range`, `bizhawk_write_range`,
  `bizhawk_press_buttons`, `bizhawk_pause`, `bizhawk_unpause`,
  `bizhawk_frame_advance`, `bizhawk_reset`, `bizhawk_screenshot`,
  `bizhawk_save_state`, `bizhawk_load_state`.
- **Multi-system support**: NES, SNES, GB/GBC/GBA, Sega
  Master System / Genesis / 32X / Saturn, N64, PSX, Atari
  2600/5200/7800, Lynx, ColecoVision, Intellivision, and more — every
  system BizHawk's cores cover. Memory r/w accepts an optional `domain`
  parameter so per-platform memory maps (`WRAM`, `VRAM`, `CARTROM`,
  `68K RAM`, `RDRAM`, `MainRAM`, etc.) are addressable directly.
- **Capabilities map** in `bizhawk_get_info` reports which optional
  emu/client/savestate/joypad/memory methods this BizHawk build exposes,
  so tools can return clean errors instead of `attempt to call a nil value`.
- **Cross-platform install paths**: `npm install -g mcp-bizhawk`,
  `npx -y mcp-bizhawk`, or clone-and-build.
- **GitHub Actions CI** building on Node 18/20/22 across
  Linux/macOS/Windows.
- **Dockerfile + glama.json** for the [Glama MCP registry](https://glama.ai/mcp/servers).

### Worked around (BizHawk Lua API quirks)

- BizHawk's socket server (since 2.6.2) requires **incoming** messages
  to be length-prefixed as `"{length:D} {message}"` — same framing it
  uses for outgoing. Without the prefix, BizHawk's parser silently
  drops the line and `socketServerResponse()` returns empty. The Node
  side now wraps every payload via a `sendFramed()` helper. Documented
  in `Lua/_docs_luacats/comm.d.lua` line 126; missed by us at first
  because our outgoing parser already strips the prefix.
- `comm.socketServerSend(s)` returns a NUMBER (status / bytes sent),
  NOT the server reply. To receive, you must call
  `comm.socketServerResponse()` separately. The bridge does receive
  first (carrying back the previous frame's reply) then send for the
  current frame, decoupling round-trip across a frame boundary.
- BizHawk exposes .NET methods as **userdata** with `__call`
  metamethods, not as plain Lua functions — so capability detection
  has to accept both (`type(v) == "function" or type(v) == "userdata"`).
- `memory.getmemorydomainlist()` returns a 0-indexed Lua table; the
  bridge re-packs into a contiguous 1-indexed array so the JSON
  encoder serializes it as a clean array rather than an object with
  string keys.

[0.1.2]: https://github.com/dmang-dev/mcp-bizhawk/releases/tag/v0.1.2
[0.1.1]: https://github.com/dmang-dev/mcp-bizhawk/releases/tag/v0.1.1
[0.1.0]: https://github.com/dmang-dev/mcp-bizhawk/releases/tag/v0.1.0
