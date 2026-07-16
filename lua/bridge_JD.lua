-- bridge_JD.lua: BizHawk-side polling client for mcp-bizhawk
-- v2026.7.18-jd  (was semver 0.16.0; version scheme now matches the server)
--
-- v2026.7.18-jd changes (server-side only; bridge unchanged): new nhl94_recipes
--   tool — a static "if you want to X, do Y" NHL94 use-case playbook (per-tool
--   when-to-use, end-to-end scenario sequences, verification patterns). Also sets
--   the MCP server `instructions` field to steer the model to call nhl94_recipes
--   FIRST for any NHL94 task. No bridge protocol change.
--   Bridge bumped in lockstep to keep the OSD version line collapsed.
--
-- v2026.7.17-jd changes (server-side only; bridge unchanged): nhl94_state now
--   marks the game globals (carrier/clock/period/play + camera vpos/hpos/yleader)
--   with a trailing `*` when their word is frozen, matching the per-target x/y/z/
--   xv/yv/zv markers that already existed. mapFrozenAddress already resolved
--   these to target "global"; the state renderer just wasn't displaying them.
--   Bridge bumped in lockstep to keep the OSD version line collapsed.
--
-- v2026.7.16-jd changes (server-side only; bridge unchanged): new NHL94
--   game-semantic MCP tools (nhl94_teleport / _freeze / _unfreeze / _state /
--   _park / _rig / _possession / _clock / _camera). They translate game nouns
--   (skaters s0-s11, puck pk) and whole-pixel coords into 68K addresses/widths/
--   endianness server-side and drive the EXISTING bridge commands (memory_ops /
--   read_struct_array / read_many / list_frozen / save_state / load_state) — no
--   new bridge protocol. Also trims the advertised tool surface to the nhl94_*
--   set plus a curated bizhawk_* core (ping/get_info/pause/unpause/frame_advance/
--   reset/press_buttons/play_input_sequence/screenshot/save_state/load_state/
--   read_many/disassemble/eval_lua + the trace and phys_trace suites); the rest are hidden from
--   tools/list but still dispatch, and BIZHAWK_ALL_TOOLS=1 re-exposes everything.
--   Bridge bumped in lockstep to keep the OSD version line collapsed.
--
-- v2026.7.15-jd changes (OSD paused-refresh + window hide/show):
--   * End key now HIDES/SHOWS the OSD window (WinForms Hide()/Show(), reachable
--     on the Windows build) instead of just blanking it; pcall-guarded so mono
--     falls back to the old blank-out. Hide/Show preserves window position/size.
--   * The OSD forces a one-time repaint (bypassing the paused throttle) on two
--     events that change displayed state without advancing a frame, so a PAUSED
--     panel no longer needs an End/End to catch up: (a) when the server's HELLO
--     version arrives at boot (fixes stale "srv v?"), and (b) after any MCP
--     command runs while paused (fixes "freeze a bunch while paused, nothing
--     turns red"). Running is unaffected — the throttle already refreshes it.
--
-- v2026.7.14-jd changes (OSD repaint throttle): the LuaCanvas OSD was repainted
--   every emulated frame. That repaint (Clear + per-line DrawText + Refresh)
--   measures ~5.5ms/frame plain and ~10ms once frozen addresses add the red
--   overlay draws — of a 16.6ms 60fps budget shared with emulation — so at 60Hz
--   it starved the core and dropped below 60fps (the "OSD-up + many frozen =
--   drag" symptom; it's GDI+ text/repaint cost, hence identical on Windows and
--   mono). The OSD now repaints only every Nth EMULATED frame via the global
--   OSD_REFRESH_EVERY (default 6 ≈ 10Hz; live-tunable through bizhawk_eval_lua,
--   e.g. `OSD_REFRESH_EVERY = 3` for ~20Hz). Throttle is keyed off
--   emu.framecount() (not poll count, since emu.yield() re-enters multiple times
--   per frame / while paused); toggling the OSD on forces an immediate repaint.
--   While PAUSED the throttle is bypassed for a single repaint of the current
--   frame (then idle), so a paused OSD always shows current state without
--   repainting on every UI tick. Server bumped in lockstep to keep the OSD
--   version line collapsed.
--   Also: OSD is DEFAULT ON again (reverts 7.9's default-off) now that the
--   throttle fixes the repaint cost that motivated turning it off. End key still
--   toggles.
--
-- v2026.7.12-jd changes (server-side only; bridge unchanged): dropped the MCP
--   (HTTP) client connect/disconnect logging added in 7.11 — only BizHawk-client
--   connect/disconnect/refusal is logged now. Bridge bumped in lockstep to keep
--   the OSD version line collapsed.
--
-- v2026.7.11-jd changes (server-side only; bridge unchanged): the daemon now
--   logs peer IP:port for both BizHawk (TCP :8766) and MCP (HTTP) clients on
--   connect and disconnect. Bridge bumped in lockstep to keep the OSD version
--   line collapsed.
--
-- v2026.7.10-jd changes (server transport: stdio -> HTTP; bridge unchanged):
--   * No functional bridge change. Version bumped in lockstep with the server,
--     which switched from a per-session stdio MCP process to a single always-on
--     streamable-HTTP daemon (many Claude sessions, one BizHawk). The bridge
--     still dials the same TCP socket (default :8766) and speaks the same
--     HELLO/READY/RESULT protocol; the daemon just owns that socket now instead
--     of a per-session process. Kept in sync so the OSD version line stays
--     collapsed rather than flagging a stale-component mismatch.
--
-- v2026.7.9-jd changes (OSD off by default + backtick toggle):
--   * The OSD is now OFF at startup. The separate LuaCanvas window's per-frame
--     repaint costs real emulation speed under Mono/Linux (audible audio
--     slowdown), so it no longer runs unless asked for. The window is created
--     lazily on first enable, so a session that never opens it pays nothing.
--   * Press the End key to toggle the OSD on/off at runtime. The key is polled
--     each frame via input.get() (BizHawk/SDL2 reports it as "End"), edge-
--     triggered so a held key flips once. trace_start/trace_stop's `osd` param
--     still works too. Turning it off blanks the window once (LuaCanvas exposes
--     no close to Lua) and stops the per-frame draw.
--
-- v2026.7.8-jd changes (freeze perf + OSD frame#):
--   * freeze_tick rewritten for scale. It re-asserts every frozen value each
--     frame; the old version paid a per-entry pcall + closure allocation +
--     getcurrentmemorydomain + domain switch/restore, so cost grew steeply with
--     the number of frozen addresses (measured ~3x slower at N=100). Now the
--     current domain is read ONCE, switched only when the target changes, and
--     the write body is a define-once function called via pcall-with-arguments
--     (no per-entry closure). Per-entry write isolation is preserved. Emulation
--     no longer visibly slows as you freeze more addresses.
--   * OSD system line gains the emulated frame counter ("frame N"), between rc
--     and lag.
--
-- v2026.7.7-jd changes (OSD: system/game split): all emulation telemetry moves
--   to ONE line at the TOP — client+server version, reconnect count (rc), and
--   lag frames (lag was previously on the game-clock line). Versions COLLAPSE to
--   a single "v…" when client and server match; when they differ they split to
--   "cli v… srv v…" and the OLDER build is drawn orange+bold to flag the stale
--   component. The two bottom "client v…"/"server v…" lines are gone (folded
--   up), so the game-clock line is now pure NHL94 and OSD_LINES drops 20→19.
--   Also: freezing the puck-carrier global (0xFFB7AA) now reddens the "carry
--   sN" value on the clock line — its dedicated readout — instead of the bare
--   "pk" label (0xFFB7AA physically sits at puck-slot offset 0x60, which has no
--   puck column). Other un-columned puck bytes still highlight the "pk" label.
--
-- v2026.7.6-jd changes (OSD layout): column header above the skater block;
--   skater rows drop inline field prefixes (header carries them); blank line
--   between skaters and the puck; puck split onto TWO lines (position/velocity,
--   then carrier ratings); client/server versions on their own lines ("client
--   v… rc N" / "server v…"); canvas narrowed 1280→896.
--
-- v2026.7.5-jd changes (OSD: per-field freeze highlight, period, more fields):
--   * Frozen-value highlight is now per-FIELD, not per-row: only the specific
--     pinned value (x/y/z/d/f/v/fl/st) turns red+bold, via a same-layout overlay
--     string drawn over the white line (exact monospace alignment).
--   * Clock line now leads with the PERIOD (gsp @0xFFC466: 1st/2nd/3rd/OT).
--   * Per-skater rows gain Z/airborne (+0x18), heading fraction (+0x56),
--     friction/flags (+0x62, hex) and stop/goalie gate (+0x34). Puck row gains
--     Z (+0x18), Zvel (+0x2C) and the carrier's ratings (shotpwr/acc, passacc,
--     energy @+0x6C/6D/6E/66). OSD canvas widened 640→1280, font 24→22 to fit.
--
-- v2026.7.4-jd changes (graceful-restart reconnect + OSD reconnect counter):
--   * The server now sends a framed "BYE" on graceful shutdown (SIGINT/SIGTERM/
--     MCP-client disconnect) BEFORE closing. On reading BYE the bridge marks the
--     link down and re-dials the restarted server — fixing the freeze where a
--     server restart left the bridge (and the whole emulator) wedged forever
--     inside socketServerResponse(). That call BLOCKS indefinitely on a closed
--     peer (no timeout/error/non-blocking probe exists in BizHawk 2.11.1 Lua —
--     verified: socketServerIsConnected/Successful and a send-first probe all
--     still report healthy right up to the blocking read), so the main loop now
--     GATES the read on the link being up and only re-dials while it's down.
--   * Re-dial is itself gated by a /proc/net/tcp LISTEN check (port_listening):
--     comm.socketServerSetIp does a BLOCKING connect that, against a dead port,
--     hangs the Lua thread until mono's hang-detector ABORTS EmuHawk (core
--     dump — verified). So the bridge now only attempts the connect once a
--     server is actually listening, and otherwise waits — a slow or absent
--     restart no longer crashes BizHawk; it reconnects whenever the server
--     returns.
--     NOTE: a hard crash / kill -9 of the SERVER sends no BYE, so the bridge's
--     next read blocks before the silence timeout can fire and it still wedges —
--     recover by reloading the Lua script. Graceful restarts (BYE) and silent
--     network drops (DEAD_AFTER_MS timeout) both recover on their own.
--   * OSD version line gains a reconnect counter ("rc N") — successful re-dials
--     since script load.
--
-- v2026.7.3-jd changes (wall-clock watchdog, wider state blocks, freeze guard):
--   * Link watchdog is now WALL-CLOCK, not frame-counted. New now_ms() reads
--     .NET DateTime.Now.Ticks//10000 (ms), so DEAD_AFTER_MS (10000) and
--     RECONNECT_INTERVAL_MS (5000) mean real seconds regardless of emulation
--     speed. The old tick counters drifted: turbo made "~10s" fire in <1s and
--     pause stretched it. last_rx_ms/last_reconnect_ms replace the tick vars.
--   * state_summary() grew to the dynamic fields agents re-check after acting:
--     framecount, paused, lag_count, is_lagged, current_memory_domain. rom_hash
--     (static) was DROPPED from the block — it stays in get_info. The block is
--     now ridden along on press_buttons, pause, unpause, reset (in addition to
--     the existing load_state/frame_advance/play_input_sequence/run_trials), so
--     those tools answer "where am I now?" without a follow-up get_info.
--     NOTE: cmd_press_buttons/pause/unpause/reset now return a TABLE {state}
--     instead of a bare `true` — additive; older servers ignore the extra field.
--   * Freeze now validates the address against the target domain's size up
--     front (validate_freeze_range) and errors once with a clear message, e.g.
--     a full 68K bus address (0xFFxxxx) freed into the 64 KB "68K RAM" domain.
--     Previously BizHawk silently dropped each out-of-range write and re-logged
--     the warning every frame (freeze re-asserts per frame), flooding the
--     console until unfrozen.
--
-- v2026.7.2-jd changes (console timestamps, state summaries, load_state_path,
--                       run_trials, OSD lag+srv, observe_every, describe/vision):
--   * Every bridge console line is now prefixed with a friendly local-timezone
--     timestamp to the millisecond, e.g. "[09:19:32.947] [mcp-bizhawk] ...".
--     console.log is monkeypatched once at startup; the ms comes from .NET
--     DateTime.Now via luanet (os.date is second-only), with a second-
--     resolution os.date fallback if luanet is unavailable.
--   * play_input_sequence gains observe_every: capture observe_memory readings
--     every N frames WITHOUT a screenshot (memory-only, cheap dense RAM trace).
--     Decoupled from screenshot_every, which still wins if both are set.
--   * OSD header line now shows cumulative lag frames ("lag N", with a
--     trailing "*" when the current frame is itself a lag frame), and the OSD
--     version line now shows the paired mcp-bizhawk server version ("srv vX")
--     next to the bridge version — captured from the HELLO greeting.
--   * frame_advance / load_state / play_input_sequence now ride a `state`
--     block {framecount, paused, rom_hash} on their result via a new
--     state_summary() helper, so the client can print a state line without a
--     follow-up get_info round-trip. NOTE: cmd_frame_advance now returns a
--     TABLE {framecount, state} instead of a bare framecount number — needs a
--     server ≥ 2026.7.2-jd (which accepts either shape); an older server
--     prints the object literally.
--   * play_input_sequence takes an optional load_state_path: reload a baseline
--     savestate then play the sequence in ONE round-trip (the load happens
--     before the stop_on_memory_change baseline read and frame 0), collapsing
--     the load_state+play trial loop to a single call.
--   * cmd_run_trials — savestate-anchored input sweep. For each trial: reload
--     the shared state_path (so trials are independent), play that trial's
--     frames, then read the shared observe_memory set at the final frame and
--     optionally screenshot. Replaces N × (load_state + play + read) with one
--     round-trip and one per-trial results table.
--
-- v0.16.0 changes (phys_trace heading fraction):
--   * phys_trace now emits a trailing `frac` column = the low word of the
--     32-bit skater heading longword @ slot struct +0x54. The octant (already
--     emitted as `fdir`) is the high word @+0x54; `frac` is @+0x56. Appended
--     LAST so existing column order/values are unchanged. For held-Down from
--     rest, frac advances +0x3000 per tick and carries into the octant on
--     16-bit overflow (verified against retail nhl94.gen).
--   * CSV columns: tick,frame,d7,pad,x,xsub,y,ysub,xv,yv,fdir,frac.
--
-- v0.15.1 changes (drop phys_trace eval_lua workaround):
--   * Removed the `_G.phys_trace_start/stop/status` global aliases. They existed
--     only so eval_lua chunks could reach the physics-sync trace before it had
--     dedicated MCP tools; the server now exposes first-class
--     `bizhawk_phys_trace_*` tools (server ≥ 0.5.7-jd) that drive the same
--     HANDLERS entries directly. Hook logic, addresses, and CSV format unchanged.
--
-- v0.15.0 changes (NHL94 physics-sync trace — dup-free per-tick capture):
--   * New phys_trace_start/phys_trace_stop/phys_trace_status commands. On
--     retail nhl94.gen ONLY (MD5 8356B3F0…, hash-guarded), these register two
--     event.on_bus_exec hooks in the Gameloop and write ONE CSV row per
--     updateplayers PASS (= one physics tick), NOT per video frame:
--       - @0x7958 (the `move.w $B03E,$B040` snapshot): latch D7 = elapsed
--         vblanks = $B03E-$B040, read BEFORE the snapshot zeroes it. This is
--         the per-pass step multiplier updateplayers applies (`mulu D7,D4` at
--         0xAC06). Verified 2026-07-13: reg D7 here == the applied multiplier
--         on 40/40 fully-captured passes; reading it at the emit point instead
--         gives the NEXT pass's pending count (off-by-one).
--       - @0x7966 (first insn after `bsr updateplayers` returns): write the
--         POST-update slot-2 16.16 pos (x/xsub,y/ysub) + vel (xv,yv) + fdir +
--         P1 pad + the latched D7 + a monotonic tick counter.
--     Why: video frames != physics ticks. A lag pass (D7=2) runs two physics
--     updates but renders one frame, so the per-video-frame trace_tick()
--     under-samples it. This hook is frame-exact for trace-diffing the sim.
--   * While a phys-sync trace is active, the per-video-frame trace_tick() is a
--     no-op — the exec hook is the oracle; trace_tick() remains the fallback
--     when phys-sync is off or the core lacks event.on_bus_exec.
--   * Default file /tmp/nhl94_phys_<port>.csv (own file, does not touch the
--     rich 12-slot /tmp/nhl94_trace_<port>.csv).
--
-- v0.14.2 changes (banner cosmetics):
--   * HELLO banner no longer wrapped in "***" — logs as a plain
--     "[mcp-bizhawk] bizhawk connected to mcp server vX.Y.Z" line.
--
-- v0.14.1 changes (clock run/stop fix):
--   * OSD run/stop indicator was reversed: gmode bit 0 SET means the clock
--     is STOPPED (verified live: clock ticks while gmode==0). The trace
--     CSV's "clockrun" column still records raw gmode&1 unchanged — beware
--     it is actually a clock-stopped flag.
--
-- v0.14.0 changes (OSD: 2x size, puck carrier + game globals):
--   * Canvas window doubled (640px wide, 32px lines, 24pt font).
--   * New header line: game clock as M:SS (0xFFC468 holds SECONDS
--     remaining — verified live against the scoreboard), clock run bit
--     (gmode & 1 as run/stop), and the puck-carrier slot.
--   * Puck carrier: 0xFFB7AA is the carrying slot's index (0-11), or
--     negative (0xFF00) when the puck is loose — verified live by
--     matching slot positions against the puck position. The carrier's
--     s<n> line is starred.
--   * New footer line: shotplayer/lastplayer slots and pass
--     direction/speed globals.
--
-- v0.13.0 changes (OSD: position/facing/velocity + separate window):
--   * The live OSD now shows gameplay state instead of sprite/animation
--     internals: per slot x/y position, facing direction (+0x54) and x/y
--     velocity (+0x28/+0x2A), plus puck position/velocity. The animation
--     fields it used to show (frame/anim/spanum/attr) remain in the trace
--     CSV, unchanged.
--   * The OSD renders into a SEPARATE WINDOW when the build supports
--     gui.createcanvas (LuaCanvas), keeping the game view clean. If the
--     canvas can't be created — or dies mid-run (window closed, mono
--     quirk) — it falls back to the old on-game gui.text overlay and says
--     so on the console.
--
-- v0.12.1 changes (unconfigured-socket fix):
--   * Loading the script WITHOUT --socket_ip/--socket_port no longer spins
--     the reconnect loop forever ("link dead — re-dialing..." every ~5s):
--     the comm.socketServer* functions exist even when no target was
--     configured, so the old capability check passed and every send just
--     failed. Startup now reads GetIp/GetPort defensively (pcall — some
--     builds throw when uninitialized) and exits cleanly with a FATAL
--     console message when the target is unset. A configured target whose
--     server is merely down still enters the normal auto-reconnect loop.
--
-- v0.12.0 changes (mixed memory op batches):
--   * cmd_memory_ops ops=[{op:"write"|"freeze"|"unfreeze",address,value?,
--     width?,domain?},...] — apply one-shot writes, freezes, and unfreezes
--     in ONE round-trip, all between the same two frames, so the game
--     never runs on a half-applied set. Top-level width/domain are per-op
--     defaults; ops apply in order; an error aborts the rest but keeps
--     earlier ops applied.
--
-- v0.11.0 changes (HELLO greeting):
--   * The server now answers the first message of every connection with
--     `HELLO {"server_version":"..."}` instead of NONE; tick() recognizes
--     it and logs "*** [mcp-bizhawk] bizhawk connected to mcp server
--     vX.Y.Z ***" to the Lua Console — including on auto-reconnect
--     redials, so a reprinted banner doubles as reconnect confirmation.
--     Needs a HELLO-capable server (≥ 0.5.2-jd) to appear; an older
--     server just never sends HELLO — no banner, everything else works.
--
-- v0.10.0 changes (batch freeze/unfreeze):
--   * cmd_freeze entries=[{address,value,width?,domain?},...] — freeze many
--     addresses in ONE round-trip instead of one call per address; the
--     top-level width/domain act as per-entry defaults. Entries apply in
--     order; an error aborts the rest but keeps earlier entries frozen.
--   * cmd_unfreeze addresses=[...] — release a batch of addresses (all
--     matched against the top-level domain) in one call.
--
-- v0.9.0 changes (get_input, disassemble, osd_message, get_info+, eval_lua unpause, command-echo):
--   * cmd_get_input — reads the current joypad state for a player (held
--     buttons + analog axes) via joypad.get(), without advancing frames;
--     complements cmd_record_input's per-frame sampling.
--   * cmd_disassemble — thin wrapper over emu.disassemble() to decode one
--     or more instructions at a given address or the current PC, for
--     reading the code around a cmd_trap_memory hit.
--   * cmd_osd_message — thin wrapper over gui.addmessage() to draw a
--     short message in BizHawk's on-screen OSD area.
--   * cmd_get_info extended — now reports system_id, paused,
--     lag_count/is_lagged, and movie_loaded/movie_mode when the loaded
--     core/build exposes them.
--   * cmd_eval_lua unpause option — runs the submitted chunk via the
--     pause-safe path, temporarily unpausing so emu.frameadvance() calls
--     inside the chunk don't block forever, then restores the prior
--     pause state afterward.
--   * dispatch() now echoes every received command (and any handler
--     error) to the Lua Console as a `[mcp-bizhawk] << <method> <params>`
--     line, making it possible to watch exactly what the server is
--     sending in real time from BizHawk's Lua Console.
--
-- v0.8.0 changes (registers, traps, input recording, movies, trace control):
--   * cmd_get_registers/cmd_set_register — thin wrappers over
--     emu.getregisters()/emu.setregister(), capability-guarded (core
--     dependent; 68K cores expose PC/D0-D7/A0-A7).
--   * cmd_trap_memory — registers a scoped event.on_bus_write/read/exec
--     callback on an address, then frame-advances (turbo-eligible) until
--     it fires or a frame budget expires, snapshotting the CPU registers
--     (PC) at the moment of access before unregistering. Timeout is a
--     result (hit = nil), not an error.
--   * cmd_record_input — samples joypad.get(player) every frame (pressed
--     buttons only) into the same {buttons, hold} RLE shape
--     play_input_sequence consumes, optionally stopping early via
--     stop_on_memory_change. Lets a human demonstrate a move once and
--     hand the agent a replayable sequence.
--   * cmd_movie_play/cmd_movie_stop/cmd_movie_status — wrap movie.play_
--     from_start/movie.stop/movie.isloaded+mode+filename+length for
--     deterministic .bk2 playback. Recording new movies from Lua is not
--     exposed by BizHawk's movie API; out of scope.
--   * cmd_trace_start/cmd_trace_stop/cmd_trace_status — runtime control
--     of the per-frame trace CSV (rotate to a new path, stop and report
--     frame count, or query {active, path, frames, osd}) instead of only
--     configuring TRACE_PATH at launch. (bizhawk_trace_tail and the
--     named savestate slots added this release are server-side only —
--     tail reads the CSV directly, slots wrap existing save_state/
--     load_state — no bridge changes needed for either.)
--
-- v0.7.0 changes (freeze, eval_lua, RAM search):
--   * cmd_freeze/cmd_unfreeze/cmd_list_frozen — cheat-style pinned writes
--     that are re-asserted after every emulated frame (including frames
--     inside batched commands like frame_advance/play_input_sequence/
--     wait_for_memory). Freeze enforcement runs before trace_tick(), so
--     the trace CSV records the enforced (post-freeze) values, not the
--     game's own write. frame_hooks refactor: the per-frame "after
--     emu.frameadvance()" work (freeze enforcement, trace_tick, osd_tick)
--     is now centralized in one frame_hooks() called from every stepping
--     site, instead of being duplicated per handler.
--   * cmd_eval_lua — arbitrary-Lua escape hatch. The submitted chunk runs
--     bridge-side with BizHawk's full Lua API in scope (memory, emu, gui,
--     client, ...); its return value comes back JSON-encoded.
--   * cmd_search_begin/cmd_search_filter/cmd_search_results/cmd_search_end
--     — Cheat-Engine-style two-snapshot RAM search sessions held
--     bridge-side. Conditions: eq/ne/gt/lt/changed/unchanged/increased/
--     decreased. Snapshot window capped at 2 MiB.
--
-- v0.6.0 changes (batch reads, signed/BE widths, turbo):
--   * WIDTH_READ_FN is now a capability-guarded lookup table mapping each
--     width name (u8/s8/u16/s16/u32/s32 plus _be big-endian variants) to
--     the matching memory.read_* function name — a missing memory.read_*
--     on this build now errors cleanly instead of "attempt to call a nil
--     value". Signed and big-endian widths are accepted everywhere a width
--     is accepted: read_many, read_struct_array, observe_memory,
--     stop_on_memory_change, wait_for_memory.
--   * cmd_read_many — labeled batch reads: one call takes a list of
--     {name, address, width, domain} specs and returns name=value results
--     in request order, in a single bridge round-trip.
--   * cmd_read_struct_array — decodes N fixed-stride records (e.g. entity
--     tables) into labeled fields in one call, capped at count * fields <=
--     4096.
--   * maybe_turbo(turbo, keep_video, fn) — optionally runs fn at maximum
--     emulation speed by cranking client.speedmode(6400) and disabling
--     rendering via client.invisibleemulation(true), then restoring
--     speedmode(100) and visible rendering afterwards. keep_video leaves
--     rendering ON (used when screenshots are captured mid-run, since an
--     invisible frame captures blank). Wired into frame_advance,
--     wait_for_memory, and play_input_sequence via a turbo option.
--
-- v0.5.5 changes (trace continuity through batched frame stepping):
--   * trace_tick()/osd_tick() are now called after every emu.frameadvance()
--     inside command handlers (play_input_sequence, frame_advance,
--     wait_for_memory). Previously the trace was only written from the main
--     yield loop, which is stalled for the duration of those handlers — so
--     exactly the frames driven by scripted input were MISSING from the
--     trace CSV. The animation oracle now covers batched frames too.
--   * trace_tick() dedupes on emu.framecount(): at most one CSV row per
--     emulated frame. Fixes the long-standing duplicate rows caused by
--     emu.yield() re-entering the main loop more than once per frame (and
--     repeatedly while paused), and makes the handler-loop + main-loop
--     call sites safely idempotent.
--   * play_input_sequence returns observations = nil (key omitted) instead
--     of an empty Lua table when no observations were captured. An empty
--     table serializes to JSON {} (object, not array), which crashed the
--     Node tool handler with "obs is not iterable" whenever neither
--     screenshot_every nor observe_memory was requested.
--
-- v0.5.4 changes (animation ground truth):
--   * Trace CSV gains four per-player columns — frame (+0x06, the resolved
--     "alice frame number" actually being displayed), attr (+0x04, frame
--     attribute bits; bit 3 = x-flip), spanum (+0x5A, byte offset into the
--     SPA's per-direction slot list; /4 = slot index) and spacnt (+0x5C,
--     VBL countdown to the next frame switch) — plus puck_frame. Together
--     with the existing anim/fdir columns the trace is now a frame-exact
--     animation oracle: it records WHICH sprite frame the real game showed
--     at every tick, so engine animation can be diffed against ground truth
--     without screenshots. Offsets per NHL92Genesis src/ram.asm (layout
--     confirmed identical at these offsets in '94: fdir 0x54, SPA 0x58,
--     nopuck 0x5E already line up).
--   * Live on-screen overlay (TRACE_OSD flag, default ON): per-slot
--     frame / anim / spanum / x-flip readout plus puck frame, drawn every
--     tick via gui.pixelText.
--
-- v0.5.3 changes (per-port trace file):
--   * TRACE_PATH now embeds the socket server port reported by
--     comm.socketServerGetPort() — e.g. /tmp/nhl94_trace_8767.csv — so two
--     BizHawk instances driven by different mcp-bizhawk servers (opencode on
--     8766, Claude Code on 8767) no longer clobber each other's trace CSV.
--     Falls back to the old /tmp/nhl94_trace.csv if the port can't be read.
--   * Startup banner now reports the bridge name + version
--     ("bridge_JD v0.5.3 starting") so the loaded script version is visible
--     in the Lua console / launch log without calling get_info.
--
-- v0.5.2 changes (reconnect rework — verified against BizHawk 2.11.1 source,
-- src/BizHawk.Client.Common/Api/SocketServer.cs + lua/CommonLibs/CommLuaLibrary.cs):
--   * comm.socketServerConnect() DOES NOT EXIST in 2.11.x. The old watchdog's
--     pcall was silently throwing "attempt to call a nil value" every attempt.
--     The only public re-dial path is the IP/Port setters: SocketServer.IP's
--     setter calls the private Connect(), which builds a NEW socket
--     (ReinitSocket) and dials it. So redial = socketServerSetIp(GetIp()).
--   * After a re-dial the fresh socket has default ReceiveTimeout (0 = block
--     forever) — SetTimeout must be re-applied or the next
--     socketServerResponse() on an idle link hangs EmuHawk.
--   * socketServerIsConnected() reads a cached flag that is set true on
--     connect and NEVER cleared — it is useless as a liveness signal and is
--     no longer consulted. Liveness = "bytes received recently" (the server
--     answers NONE every frame, so a healthy link receives every frame).
--   * comm.socketServerSend never throws — SendString swallows exceptions
--     and returns -1. Failure detection now checks the return value.
--   * Watchdog is rate-limited (last_reconnect_ms) — the old heartbeat
--     condition re-fired every frame once stale. Timers are wall-clock ms
--     (now_ms via DateTime.Now), not frame counts, so detection latency is
--     constant regardless of emulation speed (turbo/pause).
--
-- Architecture (inverted from mcp-mgba):
--
--   mcp-bizhawk (Node.js, runs the TCP server)
--          ▲
--          │  TCP — newline-delimited JSON
--          │
--   bridge.lua (BizHawk Lua, polls every frame)
--
-- Each frame, this script does ONE round-trip with the external server:
--   1. Lua sends "READY\n"  (or "RESULT <json>\n" if there's a pending result)
--   2. Server responds with EITHER "NONE\n" OR a JSON command "{id,method,params}\n"
--      (or, replying to the connection's FIRST message only, "HELLO <json>\n")
--   3. If a command came back, execute it locally and stash the result so
--      the next frame's send carries it back.
--
-- Wire format: newline-delimited UTF-8.
--   - Lua → server: "READY\n" | "RESULT <json>\n"
--   - Server → Lua: "NONE\n"  | "<json command>\n" | "HELLO <json>\n" (once,
--     replying to the connection's first message, carrying server_version)
--
-- Setup in BizHawk:
--   1. Tools → External Tool → Lua Console
--   2. Settings → Customize → External Tools → "Custom Tools" — set socket
--      server IP/port to 127.0.0.1:8766 (or however you launched mcp-bizhawk)
--      OR launch BizHawk with --socket_ip=127.0.0.1 --socket_port=8766
--   3. Tools → Lua Console → Open this script
--
-- Verify with `mcp-bizhawk` startup log: should print "BizHawk client connected".

local json = require("json")

-- Bridge identity. Reported in get_info so drivers can positively verify
-- WHICH bridge is loaded (checking info.bridge.pause_safe beats inferring
-- from the absence of a "Missing capabilities" warning). Bump the version
-- on any behavioral change.
local BRIDGE = {
    name       = "bridge_JD",
    version    = "2026.7.18-jd",
    pause_safe = true,
}

-- Friendly local-timezone timestamp, to the millisecond, prefixed onto every
-- bridge console line. BizHawk's Lua (NLua) exposes .NET via `luanet`, so we
-- format DateTime.Now as HH:mm:ss.fff — the only sub-second wall clock this
-- build offers (os.date is second-only; luasocket isn't bundled). Falls back
-- to second-resolution os.date if luanet/DateTime is ever unavailable.
local _DateTime = nil
do
    local ok, dt = pcall(function()
        return luanet and luanet.import_type and luanet.import_type("System.DateTime")
    end)
    if ok then _DateTime = dt end
end
local function ts_prefix()
    if _DateTime then
        local ok, s = pcall(function() return _DateTime.Now:ToString("HH:mm:ss.fff") end)
        if ok and type(s) == "string" then return "[" .. s .. "]" end
    end
    return "[" .. os.date("%H:%M:%S") .. "]"
end

-- Wall-clock milliseconds, for the link watchdog. Frame-counted timers drift
-- with emulation speed (turbo makes "~10s" fire in <1s; pause stretches it),
-- so liveness is measured against the real clock instead. DateTime.Now.Ticks
-- is 100-ns units → /1e4 for ms. Falls back to second-resolution os.time when
-- luanet/DateTime is unavailable (fine for a multi-second watchdog).
local function now_ms()
    if _DateTime then
        local ok, ms = pcall(function()
            -- Floor-division keeps the 64-bit tick count exact (float division
            -- would lose sub-ms precision at DateTime.Ticks' magnitude).
            return _DateTime.Now.Ticks // 10000
        end)
        if ok and type(ms) == "number" then return ms end
    end
    return os.time() * 1000
end

-- Prefix all bridge console output with the timestamp. Monkeypatch console.log
-- once so every existing/future call is covered without touching each site.
local _raw_console_log = console.log
console.log = function(first, ...)
    if type(first) == "string" then
        return _raw_console_log(ts_prefix() .. " " .. first, ...)
    end
    return _raw_console_log(ts_prefix(), first, ...)
end

-- Pending result from last frame's command. Sent back at the start of the
-- next frame's round-trip (instead of a bare "READY").
local pending_result = nil
local tick_count = 0
local disconnected = false
local reconnect_count = 0   -- successful re-dials since script load (shown in OSD)

-- Link-liveness bookkeeping. The server answers every frame's READY with at
-- least "NONE", so a healthy link RECEIVES bytes every frame. last_rx_ms is
-- stamped (wall clock) on ANY received bytes (including "NONE") and is the
-- only heartbeat; command traffic is irrelevant to liveness. Timers are
-- WALL-CLOCK ms (via now_ms), not frame counts, so detection latency is
-- constant regardless of turbo/pause/framerate.
local last_rx_ms          = 0
local last_reconnect_ms   = 0
local RECONNECT_INTERVAL_MS = 5000    -- ms between re-dial attempts
local DEAD_AFTER_MS         = 10000   -- ms without rx before declaring dead
local SOCKET_TIMEOUT_MS   = 50    -- receive timeout; re-applied after re-dial

-- ── Capability detection ────────────────────────────────────────────────────
-- BizHawk's Lua API is largely stable but a few of the higher-level helpers
-- vary by build. Probe at startup so we can return clean errors instead of
-- "attempt to call a nil value" if something's missing.
--
-- IMPORTANT: BizHawk exposes .NET methods to Lua as USERDATA with __call
-- metamethods, not as plain Lua functions. Accept either.
local function has(t, name)
    if not t then return false end
    local v = rawget(t, name)
    if v == nil then v = t[name] end  -- fallback for proxy tables
    if v == nil then return false end
    local tv = type(v)
    return tv == "function" or tv == "userdata"
end

-- ── NHL94 Trace ──────────────────────────────────────────────────────────────
-- Per-frame dump of all 12 player SCstructs + puck + game globals + controller
-- inputs to CSV. Set TRACE_PATH = nil to disable.
--
-- The socket server port is baked into the filename (v0.5.3) so concurrent
-- BizHawk instances — one per mcp-bizhawk server (opencode 8766, Claude Code
-- 8767) — each get their own trace instead of clobbering a shared file.

local TRACE_PATH, PHYS_PATH
do
    local port = nil
    if comm and has(comm, "socketServerGetPort") then
        local ok, p = pcall(function() return comm.socketServerGetPort() end)
        if ok then port = tonumber(p) end
    end
    TRACE_PATH = port and ("/tmp/nhl94_trace_" .. port .. ".csv")
                      or  "/tmp/nhl94_trace.csv"
    PHYS_PATH  = port and ("/tmp/nhl94_phys_"  .. port .. ".csv")
                      or  "/tmp/nhl94_phys.csv"
end
local TRACE_FLUSH = 60

local SORTCORDS = 0xFFB04A
local SCSIZE    = 0x80
local PUCK_ADDR = SORTCORDS + 14 * SCSIZE

local TRACE_DOMAIN, TRACE_BASE
do
    for _, d in ipairs(memory.getmemorydomainlist()) do
        if d == "M68K BUS" then TRACE_DOMAIN = d; TRACE_BASE = 0; break end
    end
    if not TRACE_DOMAIN then TRACE_DOMAIN = "68K RAM"; TRACE_BASE = 0xFF0000 end
end

local function tr_u8(a)  return memory.read_u8(a - TRACE_BASE, TRACE_DOMAIN) end
local function tr_u16(a) return memory.read_u16_be(a - TRACE_BASE, TRACE_DOMAIN) end
local function tr_s16(a) return memory.read_s16_be(a - TRACE_BASE, TRACE_DOMAIN) end
local TRACE_READER = { u8 = tr_u8, u16 = tr_u16, s16 = tr_s16 }

local TRACE_FIELDS = {
    {0x00, "s16", "x"},      {0x14, "s16", "y"},
    {0x28, "s16", "xv"},     {0x2A, "s16", "yv"},
    {0x58, "u16", "anim"},   {0x32, "s16", "impact"},
    {0x2E, "s16", "impactp"},{0x54, "u16", "fdir"},
    {0x34, "u16", "pos"},    {0x62, "u8",  "pf"},
    {0x63, "u8",  "pf2"},    {0x64, "u8",  "pf3"},
    {0x67, "u8",  "wgt8"},   {0x5E, "u8",  "nopuck"},
    -- v0.5.4 animation ground truth ('92 ram.asm names): frame = "alice
    -- frame number" (the resolved sprite frame on screen this tick),
    -- attribute = flip bits (bit 3 = x-flip), SPAnum = byte offset into the
    -- SPA slot list (steps by 4; /4 = slot index), SPAcnt = VBL countdown.
    {0x06, "u16", "frame"},  {0x04, "u16", "attr"},
    {0x5A, "u16", "spanum"}, {0x5C, "s16", "spacnt"},
}

local TRACE_G = {
    gameclock = 0xFFC468, puckc = 0xFFB7AA,
    gsp       = 0xFFC466,   -- current period (u16, 0-indexed: 0=1st,1=2nd,2=3rd,3=OT)
    RNGseed   = 0xFFD066, collflag = 0xFFBFA0, evalue = 0xFFBFA2,
    gmode     = 0xFFC2EA, shotplayer = 0xFFBED8, lastplayer = 0xFFBEDA,
    passdir   = 0xFFBEDC, passspeed = 0xFFBEDE,
}

-- Period label from gsp (0-indexed). 4+ = further OT / shootout.
local function period_label(p)
    if p == 0 then return "1st" elseif p == 1 then return "2nd"
    elseif p == 2 then return "3rd" elseif p == 3 then return "OT"
    else return "OT" .. (p - 2) end
end

local TRACE_BTN_ORDER = {"Up","Down","Left","Right","A","B","C","Start"}
local TRACE_BTN_CHAR  = {"U","D","L","R","A","B","C","S"}

local trace_fh = nil
local trace_frames = 0
local trace_last_frame = -1
local trace_current_path = nil   -- path of the open (or last) trace file

-- ── NHL94 physics-sync trace state (v0.15.0) ─────────────────────────────────
-- Declared here (before trace_tick) so trace_tick can read phys_fh as an
-- upvalue and no-op while a phys-sync capture owns the CSV. See the phys
-- callbacks/commands further down for the full explanation.
local RETAIL_MD5    = "8356B3F0D091B9CC441E2FF8721AD063"
local PHYS_SLOT2    = SORTCORDS + 2 * SCSIZE   -- 0xFFB14A: home C (fixture skater)
local PHYS_ADDR_LATCH = 0x7958   -- `move.w $B03E,$B040` — D7 still live here
local PHYS_ADDR_EMIT  = 0x7966   -- first insn after `bsr updateplayers` returns
local phys_fh          = nil
local phys_path        = nil
local phys_tick        = 0       -- monotonic physics-tick counter (1 per pass)
local phys_latch_d7    = 0       -- D7 latched at 0x7958 for the current pass
local phys_guid_latch  = nil
local phys_guid_emit   = nil

local function trace_pad_string(port)
    local j = joypad.get(port)
    local s = ""
    for i, b in ipairs(TRACE_BTN_ORDER) do
        s = s .. ((j[b] or j["P" .. port .. " " .. b]) and TRACE_BTN_CHAR[i] or ".")
    end
    return s
end

local function trace_header()
    local cols = {"frame", "clockraw", "clockrun",
        "puck_x","puck_y","puck_z","puck_xv","puck_yv","puck_zv","puckc","puck_frame",
        "rngseed","collflag","evalue","shotplayer","lastplayer","passdir","passspeed",
        "p1_pad","p2_pad"}
    for n = 0, 11 do
        for _, f in ipairs(TRACE_FIELDS) do
            cols[#cols + 1] = string.format("s%d_%s", n, f[3])
        end
    end
    return table.concat(cols, ",")
end

local function trace_row(frame)
    local gmode = tr_u8(TRACE_G.gmode)
    local out = {
        frame,
        string.format("%04X", tr_u16(TRACE_G.gameclock)),
        gmode & 1,
        tr_s16(PUCK_ADDR + 0x00), tr_s16(PUCK_ADDR + 0x14), tr_s16(PUCK_ADDR + 0x18),
        tr_s16(PUCK_ADDR + 0x28), tr_s16(PUCK_ADDR + 0x2A), tr_s16(PUCK_ADDR + 0x2C),
        tr_s16(TRACE_G.puckc), tr_u16(PUCK_ADDR + 0x06),
        string.format("%04X", tr_u16(TRACE_G.RNGseed)),
        tr_s16(TRACE_G.collflag), tr_s16(TRACE_G.evalue),
        tr_s16(TRACE_G.shotplayer), tr_s16(TRACE_G.lastplayer),
        tr_s16(TRACE_G.passdir), tr_s16(TRACE_G.passspeed),
        trace_pad_string(1), trace_pad_string(2),
    }
    for n = 0, 11 do
        local base = SORTCORDS + n * SCSIZE
        for _, f in ipairs(TRACE_FIELDS) do
            local v = TRACE_READER[f[2]](base + f[1])
            if f[2] == "u8" then v = string.format("%02X", v)
            elseif f[3] == "anim" or f[3] == "attr" then v = string.format("%04X", v) end
            out[#out + 1] = v
        end
    end
    return table.concat(out, ",")
end

local function trace_tick()
    if not trace_fh then return end
    -- While a physics-sync capture is active, its exec hook is the oracle
    -- (one row per physics tick, not per video frame) — the per-video-frame
    -- writer no-ops so the two can't interleave. This is the fallback path.
    if phys_fh then return end
    -- One row per emulated frame, no matter how many call sites fire: the
    -- main loop's emu.yield() re-enters more than once per frame (and spins
    -- while paused), and command handlers now call this after each
    -- emu.frameadvance() too.
    local fc = emu.framecount()
    if fc == trace_last_frame then return end
    trace_last_frame = fc
    trace_fh:write(trace_row(fc) .. "\n")
    trace_frames = trace_frames + 1
    if trace_frames % TRACE_FLUSH == 0 then trace_fh:flush() end
end

-- ── NHL94 physics-sync trace hooks (v0.15.0) ─────────────────────────────────
-- Two exec hooks in the Gameloop turn a per-VIDEO-FRAME trace into a per-
-- PHYSICS-TICK trace. Retail nhl94.gen Gameloop (0x794E..0x7966):
--   0x794E  move.w ($B03E),D7      ; D7 = vblank counter
--   0x7952  sub.w  ($B040),D7      ; D7 = elapsed vblanks (the step multiplier)
--   0x7956  beq    $794E           ; spin until D7 != 0
--   0x7958  move.w ($B03E),($B040) ; snapshot — after this, $B03E-$B040 == 0
--   0x795E  bsr    periodicevents  ; preserves D7
--   0x7962  bsr    updateplayers   ; applies D7 (`mulu D7,D4` @0xAC06)
--   0x7966  tst.w  ($DECC)         ; <- back in Gameloop, physics done
-- So D7 must be latched at 0x7958 (before the snapshot zeroes the diff); the
-- post-update slot state is emitted at 0x7966. Verified 2026-07-13.

local function phys_latch_cb()
    -- Exec hooks fire BEFORE the instruction runs, so at 0x7958 the snapshot
    -- has NOT happened yet and $B03E-$B040 is still the elapsed-vblank D7.
    phys_latch_d7 = (tr_u16(0xFFB03E) - tr_u16(0xFFB040)) & 0xFFFF
end

local function phys_emit_cb()
    if not phys_fh then return end
    -- The 0x7956 spin-wait guarantees D7>=1 for every real pass, so a latched
    -- D7 of 0 means capture began BETWEEN the 0x7958 latch and this 0x7966
    -- emit of the SAME pass — a partial first pass with no valid multiplier.
    -- Skip it so tick 1 is a complete, D7-valid physics tick.
    if phys_latch_d7 == 0 then return end
    phys_tick = phys_tick + 1
    local b = PHYS_SLOT2
    phys_fh:write(string.format("%d,%d,%d,%s,%d,%d,%d,%d,%d,%d,%d,%d\n",
        phys_tick, emu.framecount(), phys_latch_d7, trace_pad_string(1),
        tr_s16(b + 0x00), tr_u16(b + 0x02),      -- X 16.16: whole, sub
        tr_s16(b + 0x14), tr_u16(b + 0x16),      -- Y 16.16: whole, sub
        tr_s16(b + 0x28), tr_s16(b + 0x2A),      -- xv, yv
        tr_u16(b + 0x54),                        -- fdir = octant (high word of heading longword @+0x54)
        tr_u16(b + 0x56)))                       -- frac = low word of the 32-bit heading longword @+0x54; octant (fdir) is the high word
    if phys_tick % TRACE_FLUSH == 0 then phys_fh:flush() end
end

local function phys_header()
    return "tick,frame,d7,pad,x,xsub,y,ysub,xv,yv,fdir,frac"
end

-- ── Live state OSD ──────────────────────────────────────────────────────────
-- Readout of gameplay state (was animation state until v0.13.0; that data is
-- still in the trace CSV as s<n>_frame/anim/attr/spanum):
--   header: game clock (seconds at 0xFFC468, shown M:SS), run/stop state
--           (gmode bit 0 SET = stopped), and the puck-carrier slot
--   s0-s11: x (+0x00), y (+0x14), facing direction (+0x54), x/y velocity
--           (+0x28/+0x2A); the carrier slot is starred
--   pk:     puck position/velocity (no facing)
--   footer: shotplayer/lastplayer slots and pass direction/speed globals
-- OSD is OFF by default (the separate LuaCanvas window's per-frame repaint
-- costs real emulation speed under Mono/Linux). Press the End key to toggle it
-- on/off at runtime; it can also be driven by trace_start/trace_stop's `osd`
-- param. The window is only created on the first toggle-on, so a session that
-- never opens the OSD pays nothing for it.
--
-- Rendering prefers a SEPARATE WINDOW (gui.createcanvas LuaCanvas) so the
-- game view stays clean; if the build can't create one (or the window dies
-- — e.g. user closes it), it falls back to the on-game gui.text overlay.
local TRACE_OSD = true

-- gui.text (EmuHawk OSD renderer, window coords) — NOT gui.pixelText, whose
-- bitmap font renders as empty boxes under mono/Linux.
local osd_text
if gui and has(gui, "text") then
    osd_text = function(x, y, s) gui.text(x, y, s) end
end

-- Frozen-address table (cheat-style pins). Declared HERE — before the OSD code
-- — so osd_lines() can highlight rows whose memory is frozen. Populated/consumed
-- by the freeze_* helpers and freeze_tick() defined later in the file.
local frozen = {}

local OSD_LINE_H = 16   -- gui.text fallback line height (fixed OSD font)
local OSD_LINES  = 19   -- sys + clk + col-header + 12 slots + blank + 2 puck + shot

-- Canvas render metrics. Widened to fit the expanded per-skater / puck field
-- set (z, heading fraction, flags, stop-gate, puck Z/Zvel, carrier ratings);
-- font trimmed ~10% (24→22) so the longer rows fit.
local OSD_CANVAS_LINE_H = 32
local OSD_CANVAS_FONT   = 22
local OSD_CANVAS_W      = 896   -- was 1280; prefix-less columns + 2-line puck fit narrower

local osd_canvas = nil
local osd_canvas_failed = false   -- don't retry a broken canvas every frame

-- OSD repaint throttle. The LuaCanvas repaint (Clear + DrawText×lines + Refresh)
-- measures ~5.5ms/frame plain and ~10ms/frame once frozen addresses turn on the
-- red overlay draws — of a 16.6ms 60fps budget shared with emulation. Repainting
-- at the full 60Hz therefore starves emulation and drops it below 60fps (the
-- "OSD-up + many frozen = drag" symptom; the cost is GDI+ text/repaint, so it
-- reproduces on Windows and mono alike). A telemetry panel doesn't need 60Hz:
-- repaint only every Nth EMULATED frame. INTENTIONALLY GLOBAL (no `local`) so it
-- can be retuned live via bizhawk_eval_lua — e.g. `OSD_REFRESH_EVERY = 3` — with
-- no script reload. 1 = every frame (old behavior); 3 ≈ 20Hz, 6 ≈ 10Hz,
-- 12 ≈ 5Hz at 60fps. (While PAUSED the throttle is bypassed for a single
-- repaint of the current frame — see osd_tick.)
OSD_REFRESH_EVERY = 6
-- emu.framecount() at the last repaint; -1 forces the next tick to draw (set on
-- enable so toggling the OSD on repaints immediately rather than after N frames).
local osd_last_frame = -1

local function osd_get_canvas()
    if osd_canvas or osd_canvas_failed then return osd_canvas end
    if not (gui and has(gui, "createcanvas")) then
        osd_canvas_failed = true
        return nil
    end
    local ok, c = pcall(gui.createcanvas, OSD_CANVAS_W, 4 + OSD_LINES * OSD_CANVAS_LINE_H + 4)
    if ok and c then
        pcall(function() c.SetTitle(BRIDGE.name .. " — NHL94 state") end)
        osd_canvas = c
        console.log("[mcp-bizhawk] OSD rendering to separate LuaCanvas window")
    else
        osd_canvas_failed = true
        console.log("[mcp-bizhawk] gui.createcanvas failed ("
            .. tostring(c) .. ") — OSD falling back to on-game overlay")
    end
    return osd_canvas
end

-- Puck carrier (0xFFB7AA): slot index 0-11 while a player has the puck,
-- negative (0xFF00) when nobody does (loose puck / faceoff). Verified live
-- against slot-vs-puck positions, 2026-07-13.
local function osd_carrier()
    local c = tr_s16(TRACE_G.puckc)
    if c >= 0 and c <= 11 then return c end
    return nil
end

-- Map each frozen memory location to the specific player/puck FIELD it pins, so
-- the OSD can highlight just that value (not the whole row). Normalize every
-- frozen entry to a full 68K address (0xFFxxxx) — the user may freeze it in the
-- "M68K BUS" domain (already full) or "68K RAM" (0-based offset) — then map it
-- onto the SORTCORDS slot grid + in-struct offset. Returns fields[key] tables
-- (key = slot 0-11 or "puck") with booleans x/y/d/v (a displayed field) or
-- `other` (a frozen byte we show no column for — flags the row label instead).
local function osd_frozen_fields()
    local out = {}
    local function mark(key, off)
        local t = out[key]; if not t then t = {}; out[key] = t end
        if     off == 0x00 or off == 0x02 then t.x = true      -- Xpos 16.16
        elseif off == 0x14 or off == 0x16 then t.y = true      -- Ypos 16.16
        elseif off == 0x18 or off == 0x1A then t.z = true      -- Zpos/airborne 16.16
        elseif off == 0x54                then t.d = true      -- heading octant
        elseif off == 0x56                then t.f = true      -- heading fraction
        elseif off == 0x28 or off == 0x2A then t.v = true      -- Xvel / Yvel
        elseif off == 0x2C                then t.zv = true     -- Zvel (puck loft)
        elseif off == 0x34                then t.st = true     -- stop/goalie gate
        elseif off == 0x62                then t.fl = true     -- friction/flags
        else t.other = true end
    end
    for _, f in pairs(frozen) do
        local a = f.address
        local full
        if a >= 0xFF0000 then full = a               -- full-bus address
        elseif a < 0x10000 then full = 0xFF0000 + a  -- 68K RAM offset
        else full = a end
        -- The puck-carrier global (0xFFB7AA, u16) physically lives inside the
        -- puck's object slot (slot 14, offset 0x60) but is shown by the "carry"
        -- field on the clock line — not by any puck column. Route it there so a
        -- frozen carrier highlights "carry sN" instead of the bare "pk" label.
        if full == TRACE_G.puckc or full == TRACE_G.puckc + 1 then
            out.carry = true
        elseif full >= SORTCORDS then
            local rel  = full - SORTCORDS
            local slot = rel // SCSIZE
            local off  = rel % SCSIZE
            if slot >= 0 and slot <= 11 then mark(slot, off)
            elseif slot == 14 then mark("puck", off) end   -- PUCK_ADDR = SORTCORDS+14*SCSIZE
        end
    end
    return out
end

local OSD_RED    = 0xFFFF4040   -- frozen-value highlight (ARGB)
local OSD_ORANGE = 0xFFFFA030   -- stale-version highlight (ARGB) on the system line

-- Compare two calendar-version strings by their numeric components only
-- ("2026.7.6-jd" → {2026,7,6}; the "-jd" suffix and any other non-digits are
-- ignored). Returns -1 if a<b, 1 if a>b, 0 if equal/uncomparable. Used to flag
-- the OLDER of the client/server pair on the OSD system line.
local function version_cmp(a, b)
    local function parts(v)
        local t = {}
        for n in tostring(v):gmatch("%d+") do t[#t + 1] = tonumber(n) end
        return t
    end
    local pa, pb = parts(a), parts(b)
    for i = 1, math.max(#pa, #pb) do
        local x, y = pa[i] or 0, pb[i] or 0
        if x < y then return -1 elseif x > y then return 1 end
    end
    return 0
end

-- Build a visible line from {text, hot} segments plus a same-length "overlay"
-- string that carries ONLY the hot (frozen) segments' characters, spaces
-- elsewhere. Drawing the overlay in red over the white line highlights exactly
-- the frozen value(s) with perfect alignment (identical monospace layout).
-- Returns visible, overlay-or-nil.
local function osd_build(segs)
    local vis, ov, any = {}, {}, false
    for _, s in ipairs(segs) do
        vis[#vis + 1] = s[1]
        if s[2] then ov[#ov + 1] = s[1]; any = true
        else ov[#ov + 1] = string.rep(" ", #s[1]) end
    end
    return table.concat(vis), (any and table.concat(ov) or nil)
end

-- Returns two parallel arrays: the text lines and a per-line red overlay string
-- (nil = nothing frozen on that line). Only the frozen VALUE is highlighted.
local function osd_lines()
    local lines, overlays = {}, {}
    local ff = osd_frozen_fields()
    local clock   = tr_u16(TRACE_G.gameclock)   -- seconds remaining in period
    -- gmode bit 0 SET means the clock is STOPPED (verified live 2026-07-13:
    -- clock ticks down while gmode==0, holds while gmode==1). Note the trace
    -- CSV's "clockrun" column records the raw gmode&1, i.e. it is actually
    -- a clock-STOPPED flag.
    local running = (tr_u8(TRACE_G.gmode) & 1) == 0
    local carrier = osd_carrier()
    -- System/emulation line: client+server version, reconnect count (rc), the
    -- emulated frame counter, and lag frames — all the non-game telemetry on ONE
    -- line at the top. Versions COLLAPSE to a single "v…" when client and server match (the
    -- normal case); when they differ they split to "cli v… srv v…" and the OLDER
    -- build is drawn orange+bold to flag the stale component.
    -- Lag frames: emu.lagcount() is the cumulative total; a trailing '*' marks
    -- the current frame as itself a lag frame (emu.islagged()). Guarded with
    -- has() rather than CAPS because CAPS is declared after this function.
    local lag = "lag ?"
    if emu and has(emu, "lagcount") then
        local now = has(emu, "islagged") and emu.islagged()
        lag = string.format("lag %d%s", emu.lagcount(), now and "*" or "")
    end
    -- Emulated frame counter (emu.framecount) — emulation telemetry, so it rides
    -- the system line between rc and lag. Empty string if unavailable.
    local frame = ""
    if emu and has(emu, "framecount") then
        frame = string.format("frame %d  ", emu.framecount())
    end
    local cliver = tostring(BRIDGE.version)
    local srvver = tostring(BRIDGE.server_version or "?")
    if cliver == srvver then
        lines[#lines + 1] = string.format("v%s  rc %d  %s%s", cliver, reconnect_count, frame, lag)
        overlays[#lines] = nil
    else
        -- Only rank the pair when BOTH carry version digits; a bare "?" (no
        -- HELLO from the server yet) is shown but highlights nothing.
        local cmp = 0
        if cliver:match("%d") and srvver:match("%d") then cmp = version_cmp(cliver, srvver) end
        local vis, ov = osd_build({
            { "cli v" .. cliver,          cmp < 0 },
            { "  srv v" .. srvver,        cmp > 0 },
            { string.format("  rc %d  %s%s", reconnect_count, frame, lag), false },
        })
        lines[#lines + 1] = vis
        overlays[#lines] = ov and { str = ov, color = OSD_ORANGE } or nil
    end
    -- Game-clock line — pure NHL94 now (lag moved up). Period (gsp) leads,
    -- matching the on-screen scoreboard. The carrier VALUE is its own segment so
    -- a frozen carrier (ff.carry) turns just "sN"/"--" red (like the per-field
    -- freeze highlight on skater rows).
    local period = period_label(tr_u16(TRACE_G.gsp))
    local vis, ov = osd_build({
        { string.format("%-3s %d:%02d %s   carry ",
            period, clock // 60, clock % 60, running and "run " or "stop"), false },
        { carrier and ("s" .. carrier) or "--", ff.carry },
    })
    lines[#lines + 1] = vis
    overlays[#lines] = ov and { str = ov, color = OSD_RED } or nil
    -- Column header for the skater block. Numeric columns are right-justified so
    -- the digits sit under the labels; the values below carry no inline prefix.
    lines[#lines + 1] = string.format("%-4s%5s %5s %4s %2s %5s %13s %2s %3s",
        "", "x", "y", "z", "d", "f", "xv,yv", "fl", "st")
    overlays[#lines] = nil
    -- Per-skater row: pos (x,y,z), heading (d octant + f fraction), velocity,
    -- friction/flags byte (hex), stop/goalie gate. Fixed widths align with the
    -- header above.
    for n = 0, 11 do
        local base = SORTCORDS + n * SCSIZE
        local fz = ff[n] or {}
        local vis, ov = osd_build({
            { string.format("%-4s", "s" .. n .. (n == carrier and "*" or "")), fz.other },
            { string.format("%5d ", tr_s16(base + 0x00)), fz.x },
            { string.format("%5d ", tr_s16(base + 0x14)), fz.y },
            { string.format("%4d ", tr_s16(base + 0x18)), fz.z },
            { string.format("%2d ", tr_u16(base + 0x54)), fz.d },
            { string.format("%5d ", tr_u16(base + 0x56)), fz.f },
            { string.format("%6d,%6d ", tr_s16(base + 0x28), tr_s16(base + 0x2A)), fz.v },
            { string.format("%02X ", tr_u8(base + 0x62)), fz.fl },
            { string.format("%3d", tr_u16(base + 0x34)), fz.st },
        })
        lines[#lines + 1] = vis
        overlays[#lines] = ov and { str = ov, color = OSD_RED } or nil
    end
    -- Blank separator between the skater block and the puck.
    lines[#lines + 1] = ""
    overlays[#lines] = nil
    -- Puck on TWO lines (keeps the window narrow): line 1 position + velocity,
    -- line 2 the carrier's ratings.
    do
        local fz = ff.puck or {}
        local vis, ov = osd_build({
            { "pk  ", fz.other },
            { string.format("x%-5d ", tr_s16(PUCK_ADDR + 0x00)), fz.x },
            { string.format("y%-5d ", tr_s16(PUCK_ADDR + 0x14)), fz.y },
            { string.format("z%-5d ", tr_s16(PUCK_ADDR + 0x18)), fz.z },
            { string.format("v %d,%d,%d",
                tr_s16(PUCK_ADDR + 0x28), tr_s16(PUCK_ADDR + 0x2A), tr_s16(PUCK_ADDR + 0x2C)),
              fz.v or fz.zv },
        })
        lines[#lines + 1] = vis
        overlays[#lines] = ov and { str = ov, color = OSD_RED } or nil
        -- Carrier ratings (from the carrying slot's struct); dashes when loose.
        local sp, sa, pa, en = "--", "--", "--", "--"
        if carrier then
            local cb = SORTCORDS + carrier * SCSIZE
            sp = tostring(tr_u8(cb + 0x6C)); sa = tostring(tr_u8(cb + 0x6D))
            pa = tostring(tr_u8(cb + 0x6E)); en = tostring(tr_u8(cb + 0x66))
        end
        lines[#lines + 1] = string.format("    sp%-3s sa%-3s pa%-3s en%-3s", sp, sa, pa, en)
        overlays[#lines] = nil
    end
    lines[#lines + 1] = string.format("shot s%d  last s%d  pass d%d,%d",
        tr_s16(TRACE_G.shotplayer),
        tr_s16(TRACE_G.lastplayer),
        tr_s16(TRACE_G.passdir),
        tr_s16(TRACE_G.passspeed))
    overlays[#lines] = nil
    return lines, overlays
end

-- The End key toggles the OSD. BizHawk's SDL2 input reports it as "End"
-- (WinForms Keys enum name; confirmed present in BizHawk.Bizware.Input) — not a
-- Genesis input and not a default BizHawk hotkey, so no collision. Edge-
-- triggered off osd_key_was_down so holding it flips once.
local OSD_TOGGLE_KEYS = { End = true }
local osd_key_was_down = false

local function osd_poll_toggle()
    if not (input and has(input, "get")) then return end
    local ok, keys = pcall(input.get)
    if not ok or type(keys) ~= "table" then return end
    local down = false
    for name in pairs(OSD_TOGGLE_KEYS) do if keys[name] then down = true; break end end
    if down and not osd_key_was_down then
        TRACE_OSD = not TRACE_OSD
        console.log("[mcp-bizhawk] OSD " .. (TRACE_OSD and "ON" or "OFF") .. " (End key toggle)")
        if osd_canvas then
            if TRACE_OSD then
                -- Enable: un-hide the window (WinForms Show(), reachable on the
                -- Windows build) and force an immediate repaint so it isn't blank
                -- until the throttle's next tick — matters most while paused.
                pcall(function() osd_canvas.Show() end)
                osd_last_frame = -1
            else
                -- Disable: actually HIDE the window where supported (Windows).
                -- On builds where Hide() isn't callable (mono/Linux) the pcall
                -- fails, so fall back to blanking it, keeping a stale panel from
                -- lingering. Either way the per-frame draw stops (TRACE_OSD gate).
                local hid = pcall(function() osd_canvas.Hide() end)
                if not hid then
                    pcall(function() osd_canvas.Clear(0xFF101010); osd_canvas.Refresh() end)
                end
            end
        elseif TRACE_OSD then
            osd_last_frame = -1   -- no canvas yet; osd_tick will create + repaint
        end
    end
    osd_key_was_down = down
end

local function osd_tick()
    osd_poll_toggle()
    if not TRACE_OSD then return end
    -- Repaint throttle (see OSD_REFRESH_EVERY). Keyed off the emulated frame
    -- counter, NOT poll count: emu.yield() can re-enter this several times per
    -- frame and repeatedly while paused, so a per-call counter would misfire.
    -- Same-frame re-entries share one framecount → at most one repaint per frame,
    -- then one per N frames. Falls back to every-frame if framecount is absent.
    --
    -- PAUSED: framecount is frozen, so the plain throttle would leave the panel
    -- showing whatever frame it last happened to land on (up to N-1 frames
    -- stale) and never catch up. Instead bypass the throttle for exactly ONE
    -- repaint of the current frame, then idle — a paused OSD reflects the
    -- current state without repainting on every UI tick.
    local every = tonumber(OSD_REFRESH_EVERY) or 1
    if emu and has(emu, "framecount") then
        local fc = emu.framecount()
        local paused = client and has(client, "ispaused") and client.ispaused()
        if paused then
            if osd_last_frame == fc then return end        -- current frame already drawn
        elseif every > 1 and osd_last_frame >= 0 and (fc - osd_last_frame) < every then
            return
        end
        osd_last_frame = fc
    end
    local canvas = osd_get_canvas()
    if canvas then
        local ok = pcall(function()
            local lines, overlays = osd_lines()
            canvas.Clear(0xFF101010)
            for i, s in ipairs(lines) do
                local y = 4 + (i - 1) * OSD_CANVAS_LINE_H
                canvas.DrawText(4, y, s, 0xFFFFFFFF, nil, OSD_CANVAS_FONT, "Courier New")
                -- Over-draw only the highlighted field(s) — frozen values in
                -- red, a stale version in orange — on the same layout → exact
                -- alignment, twice at a 1px offset for a pseudo-bold weight
                -- (LuaCanvas has no bold flag). Each overlay carries its color.
                local ov = overlays[i]
                if ov then
                    canvas.DrawText(4, y, ov.str, ov.color, nil, OSD_CANVAS_FONT, "Courier New")
                    canvas.DrawText(5, y, ov.str, ov.color, nil, OSD_CANVAS_FONT, "Courier New")
                end
            end
            canvas.Refresh()
        end)
        if ok then return end
        -- Canvas died (window closed, mono quirk mid-run) — overlay from now on.
        osd_canvas, osd_canvas_failed = nil, true
        console.log("[mcp-bizhawk] LuaCanvas draw failed — OSD falling back to on-game overlay")
    end
    if not osd_text then return end
    for i, s in ipairs(osd_lines()) do
        osd_text(4, 4 + (i - 1) * OSD_LINE_H, s)
    end
end

local CAPS = {
    -- emu
    framecount   = emu and has(emu, "framecount"),
    frameadvance = emu and has(emu, "frameadvance"),
    getregisters = emu and has(emu, "getregisters"),
    setregister  = emu and has(emu, "setregister"),
    disassemble  = emu and has(emu, "disassemble"),
    lagcount     = emu and has(emu, "lagcount"),
    islagged     = emu and has(emu, "islagged"),
    getsystemid  = emu and has(emu, "getsystemid"),
    -- event hooks are core-dependent (available on Genesis/NES/SNES-class
    -- cores, absent on some others) — probe, don't assume
    on_bus_write     = event and has(event, "on_bus_write"),
    on_bus_read      = event and has(event, "on_bus_read"),
    on_bus_exec      = event and has(event, "on_bus_exec"),
    unregisterbyid   = event and has(event, "unregisterbyid"),
    yield        = emu and has(emu, "yield"),
    -- client (pause control lives here, NOT on emu — emu.pause doesn't exist
    -- in BizHawk; that's an mGBA-ism)
    pause        = client and has(client, "pause"),
    unpause      = client and has(client, "unpause"),
    ispaused     = client and has(client, "ispaused"),
    reboot_core  = client and has(client, "reboot_core"),
    screenshot   = client and has(client, "screenshot"),
    speedmode          = client and has(client, "speedmode"),
    invisibleemulation = client and has(client, "invisibleemulation"),
    -- savestate
    savestate_save = savestate and has(savestate, "save"),
    savestate_load = savestate and has(savestate, "load"),
    -- gui (OSD)
    gui_addmessage = gui and has(gui, "addmessage"),
    -- joypad
    joypad_set = joypad and has(joypad, "set"),
    joypad_get = joypad and has(joypad, "get"),
    -- memory
    memory_read_u8     = memory and has(memory, "read_u8"),
    memory_read_u16_le = memory and has(memory, "read_u16_le"),
    memory_read_u32_le = memory and has(memory, "read_u32_le"),
    -- Big-endian variants — the natural byte order for the 68K (Genesis).
    memory_read_u16_be = memory and has(memory, "read_u16_be"),
    memory_read_u32_be = memory and has(memory, "read_u32_be"),
    memory_write_u8    = memory and has(memory, "write_u8"),
    memory_write_u16_le = memory and has(memory, "write_u16_le"),
    memory_write_u32_le = memory and has(memory, "write_u32_le"),
    memory_write_u16_be = memory and has(memory, "write_u16_be"),
    memory_write_u32_be = memory and has(memory, "write_u32_be"),
    memory_get_memorydomain_list   = memory and has(memory, "getmemorydomainlist"),
    memory_get_current_memorydomain = memory and has(memory, "getcurrentmemorydomain"),
    memory_use_memory_domain       = memory and has(memory, "usememorydomain"),
    memory_read_bytes_as_array = memory and has(memory, "read_bytes_as_array"),
    memory_get_memorydomain_size = memory and has(memory, "getmemorydomainsize"),
    -- mainmemory (subset of memory, scoped to system main RAM)
    mainmemory_read_u8 = mainmemory and has(mainmemory, "read_u8"),
    -- gameinfo
    gameinfo_getromname = gameinfo and has(gameinfo, "getromname"),
    gameinfo_getromhash = gameinfo and has(gameinfo, "getromhash"),
    -- comm re-dial (v0.5.2): 2.11.x has NO socketServerConnect. The re-dial
    -- primitive is the SetIp/SetPort setters (each triggers the internal
    -- Connect(), which re-creates the socket before dialing).
    socket_redial = comm and has(comm, "socketServerSetIp")
                         and has(comm, "socketServerGetIp"),
    -- movies (.bk2) — playback only; recording NEW movies isn't reliably
    -- exposed by BizHawk 2.11's Lua API, so it's out of scope here.
    movie_isloaded        = movie and has(movie, "isloaded"),
    movie_play_from_start = movie and has(movie, "play_from_start"),
    movie_stop            = movie and has(movie, "stop"),
}

-- ── Command handlers ────────────────────────────────────────────────────────

-- Draw a transient message in BizHawk's OSD message area (gui.addmessage).
-- Fire-and-forget: BizHawk renders and auto-fades it, so it appears on
-- screenshots taken shortly after and in recordings. Position/duration are
-- fixed by BizHawk. Use it to annotate what the agent is doing during demos.
local function cmd_osd_message(p)
    if not CAPS.gui_addmessage then error("gui.addmessage not available") end
    local msg = p.message
    if type(msg) ~= "string" or #msg == 0 then error("message (non-empty string) required") end
    gui.addmessage(msg)
    return { message = msg }
end

local function cmd_ping(p) return "pong" end

-- BizHawk's memory.getmemorydomainlist() hands us a 0-indexed Lua table. The
-- JSON encoder (correctly) sees non-1-indexed keys and serializes it as an
-- OBJECT (`{"0":"CARTRAM","1":"WRAM",...}`) rather than an ARRAY. Re-pack into
-- a contiguous 1-indexed array so the client side sees a clean JSON array.
local function memory_domain_list()
    if not CAPS.memory_get_memorydomain_list then return nil end
    local raw = memory.getmemorydomainlist()
    local out = {}
    -- Could be 0-indexed or 1-indexed depending on build; walk by ipairs from
    -- 0 in case key 0 is the first slot, then continue with positive keys.
    local i = raw[0] ~= nil and 0 or 1
    while raw[i] ~= nil do
        out[#out + 1] = raw[i]
        i = i + 1
    end
    return out
end

-- Compact "where are we now" block attached to frame-changing command results
-- (load_state, frame_advance, play_input_sequence). Lets the client render a
-- state line without a follow-up get_info round-trip. Every field is guarded
-- so a build missing a cap simply omits it.
-- Compact, DYNAMIC state block ridden along on state-mutating commands so the
-- client can print "where am I now?" without a follow-up get_info. Only fields
-- that actually change as you act: framecount, pause, lag (count + whether the
-- current frame lagged), and the active memory domain (which can silently drift
-- after a savestate load). rom_hash is STATIC and deliberately omitted — it
-- lives in get_info; re-sending a 40-char hash on every call is pure waste.
local function state_summary()
    local s = {}
    if CAPS.framecount            then s.framecount = emu.framecount() end
    if CAPS.ispaused              then s.paused     = client.ispaused() end
    if CAPS.lagcount              then s.lag_count  = emu.lagcount()   end
    if CAPS.islagged              then s.is_lagged  = emu.islagged()   end
    if CAPS.memory_get_current_memorydomain then
        s.current_memory_domain = memory.getcurrentmemorydomain()
    end
    return s
end

local function cmd_get_info(p)
    local t = {
        bridge        = BRIDGE,
        rom_name      = CAPS.gameinfo_getromname and gameinfo.getromname() or nil,
        rom_hash      = CAPS.gameinfo_getromhash and gameinfo.getromhash() or nil,
        framecount    = CAPS.framecount and emu.framecount() or nil,
        system_id     = CAPS.getsystemid and emu.getsystemid() or nil,
        lag_count     = CAPS.lagcount and emu.lagcount() or nil,
        movie_mode    = (movie and has(movie, "mode")) and movie.mode() or nil,
        memory_domains = memory_domain_list(),
        -- Which domain is read/written when a memory tool call omits `domain`.
        -- Useful because BizHawk's "current" domain can drift after savestate
        -- loads or other Lua scripts changing it underneath us.
        current_memory_domain = CAPS.memory_get_current_memorydomain
            and memory.getcurrentmemorydomain() or nil,
        capabilities  = CAPS,
    }
    -- mode() is safe when inactive ("INACTIVE"); isloaded() is safe.
    -- Do NOT call filename()/length() here (crash when no movie loaded).
    -- booleans: explicit assignment so a real `false` is transmitted (not collapsed to nil)
    if CAPS.ispaused       then t.paused       = client.ispaused()   end
    if CAPS.islagged       then t.is_lagged    = emu.islagged()      end
    if CAPS.movie_isloaded then t.movie_loaded = movie.isloaded()    end
    return t
end

-- Memory r/w. By default operates on the current "main memory" domain;
-- pass `domain` in params to target a specific named domain (use
-- list_memory_domains to discover names — they vary per system).
local function in_domain(domain, fn)
    if not domain then return fn() end
    if not CAPS.memory_use_memory_domain then
        error("memory.usememorydomain not available on this BizHawk build")
    end
    local prev = memory.getcurrentmemorydomain and memory.getcurrentmemorydomain() or nil
    local ok = memory.usememorydomain(domain)
    if not ok then error("unknown memory domain: " .. tostring(domain)) end
    local r = fn()
    if prev then memory.usememorydomain(prev) end
    return r
end

-- Multi-byte reads/writes take an optional `byteorder` param: "le" (default,
-- back-compat) or "be". The 68K stores values big-endian, so Genesis callers
-- almost always want byteorder="be" — no more read_range + manual
-- `(hi << 8) | lo` decoding.
local function pick_be(p)
    local bo = p.byteorder or "le"
    if bo == "be" then return true end
    if bo == "le" then return false end
    error("byteorder must be 'le' or 'be' (got " .. tostring(bo) .. ")")
end

local function cmd_read8(p)
    local addr = assert(p.address, "address required")
    return in_domain(p.domain, function() return memory.read_u8(addr) end)
end
local function cmd_read16(p)
    local addr = assert(p.address, "address required")
    local be = pick_be(p)
    if be and not CAPS.memory_read_u16_be then error("memory.read_u16_be not available") end
    return in_domain(p.domain, function()
        return be and memory.read_u16_be(addr) or memory.read_u16_le(addr)
    end)
end
local function cmd_read32(p)
    local addr = assert(p.address, "address required")
    local be = pick_be(p)
    if be and not CAPS.memory_read_u32_be then error("memory.read_u32_be not available") end
    return in_domain(p.domain, function()
        return be and memory.read_u32_be(addr) or memory.read_u32_le(addr)
    end)
end
local function cmd_write8(p)
    local addr = assert(p.address, "address required")
    local val  = assert(p.value,   "value required")
    in_domain(p.domain, function() memory.write_u8(addr, val) end)
    return true
end
local function cmd_write16(p)
    local addr = assert(p.address, "address required")
    local val  = assert(p.value,   "value required")
    local be = pick_be(p)
    if be and not CAPS.memory_write_u16_be then error("memory.write_u16_be not available") end
    in_domain(p.domain, function()
        if be then memory.write_u16_be(addr, val) else memory.write_u16_le(addr, val) end
    end)
    return true
end
local function cmd_write32(p)
    local addr = assert(p.address, "address required")
    local val  = assert(p.value,   "value required")
    local be = pick_be(p)
    if be and not CAPS.memory_write_u32_be then error("memory.write_u32_be not available") end
    in_domain(p.domain, function()
        if be then memory.write_u32_be(addr, val) else memory.write_u32_le(addr, val) end
    end)
    return true
end

local function cmd_read_range(p)
    local addr = assert(p.address, "address required")
    local len  = assert(p.length,  "length required")
    if len > 4096 then error("length exceeds 4096 byte limit") end
    return in_domain(p.domain, function()
        local bytes = {}
        for i = 0, len - 1 do bytes[i + 1] = memory.read_u8(addr + i) end
        return bytes
    end)
end

local function cmd_write_range(p)
    local addr  = assert(p.address, "address required")
    local bytes = assert(p.bytes,   "bytes required")
    if #bytes > 4096 then error("byte count exceeds 4096 limit") end
    return in_domain(p.domain, function()
        for i, b in ipairs(bytes) do memory.write_u8(addr + i - 1, b) end
        return { written = #bytes }
    end)
end

local function cmd_list_memory_domains(p)
    if not CAPS.memory_get_memorydomain_list then
        error("memory.getmemorydomainlist not available")
    end
    return memory_domain_list()
end

-- Joypad. p.buttons is a table like {A=true, Up=true, Start=true}.
-- p.player defaults to 1.
local function cmd_press_buttons(p)
    if not CAPS.joypad_set then error("joypad.set not available") end
    local buttons = assert(p.buttons, "buttons required (table like {A=true, Up=true})")
    local player  = p.player or 1
    joypad.set(buttons, player)
    return { state = state_summary() }
end

-- Batched input playback. Takes a list of per-frame inputs and runs them
-- entirely server-side — one bridge round-trip per BATCH instead of per
-- frame. Each frame entry is `{ buttons = {A=true,...}, player = 1 }`.
--
-- Run-length encoding (since v0.3.0): each entry may carry `hold = N` to
-- repeat that input for N consecutive frames. `{buttons={}, hold=60}`
-- replaces 60 empty-frame entries, so "wait 60, press Start, wait 40"
-- is 3 entries instead of 101 — keeps the JSON small enough to never hit
-- serialization truncation. Observation cadence, stop_on_memory_change,
-- and the `played` count all operate per EMULATED frame, not per entry.
-- The bridge does NOT poll its outer loop during this call, so other RPCs
-- (and the heartbeat) are stalled until the batch finishes. For
-- responsiveness, callers should chunk long sequences into multiple
-- play_input_sequence calls of a few hundred frames each.
--
-- Optional observation params (since v0.1.4):
--   p.screenshot_every  — capture a PNG every N frames (also captures the
--                         final frame regardless of remainder). Requires
--                         client.screenshot to be available on this build.
--   p.observe_every     — capture an observation every N frames WITHOUT a
--                         screenshot (memory-only, cheap). screenshot_every
--                         takes precedence if both are given.
--   p.screenshot_dir    — directory for PNGs (default: C:/temp on Windows,
--                         /tmp elsewhere; caller should ensure it exists)
--   p.screenshot_prefix — filename prefix (default: "obs")
--
-- Optional observation params (since v0.1.5):
--   p.observe_memory    — array of {name, domain, address, width} reads
--                         to perform at each observation point. width is
--                         u8/s8/u16/s16/u32/s32 (LE) plus u16_be/s16_be/u32_be/s32_be
--                         (the _be widths since v0.3.0). Results land in each
--                         observation as `memory = { name = value, ... }`.
--   p.stop_on_memory_change — {domain, address, width} — record this
--                         value at the start, abort play the moment it
--                         changes. Result includes stopped_early=true and
--                         stop_reason='memory_changed'. The final
--                         observation (if screenshot/memory enabled) is
--                         always captured at the stop frame.
-- width: unsigned/signed 8/16/32, LE by default, _be variants big-endian.
-- Readers are looked up by name so each width is capability-guarded: a
-- missing memory.read_* on this build errors cleanly instead of "attempt
-- to call a nil value".
local WIDTH_READ_FN = {
    u8 = "read_u8", s8 = "read_s8",
    u16 = "read_u16_le", s16 = "read_s16_le",
    u32 = "read_u32_le", s32 = "read_s32_le",
    u16_be = "read_u16_be", s16_be = "read_s16_be",
    u32_be = "read_u32_be", s32_be = "read_s32_be",
}
local function read_width(address, width)
    local fn_name = WIDTH_READ_FN[width]
    if not fn_name then
        error("width must be one of u8,s8,u16,s16,u32,s32,u16_be,s16_be,u32_be,s32_be (got " .. tostring(width) .. ")")
    end
    if not has(memory, fn_name) then
        error("memory." .. fn_name .. " not available on this build")
    end
    return memory[fn_name](address)
end

-- Write counterpart of read_width. Unsigned widths only — callers writing a
-- negative value must pass its two's-complement unsigned form. Same
-- capability-guarded lookup-table style as read_width above.
local WIDTH_WRITE_FN = {
    u8 = "write_u8",
    u16 = "write_u16_le",
    u32 = "write_u32_le",
    u16_be = "write_u16_be",
    u32_be = "write_u32_be",
}
local function write_width(address, width, value)
    local fn_name = WIDTH_WRITE_FN[width]
    if not fn_name then
        error("width must be one of u8,u16,u32,u16_be,u32_be (got " .. tostring(width) .. ")")
    end
    if not has(memory, fn_name) then
        error("memory." .. fn_name .. " not available on this build")
    end
    memory[fn_name](address, value)
end

-- ── Frozen addresses (cheat-style) ──────────────────────────────────────────
-- Re-written after every emulated frame by frame_hooks(). Keyed by
-- "<domain or ''>:<address>" so the same offset in two domains can coexist.
-- (The `frozen` table itself is declared earlier, above the OSD code, so the
-- overlay can highlight frozen rows.)

local function freeze_key(domain, address)
    return (domain or "") .. ":" .. tostring(address)
end

local function frozen_count()
    local n = 0
    for _ in pairs(frozen) do n = n + 1 end
    return n
end

-- Re-assert every frozen value once per frame. Structured for scale: the
-- current domain is read ONCE and switched only when the target actually
-- changes (a switch is cheap; the per-entry pcall + closure allocation +
-- getcurrentmemorydomain the old version paid N *times per frame* was the real
-- cost — measured ~3x slower at N=100). The write body is a define-once
-- function invoked via pcall with ARGUMENTS (no per-entry closure allocation),
-- so a single bad entry still can't kill the poll loop.
local function freeze_apply_all()
    local getcur = memory.getcurrentmemorydomain
    local orig = getcur and getcur() or nil
    local active = orig
    for _, f in pairs(frozen) do
        local target = f.domain or orig
        -- Switch only on change; a false return means an unknown domain (e.g.
        -- gone after a core switch) → skip just this entry, keep re-asserting
        -- the rest, and don't leave `active` claiming a domain we failed to set.
        if target and target ~= active then
            active = memory.usememorydomain(target) and target or nil
        end
        if target == active then
            pcall(write_width, f.address, f.width, f.value)
        end
    end
    if orig and active ~= orig then memory.usememorydomain(orig) end
end

local function freeze_tick()
    if next(frozen) == nil then return end
    -- Outer pcall: an unexpected API error in one frame must never wedge the
    -- poll loop. Per-entry write errors are already isolated inside the loop.
    pcall(freeze_apply_all)
end

-- The ONE per-frame hook. Called from the main yield loop and after every
-- emu.frameadvance() inside command handlers. Freeze runs FIRST so the trace
-- records the enforced value.
local function frame_hooks()
    freeze_tick()
    trace_tick()
    osd_tick()
end

local function read_memory_widthed(domain, address, width)
    if domain then
        if not CAPS.memory_use_memory_domain then
            error("memory.usememorydomain not available — needed for memory reads with explicit domain")
        end
        local prev = memory.getcurrentmemorydomain and memory.getcurrentmemorydomain() or nil
        if not memory.usememorydomain(domain) then
            error("unknown memory domain: " .. tostring(domain))
        end
        local v = read_width(address, width)
        if prev then memory.usememorydomain(prev) end
        return v
    else
        return read_width(address, width)
    end
end

-- emu.frameadvance() BLOCKS while the emulator is paused (it only resumes
-- when a frame actually runs), so anything that needs to step frames must
-- briefly unpause first, then restore the paused state afterwards.
local function run_unpaused(fn)
    local was_paused = CAPS.ispaused and client.ispaused()
    if was_paused then client.unpause() end
    local ok, result = pcall(fn)
    if was_paused and CAPS.pause then client.pause() end
    if not ok then error(result, 0) end
    return result
end

-- Optionally run fn at maximum emulation speed: crank client.speedmode and
-- disable rendering, then restore. keep_video leaves rendering ON — required
-- when screenshots are captured mid-run (an invisible frame captures blank).
-- BizHawk has no getters for either setting, so "restore" means the defaults
-- (100%, visible), not whatever the user had dialed in — documented in the
-- tool descriptions.
local function maybe_turbo(turbo, keep_video, fn)
    if not turbo then return fn() end
    local can_speed = CAPS.speedmode
    local can_invis = CAPS.invisibleemulation and not keep_video
    if can_speed then client.speedmode(6400) end
    if can_invis then client.invisibleemulation(true) end
    local ok, result = pcall(fn)
    if can_invis then client.invisibleemulation(false) end
    if can_speed then client.speedmode(100) end
    if not ok then error(result, 0) end
    return result
end

local function cmd_play_input_sequence(p)
    if not CAPS.joypad_set    then error("joypad.set not available") end
    if not CAPS.frameadvance  then error("emu.frameadvance not available") end
    local frames = assert(p.frames, "frames required (array of {buttons, player?} objects)")
    if type(frames) ~= "table" then error("frames must be an array") end

    -- Optional: reload a baseline savestate before playback, same round-trip.
    -- Done up front so stop_on_memory_change's initial read and frame 0 see the
    -- restored state. Playback unpauses regardless, so pause state is moot here.
    if p.load_state_path then
        if not CAPS.savestate_load then error("savestate.load not available") end
        savestate.load(p.load_state_path)
    end

    local screenshot_every  = p.screenshot_every
    local screenshot_dir    = p.screenshot_dir    or "C:/temp"
    local screenshot_prefix = p.screenshot_prefix or "obs"
    if screenshot_every and not CAPS.screenshot then
        error("screenshot_every requested but client.screenshot is not available on this build")
    end

    local observe_memory = p.observe_memory  -- nil or array of {name, domain, address, width}
    local stop_spec      = p.stop_on_memory_change  -- nil or {domain, address, width}
    -- Observation cadence is decoupled from screenshots: screenshot_every drives
    -- it AND adds a PNG at each point; observe_every drives it memory-only (no
    -- PNG). screenshot_every wins if both are set. capture_wanted gates whether
    -- there's anything to record (a screenshot and/or a memory read).
    local obs_cadence   = screenshot_every or p.observe_every or 0xFFFF
    local capture_wanted = (screenshot_every ~= nil) or (observe_memory ~= nil)

    -- Capture initial value for stop-on-change
    local stop_initial = nil
    if stop_spec then
        stop_initial = read_memory_widthed(stop_spec.domain, stop_spec.address, stop_spec.width)
    end

    local observations = {}
    local count   = 0
    local total   = 0  -- total EMULATED frames (each entry's hold counts N)
    for _, frame in ipairs(frames) do
        total = total + ((type(frame) == "table" and frame.hold) or 1)
    end
    local stopped = false
    local stop_reason = nil

    -- Helper: capture an observation at the current frame.
    local function capture_observation()
        local obs = { frame_offset = count }
        if screenshot_every then
            local path = string.format("%s/%s-%04d.png", screenshot_dir, screenshot_prefix, count)
            client.screenshot(path)
            obs.path = path
        end
        if observe_memory then
            local mem = {}
            for _, spec in ipairs(observe_memory) do
                mem[spec.name] = read_memory_widthed(spec.domain, spec.address, spec.width)
            end
            obs.memory = mem
        end
        table.insert(observations, obs)
    end

    run_unpaused(function()
    maybe_turbo(p.turbo, screenshot_every ~= nil, function()
    for i, frame in ipairs(frames) do
        local buttons = (type(frame) == "table" and frame.buttons) or {}
        local player  = (type(frame) == "table" and frame.player) or 1
        local hold    = (type(frame) == "table" and frame.hold) or 1
        for _ = 1, hold do
            -- joypad.set only applies for one frame, so re-assert each frame
            -- of the hold.
            joypad.set(buttons, player)
            emu.frameadvance()
            frame_hooks()
            count = count + 1

            -- Check stop condition AFTER the frame advances
            if stop_spec then
                local cur = read_memory_widthed(stop_spec.domain, stop_spec.address, stop_spec.width)
                if cur ~= stop_initial then
                    stopped = true
                    stop_reason = "memory_changed"
                    -- Always capture the stop frame as an observation (regardless of cadence)
                    if capture_wanted then
                        capture_observation()
                    end
                    break
                end
            end

            -- Periodic observation (only if we didn't already capture for stop)
            if capture_wanted and (count % obs_cadence == 0 or count == total) then
                capture_observation()
            end
        end
        if stopped then break end
    end
    end)
    end)

    return {
        played = count,
        final_framecount = CAPS.framecount and emu.framecount() or nil,
        -- Empty Lua table would serialize as JSON {} (object, not array) and
        -- crash the Node handler's iteration — omit the key instead.
        observations = #observations > 0 and observations or nil,
        stopped_early = stopped,
        stop_reason = stop_reason,
        state = state_summary(),
    }
end

local function cmd_pause(p)
    if not CAPS.pause then error("client.pause not available") end
    client.pause(); return { state = state_summary() }
end
local function cmd_unpause(p)
    if not CAPS.unpause then error("client.unpause not available") end
    client.unpause(); return { state = state_summary() }
end
local function cmd_frame_advance(p)
    if not CAPS.frameadvance then error("emu.frameadvance not available") end
    local n = p.count or 1
    run_unpaused(function()
        maybe_turbo(p.turbo, false, function()
            for _ = 1, n do
                emu.frameadvance()
                frame_hooks()
            end
        end)
    end)
    return { framecount = CAPS.framecount and emu.framecount() or nil, state = state_summary() }
end
local function cmd_reset(p)
    if not CAPS.reboot_core then error("client.reboot_core not available") end
    client.reboot_core(); return { state = state_summary() }
end

local function cmd_screenshot(p)
    if not CAPS.screenshot then error("client.screenshot not available") end
    local path = assert(p.path, "path required (BizHawk's client.screenshot needs an explicit path)")
    client.screenshot(path)
    return path
end

local function cmd_save_state(p)
    if not CAPS.savestate_save then error("savestate.save not available") end
    local path = assert(p.path, "path required (BizHawk savestates are file-based)")
    savestate.save(path)
    return { path = path }
end
-- savestate.load implicitly unpauses the emulator. Re-pausing HERE — inside
-- the same Lua callback, before control returns to the emulator — means zero
-- frames run between load and re-pause. Pass `pause = true` to force a
-- paused state after load regardless of the prior state.
local function cmd_load_state(p)
    if not CAPS.savestate_load then error("savestate.load not available") end
    local path = assert(p.path, "path required")
    local was_paused = CAPS.ispaused and client.ispaused()
    savestate.load(path)
    local want_paused = was_paused or p.pause or false
    if want_paused and CAPS.pause then client.pause() end
    return { path = path, paused = want_paused, state = state_summary() }
end

-- Frame-advance until a memory condition holds (or a frame budget runs out).
-- Params: address (required), domain?, width? (default "u8"; supports the
-- _be widths), condition? ("eq"|"ne"|"gt"|"lt"|"change", default "ne"),
-- value? (required unless condition="change"), timeout_frames? (default 600).
-- Turns "only read RAM after gameplay starts" from a rule the caller must
-- remember into a primitive: wait_for_memory on a known init flag ≠ 0.
local function cmd_wait_for_memory(p)
    if not CAPS.frameadvance then error("emu.frameadvance not available") end
    local address = assert(p.address, "address required")
    local width     = p.width or "u8"
    local condition = p.condition or "ne"
    local timeout   = p.timeout_frames or 600
    local baseline  = nil
    if condition == "change" then
        baseline = read_memory_widthed(p.domain, address, width)
    elseif p.value == nil then
        error("value required unless condition is 'change'")
    end

    local function satisfied(v)
        if     condition == "eq"     then return v == p.value
        elseif condition == "ne"     then return v ~= p.value
        elseif condition == "gt"     then return v >  p.value
        elseif condition == "lt"     then return v <  p.value
        elseif condition == "change" then return v ~= baseline
        else error("condition must be 'eq', 'ne', 'gt', 'lt', or 'change'") end
    end

    local waited  = 0
    local current = read_memory_widthed(p.domain, address, width)
    local matched = satisfied(current)
    if not matched then
        run_unpaused(function()
            maybe_turbo(p.turbo, false, function()
                while waited < timeout do
                    emu.frameadvance()
                    frame_hooks()
                    waited = waited + 1
                    current = read_memory_widthed(p.domain, address, width)
                    if satisfied(current) then
                        matched = true
                        break
                    end
                end
            end)
        end)
    end
    return {
        matched = matched,
        frames_waited = waited,
        value = current,
        final_framecount = CAPS.framecount and emu.framecount() or nil,
    }
end

-- Batch of labeled reads in one round-trip. p.reads = array of
-- {name, address, width?, domain?}. Returns { [name] = value, ... }.
local function cmd_read_many(p)
    local reads = assert(p.reads, "reads required (array of {name, address, width?, domain?})")
    if type(reads) ~= "table" then error("reads must be an array") end
    local out = {}
    for _, spec in ipairs(reads) do
        local name = assert(spec.name, "each read needs a name")
        local addr = assert(spec.address, "address required for read '" .. tostring(name) .. "'")
        out[name] = read_memory_widthed(spec.domain, addr, spec.width or "u8")
    end
    return out
end

-- Decode `count` fixed-stride records into labeled field tables.
-- p = {base, stride, count, fields = {{name, offset, width?}, ...}, domain?}
local function cmd_read_struct_array(p)
    local base   = assert(p.base,   "base required")
    local stride = assert(p.stride, "stride required")
    local count  = assert(p.count,  "count required")
    if count < 1 then error("count must be >= 1 (got " .. tostring(count) .. ")") end
    if stride < 1 then error("stride must be >= 1 (got " .. tostring(stride) .. ")") end
    local fields = assert(p.fields, "fields required (array of {name, offset, width?})")
    if count * #fields > 4096 then
        error("count * #fields exceeds 4096 values per call — chunk the request")
    end
    return in_domain(p.domain, function()
        local out = {}
        for i = 0, count - 1 do
            local rec = { _index = i }
            for _, f in ipairs(fields) do
                local name = assert(f.name, "each field needs a name")
                rec[name] = read_width(base + i * stride + assert(f.offset, "offset required"), f.width or "u8")
            end
            out[i + 1] = rec
        end
        return out
    end)
end

local WIDTH_BYTES = {
    u8 = 1, s8 = 1,
    u16 = 2, s16 = 2, u16_be = 2, s16_be = 2,
    u32 = 4, s32 = 4, u32_be = 4, s32_be = 4,
}

-- Reject an out-of-range freeze BEFORE registering it. BizHawk's memory.write_*
-- does NOT throw on an out-of-bounds address — it silently drops the write and
-- logs "attempted write to N outside the memory size of M". Because a frozen
-- entry is re-asserted every frame (freeze_tick), that warning then repeats
-- 60×/sec forever until unfrozen. The classic trigger is passing a full 68000
-- bus address (0xFFxxxx) to the "68K RAM" domain, which is a 64 KB buffer
-- indexed 0x0000..0xFFFF. Catch it here so the freeze call errors once with a
-- clear message instead of flooding the console. Best-effort: silently skips
-- the check on builds without memory.getmemorydomainsize.
local function validate_freeze_range(addr, width, domain)
    if not CAPS.memory_get_memorydomain_size then return end
    local name = domain
        or (CAPS.memory_get_current_memorydomain and memory.getcurrentmemorydomain())
    if not name then return end
    local ok, size = pcall(memory.getmemorydomainsize, name)
    if not ok or type(size) ~= "number" or size <= 0 then return end
    local bytes = WIDTH_BYTES[width] or 1
    if addr < 0 or addr + bytes > size then
        error(string.format(
            "freeze address 0x%X (width %s) is outside domain '%s' "
            .. "(size %d bytes, valid 0x0..0x%X). If this is a full-bus "
            .. "address, mask to the domain offset (addr & 0x%X) or freeze it "
            .. "in the full-address bus domain instead (see list_memory_domains "
            .. "— e.g. 'System Bus' on NES/SNES, 'M68K BUS' on Genesis).",
            addr, tostring(width), name, size, size - 1, size - 1))
    end
end

local function freeze_one(addr, width, value, domain)
    -- Validate NOW (bad width/domain/address should error on this call, not
    -- silently every subsequent frame) — this also applies the first write.
    validate_freeze_range(addr, width, domain)
    in_domain(domain, function() write_width(addr, width, value) end)
    frozen[freeze_key(domain, addr)] = { address = addr, width = width, value = value, domain = domain }
end

local function cmd_freeze(p)
    if p.entries then
        -- Batch mode: top-level width/domain are per-entry defaults. Entries
        -- apply in order; an error keeps the earlier entries frozen.
        for i, e in ipairs(p.entries) do
            local addr  = assert(e.address, "entry " .. i .. ": address required")
            local value = assert(e.value,   "entry " .. i .. ": value required")
            freeze_one(addr, e.width or p.width or "u8", value, e.domain or p.domain)
        end
    else
        local addr  = assert(p.address, "address required")
        local value = assert(p.value,   "value required")
        freeze_one(addr, p.width or "u8", value, p.domain)
    end
    return { frozen_count = frozen_count() }
end

local function cmd_unfreeze(p)
    if p.all then
        frozen = {}
        return { frozen_count = 0 }
    end
    if p.addresses then
        for _, addr in ipairs(p.addresses) do
            frozen[freeze_key(p.domain, addr)] = nil
        end
        return { frozen_count = frozen_count() }
    end
    local addr = assert(p.address, "address required (or pass addresses / all=true)")
    frozen[freeze_key(p.domain, addr)] = nil
    return { frozen_count = frozen_count() }
end

local function cmd_list_frozen(p)
    local out = {}
    for _, f in pairs(frozen) do out[#out + 1] = f end
    -- omit the key when empty: {} would serialize as a JSON object
    return { count = #out, frozen = #out > 0 and out or nil }
end

-- Mixed batch of write/freeze/unfreeze ops, applied in order between two
-- frames — the game never runs on a half-applied set. Top-level width/domain
-- are per-op defaults. An op that errors aborts the rest but keeps earlier
-- ops applied (freeze semantics identical to cmd_freeze).
local function cmd_memory_ops(p)
    local ops = assert(p.ops, "ops required")
    local applied = 0
    for i, o in ipairs(ops) do
        local kind   = assert(o.op,      "op " .. i .. ": op required")
        local addr   = assert(o.address, "op " .. i .. ": address required")
        local width  = o.width or p.width or "u8"
        local domain = o.domain or p.domain
        if kind == "write" then
            local value = assert(o.value, "op " .. i .. ": value required")
            in_domain(domain, function() write_width(addr, width, value) end)
        elseif kind == "freeze" then
            local value = assert(o.value, "op " .. i .. ": value required")
            freeze_one(addr, width, value, domain)
        elseif kind == "unfreeze" then
            frozen[freeze_key(domain, addr)] = nil
        else
            error("op " .. i .. ": unknown op '" .. tostring(kind) .. "' (write|freeze|unfreeze)")
        end
        applied = applied + 1
    end
    return { applied = applied, frozen_count = frozen_count() }
end

-- Savestate-anchored input sweep. For each trial: reload the shared
-- state_path (so trials are independent), play that trial's frames, then read
-- the shared observe_memory set at the final frame and optionally screenshot.
-- Collapses N × (load_state + play_input_sequence + read) into one round-trip.
local function cmd_run_trials(p)
    if not CAPS.savestate_load then error("savestate.load not available") end
    if not CAPS.joypad_set     then error("joypad.set not available") end
    if not CAPS.frameadvance   then error("emu.frameadvance not available") end
    local state_path = assert(p.state_path, "state_path required")
    local trials     = assert(p.trials, "trials required (array of {name?, frames})")
    if type(trials) ~= "table" then error("trials must be an array") end

    local observe     = p.observe_memory  -- nil or array of {name, domain, address, width}
    local want_shot   = p.screenshot and true or false
    local shot_dir    = p.screenshot_dir or "C:/temp"
    local shot_prefix = p.screenshot_prefix or "trial"
    if want_shot and not CAPS.screenshot then
        error("screenshot requested but client.screenshot is not available on this build")
    end

    local out = {}
    -- keep_video true when screenshotting so turbo doesn't blank the capture.
    run_unpaused(function()
    maybe_turbo(p.turbo, want_shot, function()
    for ti, trial in ipairs(trials) do
        local name   = (type(trial) == "table" and trial.name) or ("trial" .. ti)
        local frames = (type(trial) == "table" and trial.frames) or {}
        if type(frames) ~= "table" then error("trial " .. ti .. ": frames must be an array") end

        -- Independent baseline: every trial starts from the same state.
        savestate.load(state_path)

        local played = 0
        for _, frame in ipairs(frames) do
            local buttons = (type(frame) == "table" and frame.buttons) or {}
            local player  = (type(frame) == "table" and frame.player) or 1
            local hold    = (type(frame) == "table" and frame.hold) or 1
            for _ = 1, hold do
                joypad.set(buttons, player)
                emu.frameadvance()
                frame_hooks()
                played = played + 1
            end
        end

        local rec = {
            name = name,
            played = played,
            final_framecount = CAPS.framecount and emu.framecount() or nil,
        }
        if observe then
            local mem = {}
            for _, spec in ipairs(observe) do
                mem[spec.name] = read_memory_widthed(spec.domain, spec.address, spec.width)
            end
            rec.memory = mem
        end
        if want_shot then
            -- Sanitize the label for the filename; keep it recognizable.
            local safe = tostring(name):gsub("[^%w._-]", "_")
            local path = string.format("%s/%s-%02d-%s.png", shot_dir, shot_prefix, ti, safe)
            client.screenshot(path)
            rec.screenshot_path = path
        end
        out[ti] = rec
    end
    end)
    end)
    return { trials = out }
end

-- Arbitrary-Lua escape hatch. The chunk runs with the bridge's full
-- environment in scope (memory, emu, client, joypad, savestate, gui, comm,
-- plus this script's helpers are NOT exposed — chunks see globals only).
-- Whatever it returns must be JSON-encodable: nil/boolean/number/string,
-- or a table that is either array-like or string-keyed.
local function cmd_eval_lua(p)
    local code = assert(p.code, "code required")
    local chunk, err = load(code, "=eval_lua")
    if not chunk then error("Lua parse error: " .. tostring(err)) end
    local function body()
        local results = table.pack(pcall(chunk))
        if not results[1] then error("Lua runtime error: " .. tostring(results[2])) end
        if results.n <= 1 then return nil end          -- no return value
        if results.n == 2 then return results[2] end   -- single return value
        local out = {}                                  -- multiple returns → array
        for i = 2, results.n do out[i - 1] = results[i] end
        return out
    end
    -- With unpause=true, run the chunk via run_unpaused so a chunk that steps
    -- frames (emu.frameadvance) gets frames even when the frontend is paused,
    -- then the prior pause state is restored. Without it, frameadvance inside a
    -- chunk BLOCKS until something unpauses the emulator (a known footgun).
    if p.unpause then return run_unpaused(body) end
    return body()
end

-- ── RAM search (Cheat-Engine-style) ─────────────────────────────────────────
-- One session at a time. The snapshot and candidate list live bridge-side;
-- only counts and capped candidate samples cross the wire. This replaces the
-- old "read_range twice and diff hex dumps in the client" workflow.
local search = nil
local MAX_SEARCH_BYTES = 2 * 1024 * 1024

local function search_read_bytes()
    return in_domain(search.domain, function()
        if CAPS.memory_read_bytes_as_array then
            return memory.read_bytes_as_array(search.start, search.length)
        end
        local bytes = {}
        for i = 0, search.length - 1 do bytes[i + 1] = memory.read_u8(search.start + i) end
        return bytes
    end)
end

-- Value at 0-based byte offset `off` in a bytes array, per the session width.
local function search_value_at(bytes, off)
    local w, be = search.width_bytes, search.be
    if w == 1 then return bytes[off + 1] end
    if w == 2 then
        local a, b = bytes[off + 1], bytes[off + 2]
        if be then return a * 256 + b else return b * 256 + a end
    end
    local a, b, c, d = bytes[off + 1], bytes[off + 2], bytes[off + 3], bytes[off + 4]
    if be then return ((a * 256 + b) * 256 + c) * 256 + d
    else return ((d * 256 + c) * 256 + b) * 256 + a end
end

local function cmd_search_begin(p)
    local width = p.width or "u8"
    local wb = ({ u8 = 1, u16 = 2, u32 = 4, u16_be = 2, u32_be = 4 })[width]
    if not wb then error("width must be u8, u16, u32, u16_be, or u32_be") end
    local start  = p.start or 0
    local length = p.length
    if not length then
        if not CAPS.memory_get_memorydomain_size then
            error("length required (memory.getmemorydomainsize not available on this build)")
        end
        local name = p.domain
            or (CAPS.memory_get_current_memorydomain and memory.getcurrentmemorydomain())
            or error("length required (cannot determine current domain size)")
        length = memory.getmemorydomainsize(name) - start
    end
    if length < wb or length > MAX_SEARCH_BYTES then
        error("search window must be " .. wb .. ".." .. MAX_SEARCH_BYTES .. " bytes (got " .. tostring(length) .. ")")
    end
    search = {
        domain = p.domain, start = start, length = length,
        width = width, width_bytes = wb, be = width:sub(-3) == "_be",
        candidates = nil,  -- nil = "every offset" until the first filter
    }
    local snap_ok, snap = pcall(search_read_bytes)
    if not snap_ok then
        search = nil
        error(snap, 0)
    end
    search.snap = snap
    return { start = start, length = length, width = width,
             potential_candidates = length - wb + 1 }
end

local function cmd_search_filter(p)
    if not search then error("no active search — call search_begin first") end
    local cond  = assert(p.condition,
        "condition required (eq/ne/gt/lt/changed/unchanged/increased/decreased)")
    local value = p.value
    if (cond == "eq" or cond == "ne" or cond == "gt" or cond == "lt") and value == nil then
        error("value required for condition '" .. cond .. "'")
    end
    local VALID_COND = { eq=true, ne=true, gt=true, lt=true, changed=true, unchanged=true, increased=true, decreased=true }
    if not VALID_COND[cond] then error("unknown condition: " .. tostring(cond)) end
    local cur, snap = search_read_bytes(), search.snap

    local function pass(off)
        local now = search_value_at(cur, off)
        local was = search_value_at(snap, off)
        if     cond == "eq"        then return now == value
        elseif cond == "ne"        then return now ~= value
        elseif cond == "gt"        then return now >  value
        elseif cond == "lt"        then return now <  value
        elseif cond == "changed"   then return now ~= was
        elseif cond == "unchanged" then return now == was
        elseif cond == "increased" then return now >  was
        elseif cond == "decreased" then return now <  was
        else error("unknown condition: " .. tostring(cond)) end
    end

    local passed = {}
    if search.candidates then
        for _, off in ipairs(search.candidates) do
            if pass(off) then passed[#passed + 1] = off end
        end
    else
        for off = 0, search.length - search.width_bytes do
            if pass(off) then passed[#passed + 1] = off end
        end
    end
    search.candidates = passed
    search.snap = cur   -- next filter's changed/increased compare against NOW

    local sample = {}
    for i = 1, math.min(#passed, 20) do
        local off = passed[i]
        sample[i] = { address = search.start + off, value = search_value_at(cur, off) }
    end
    return { count = #passed, sample = #sample > 0 and sample or nil }
end

local function cmd_search_results(p)
    if not search then error("no active search — call search_begin first") end
    if not search.candidates then error("no filter applied yet — call search_filter first") end
    local limit = p.limit or 100
    local cur = search_read_bytes()
    local out = {}
    for i = 1, math.min(#search.candidates, limit) do
        local off = search.candidates[i]
        out[i] = { address = search.start + off, value = search_value_at(cur, off) }
    end
    return { count = #search.candidates, results = #out > 0 and out or nil }
end

local function cmd_search_end(p)
    search = nil
    return true
end

-- ── CPU registers ───────────────────────────────────────────────────────────
local function cmd_get_registers(p)
    if not CAPS.getregisters then error("emu.getregisters not available on this core") end
    return emu.getregisters()
end

local function cmd_set_register(p)
    if not CAPS.setregister then error("emu.setregister not available on this core") end
    emu.setregister(assert(p.name, "name required"), assert(p.value, "value required"))
    return true
end

-- Disassemble `count` instructions from `address` (default: current PC via
-- emu.getregisters). emu.disassemble(pc[,domain]) returns {disasm, length};
-- walk forward by `length` for successive instructions. Core-dependent.
local function cmd_disassemble(p)
    if not CAPS.disassemble then error("emu.disassemble not available on this core") end
    local addr = p.address
    if addr == nil then
        if not CAPS.getregisters then
            error("no address given and emu.getregisters unavailable to read PC")
        end
        local regs = emu.getregisters()
        addr = regs.PC or regs.pc or regs["M68K PC"]
        if addr == nil then error("could not determine PC from registers; pass address explicitly") end
    end
    local count = p.count or 1
    if count < 1 then error("count must be >= 1") end
    if count > 128 then error("count must be <= 128") end
    local domain = p.domain
    local out = {}
    for _ = 1, count do
        local d = domain and emu.disassemble(addr, domain) or emu.disassemble(addr)
        if type(d) ~= "table" then
            error("emu.disassemble returned no result at " .. string.format("0x%X", addr))
        end
        local len = d.length or 0
        out[#out + 1] = { address = addr, disasm = d.disasm or "?", length = len }
        if len <= 0 then break end   -- guard against an infinite loop on a zero-length decode
        addr = addr + len
    end
    return { instructions = out }
end

-- Run frames until the CPU writes/reads/executes `address`, or a frame
-- budget expires. Registers a scoped event callback, steps, unregisters.
-- Answers "WHO writes this address?" — the callback snapshots the CPU
-- registers (PC!) at the moment of access.
local function cmd_trap_memory(p)
    local kind = p.kind or "write"
    local reg_name = ({ write = "on_bus_write", read = "on_bus_read", exec = "on_bus_exec" })[kind]
    if not reg_name then error("kind must be 'write', 'read', or 'exec'") end
    if not CAPS[reg_name] then
        error("event." .. reg_name .. " not available on this core")
    end
    if not CAPS.frameadvance then error("emu.frameadvance not available") end
    local address = assert(p.address, "address required")
    local timeout = p.timeout_frames or 600

    local hit = nil
    local guid = event[reg_name](function(addr, val, flags)
        if not hit then
            hit = {
                address    = addr,
                value      = val,
                registers  = CAPS.getregisters and emu.getregisters() or nil,
                framecount = CAPS.framecount and emu.framecount() or nil,
            }
        end
    end, address, "mcp_trap_" .. kind)

    local waited = 0
    local ok, err = pcall(function()
        run_unpaused(function()
            maybe_turbo(p.turbo, false, function()
                while waited < timeout and not hit do
                    emu.frameadvance()
                    frame_hooks()
                    waited = waited + 1
                end
            end)
        end)
    end)
    if CAPS.unregisterbyid then pcall(function() event.unregisterbyid(guid) end) end
    if not ok then error(err, 0) end

    return {
        hit = hit,
        frames_waited = waited,
        final_framecount = CAPS.framecount and emu.framecount() or nil,
    }
end

-- Record the HUMAN's joypad for up to max_frames (or until a memory value
-- changes), returning a play_input_sequence-compatible RLE frame list.
-- Lets a user demonstrate a move once, then hand the agent a replayable
-- sequence.
local function cmd_record_input(p)
    if not CAPS.joypad_get   then error("joypad.get not available") end
    if not CAPS.frameadvance then error("emu.frameadvance not available") end
    local max_frames = p.max_frames or 600
    local player     = p.player or 1
    local stop_spec  = p.stop_on_memory_change
    local stop_initial = stop_spec
        and read_memory_widthed(stop_spec.domain, stop_spec.address, stop_spec.width or "u8")
        or nil

    local entries  = {}
    local recorded = 0
    local stopped  = false

    -- joypad.get returns every input incl. axes (numbers) and released
    -- buttons (false) — keep only pressed booleans.
    local function pressed_now()
        local j = joypad.get(player)
        local out = {}
        for k, v in pairs(j) do
            if v == true then out[k] = true end
        end
        return out
    end

    local function same_buttons(a, b)
        for k in pairs(a) do if not b[k] then return false end end
        for k in pairs(b) do if not a[k] then return false end end
        return true
    end

    run_unpaused(function()
        while recorded < max_frames do
            emu.frameadvance()
            frame_hooks()
            recorded = recorded + 1
            local now = pressed_now()
            local last = entries[#entries]
            if last and same_buttons(last.buttons, now) then
                last.hold = last.hold + 1
            else
                entries[#entries + 1] = { buttons = now, hold = 1 }
            end
            if stop_spec then
                local cur = read_memory_widthed(stop_spec.domain, stop_spec.address, stop_spec.width or "u8")
                if cur ~= stop_initial then
                    stopped = true
                    break
                end
            end
        end
    end)

    return {
        recorded = recorded,
        stopped_early = stopped,
        frames = #entries > 0 and entries or nil,
    }
end

-- Snapshot the CURRENT joypad state for a player: which buttons are held right
-- now (booleans) plus any analog axes (numbers). Complements record_input
-- (samples over frames) and press_buttons (writes) — lets an agent CONFIRM
-- what the emulator sees this instant. Does not advance frames.
local function cmd_get_input(p)
    if not CAPS.joypad_get then error("joypad.get not available") end
    local player = p.player or 1
    local j = joypad.get(player)
    local buttons, axes = {}, {}
    for k, v in pairs(j) do
        if v == true then buttons[k] = true
        elseif type(v) == "number" then axes[k] = v end
    end
    return {
        player  = player,
        buttons = next(buttons) and buttons or nil,
        axes    = next(axes) and axes or nil,
    }
end

-- ── Movies (.bk2) ───────────────────────────────────────────────────────────
local function movie_status_table()
    local loaded = CAPS.movie_isloaded and movie.isloaded() or false
    local t = { loaded = loaded }
    -- mode() is safe even when inactive (returns "INACTIVE"); filename()/length()
    -- throw a .NET exception (→ native crash) when no movie is loaded, so only
    -- call them once a movie is actually loaded.
    if movie and has(movie, "mode") then t.mode = movie.mode() end
    if loaded then
        if movie and has(movie, "filename") then t.filename = movie.filename() end
        if movie and has(movie, "length")   then t.length   = movie.length()   end
    end
    return t
end

local function cmd_movie_status(p)
    if not movie then error("movie API not available on this build") end
    return movie_status_table()
end

local function cmd_movie_play(p)
    if not CAPS.movie_play_from_start then error("movie.play_from_start not available on this build") end
    local ok
    if p.path then ok = movie.play_from_start(p.path)
    else ok = movie.play_from_start() end
    if ok == false then
        error("movie failed to load" .. (p.path and (": " .. tostring(p.path)) or "") ..
              " (check ROM/core match — the .bk2 header records the authoring core)")
    end
    return movie_status_table()
end

local function cmd_movie_stop(p)
    if not CAPS.movie_stop then error("movie.stop not available on this build") end
    movie.stop()
    return true
end

-- ── Trace control ───────────────────────────────────────────────────────────
-- Runtime start/stop of the per-frame trace CSV (default-on at startup when
-- TRACE_PATH resolves; these commands let a session rotate/disable it).
local function trace_close()
    if trace_fh then
        trace_fh:flush()
        trace_fh:close()
        trace_fh = nil
    end
end

local function cmd_trace_start(p)
    local path = p.path or TRACE_PATH
    if not path then error("no path given and no default TRACE_PATH configured") end
    local fh, open_err = io.open(path, "w")
    if not fh then error("could not open trace file: " .. tostring(open_err)) end
    trace_close()
    trace_fh = fh
    trace_fh:write(trace_header() .. "\n")
    trace_current_path = path
    trace_frames = 0
    trace_last_frame = -1
    if p.osd ~= nil then TRACE_OSD = p.osd end
    return { path = path, osd = TRACE_OSD }
end

local function cmd_trace_stop(p)
    local frames = trace_frames
    trace_close()
    return { path = trace_current_path, frames = frames }
end

local function cmd_trace_status(p)
    return { active = trace_fh ~= nil, path = trace_current_path,
             frames = trace_frames, osd = TRACE_OSD }
end

-- ── Physics-sync trace control (v0.15.0) ─────────────────────────────────────
-- Retail nhl94.gen only: registers the two Gameloop exec hooks (0x7958 latch,
-- 0x7966 emit) and writes one row per physics tick to PHYS_PATH. See the
-- phys_latch_cb / phys_emit_cb comments above for the address rationale.
local function phys_unregister()
    if phys_guid_latch then pcall(function() event.unregisterbyid(phys_guid_latch) end); phys_guid_latch = nil end
    if phys_guid_emit  then pcall(function() event.unregisterbyid(phys_guid_emit)  end); phys_guid_emit  = nil end
end

local function cmd_phys_trace_start(p)
    if not (CAPS.on_bus_exec and CAPS.unregisterbyid) then
        error("physics-sync trace needs event.on_bus_exec on this core")
    end
    -- Hash guard: the hook addresses are retail nhl94.gen offsets — refuse to
    -- capture garbage from any other ROM.
    local hash = CAPS.gameinfo_getromhash and gameinfo.getromhash() or ""
    if hash:upper() ~= RETAIL_MD5 then
        error("physics-sync trace is retail nhl94.gen only (MD5 " .. RETAIL_MD5
            .. "); loaded ROM hash is " .. tostring(hash))
    end
    local path = p.path or PHYS_PATH
    if not path then error("no path given and no default PHYS_PATH configured") end
    local fh, open_err = io.open(path, "w")
    if not fh then error("could not open phys-sync file: " .. tostring(open_err)) end
    phys_unregister()
    if phys_fh then phys_fh:flush(); phys_fh:close() end
    phys_fh = fh
    phys_fh:write(phys_header() .. "\n")
    phys_path = path
    phys_tick = 0
    phys_latch_d7 = 0
    phys_guid_latch = event.on_bus_exec(phys_latch_cb, PHYS_ADDR_LATCH, "phys_latch")
    phys_guid_emit  = event.on_bus_exec(phys_emit_cb,  PHYS_ADDR_EMIT,  "phys_emit")
    return { path = path,
             latch_addr = string.format("0x%X", PHYS_ADDR_LATCH),
             emit_addr  = string.format("0x%X", PHYS_ADDR_EMIT) }
end

local function cmd_phys_trace_stop(p)
    phys_unregister()
    local ticks = phys_tick
    local pth   = phys_path
    if phys_fh then phys_fh:flush(); phys_fh:close(); phys_fh = nil end
    return { path = pth, ticks = ticks }
end

local function cmd_phys_trace_status(p)
    return { active = phys_fh ~= nil, path = phys_path,
             ticks = phys_tick, latched_d7 = phys_latch_d7 }
end

-- ── Dispatch table ──────────────────────────────────────────────────────────

local HANDLERS = {
    ping                 = cmd_ping,
    get_info             = cmd_get_info,
    read8                = cmd_read8,
    read16               = cmd_read16,
    read32               = cmd_read32,
    write8               = cmd_write8,
    write16              = cmd_write16,
    write32              = cmd_write32,
    read_range           = cmd_read_range,
    write_range          = cmd_write_range,
    list_memory_domains  = cmd_list_memory_domains,
    press_buttons        = cmd_press_buttons,
    play_input_sequence  = cmd_play_input_sequence,
    run_trials           = cmd_run_trials,
    pause                = cmd_pause,
    unpause              = cmd_unpause,
    frame_advance        = cmd_frame_advance,
    reset                = cmd_reset,
    screenshot           = cmd_screenshot,
    save_state           = cmd_save_state,
    load_state           = cmd_load_state,
    wait_for_memory      = cmd_wait_for_memory,
    read_many            = cmd_read_many,
    read_struct_array    = cmd_read_struct_array,
    freeze               = cmd_freeze,
    unfreeze             = cmd_unfreeze,
    list_frozen          = cmd_list_frozen,
    memory_ops           = cmd_memory_ops,
    eval_lua             = cmd_eval_lua,
    search_begin         = cmd_search_begin,
    search_filter        = cmd_search_filter,
    search_results       = cmd_search_results,
    search_end           = cmd_search_end,
    get_registers        = cmd_get_registers,
    set_register         = cmd_set_register,
    disassemble          = cmd_disassemble,
    trap_memory          = cmd_trap_memory,
    record_input         = cmd_record_input,
    get_input            = cmd_get_input,
    movie_status         = cmd_movie_status,
    movie_play           = cmd_movie_play,
    movie_stop           = cmd_movie_stop,
    trace_start          = cmd_trace_start,
    trace_stop           = cmd_trace_stop,
    trace_status         = cmd_trace_status,
    phys_trace_start     = cmd_phys_trace_start,
    phys_trace_stop      = cmd_phys_trace_stop,
    phys_trace_status    = cmd_phys_trace_status,
    osd_message          = cmd_osd_message,
}

local function dispatch(cmd)
    if not cmd.method then
        console.log("[mcp-bizhawk] << (malformed: missing method field)")
        return nil, { code = -32600, message = "missing method field" }
    end
    -- Echo every received command to the Lua console for visibility.
    local ok_enc, ps = pcall(json.encode, cmd.params or {})
    if not ok_enc then ps = "?" end
    if #ps > 600 then ps = ps:sub(1, 597) .. "..." end
    console.log(string.format("[mcp-bizhawk] << %s %s", cmd.method, ps))
    local handler = HANDLERS[cmd.method]
    if not handler then
        console.log("[mcp-bizhawk] !! unknown method: " .. tostring(cmd.method))
        return nil, { code = -32601, message = "unknown method: " .. cmd.method }
    end
    local ok, result = pcall(handler, cmd.params or {})
    -- If the OSD is up AND the emulator is paused, force a one-time repaint so a
    -- command's visible effect shows immediately — freeze/unfreeze highlights, a
    -- memory write, a loaded state. While paused emu.framecount() doesn't
    -- advance, so the OSD's frame-keyed throttle would otherwise not repaint
    -- until the next frame step (the "freeze a bunch while paused, nothing turns
    -- red until END/END" symptom). Gated on paused: while running the throttle
    -- already refreshes at its normal rate, and forcing a repaint per command
    -- would re-introduce the 60Hz drag during command bursts. Runs regardless of
    -- handler success so a partial mutation (e.g. a freeze that applied some
    -- entries then errored) still shows. -1 makes the next osd_tick draw.
    if TRACE_OSD and client and has(client, "ispaused") and client.ispaused() then
        osd_last_frame = -1
    end
    if not ok then
        console.log(string.format("[mcp-bizhawk] !! %s error: %s", cmd.method, tostring(result)))
        return nil, { code = -32603, message = tostring(result) }
    end
    return result, nil
end

-- ── Re-dial (v0.5.2) ────────────────────────────────────────────────────────
--
-- Verified against BizHawk 2.11.1 source (Api/SocketServer.cs):
--   * There is NO comm.socketServerConnect() in 2.11.x.
--   * SocketServer.IP's setter calls the private Connect(), which does
--     ReinitSocket() — a brand-new .NET Socket — before dialing. So setting
--     the IP to its current value IS the reconnect primitive.
--   * If the dial fails, _soc.Connect throws and the exception propagates
--     into Lua — so the pcall result is the TRUE success/failure signal
--     (unlike socketServerIsConnected, whose backing flag is set true on
--     connect and never cleared anywhere).
--   * The fresh socket has a default ReceiveTimeout (blocking) — SetTimeout
--     must be re-applied or the next socketServerResponse() on an idle link
--     hangs the entire emulator.
-- Is anything LISTENing on our target port RIGHT NOW? This is the safety gate
-- in front of redial(): comm.socketServerSetIp does a BLOCKING connect, and if
-- the port is dead it hangs the Lua thread long enough that mono's hang-detector
-- ABORTS EmuHawk (core dump) — verified. There is no connect timeout or
-- non-blocking connect in BizHawk's Lua. So on Linux we cheaply read
-- /proc/net/tcp{,6} (a plain file, never blocks) and only redial once a server
-- is actually accepting. Returns true (listening), false (checked, not
-- listening), or nil (couldn't read /proc — non-Linux; caller falls back to
-- attempting the redial as before).
local function port_listening(port)
    if not port then return nil end
    local hexport = string.format("%04X", port)
    local checked = false
    for _, path in ipairs({ "/proc/net/tcp", "/proc/net/tcp6" }) do
        local fh = io.open(path, "r")
        if fh then
            checked = true
            for line in fh:lines() do
                -- fields: sl  local_address  rem_address  st  ...
                -- st "0A" == TCP_LISTEN. Match the port regardless of local IP
                -- (server may bind 0.0.0.0 or 127.0.0.1 or ::).
                local laddr, st = line:match("^%s*%d+:%s+(%S+)%s+%S+%s+(%x%x)")
                if laddr and st == "0A" and laddr:match(":(%x+)$") == hexport then
                    fh:close()
                    return true
                end
            end
            fh:close()
        end
    end
    if checked then return false end
    return nil
end

local function redial()
    if not CAPS.socket_redial then
        return false, "socketServerSetIp/GetIp not available on this build"
    end
    local ok, err = pcall(function()
        comm.socketServerSetIp(comm.socketServerGetIp())
    end)
    if ok and comm.socketServerSetTimeout then
        comm.socketServerSetTimeout(SOCKET_TIMEOUT_MS)
    end
    return ok, err
end

-- ── Per-frame round trip with the external server ──────────────────────────
--
-- API notes (from BizHawk 2.11's Lua/_docs_luacats/comm.d.lua):
--   * `comm.socketServerSend(s)` returns an INTEGER (status / bytes sent).
--     Pure send — does NOT return the reply. IMPORTANT (v0.5.2): the .NET
--     side catches all socket exceptions and returns -1 — it NEVER throws
--     into Lua, so failure must be detected from the return value, not pcall.
--   * `comm.socketServerResponse()` reads the next message from the socket.
--     CRITICAL: "all responses must be of the form `{msg.Length:D} {msg}`
--     i.e. prefixed with the length in base-10 and a space." That applies
--     to INCOMING messages too — BizHawk's parser silently discards lines
--     that aren't length-prefixed. The Node side prefixes everything before
--     writing, so by the time the response gets here BizHawk has already
--     stripped the prefix and we receive just `<msg>` (no length, no newline).
--     On a dead link it catches internally and returns "" — also no throw.
--
-- Pattern: receive at start of frame (reads response to previous frame's
-- send), then send for this frame. Decouples send and receive across a full
-- frame boundary (~16ms) so the receive timeout doesn't have to be tuned to
-- network round-trip time.
local function tick()
    -- Step 1: receive response from PREVIOUS frame's send (if any).
    local incoming = comm.socketServerResponse()

    if incoming and type(incoming) == "string" and #incoming > 0 then
        -- ANY received bytes — including a bare "NONE" — prove the link is
        -- alive. This is the heartbeat; command traffic is irrelevant.
        last_rx_ms = now_ms()
        incoming = incoming:gsub("[\r\n]+$", "")
        local hello = incoming:match("^HELLO (.+)$")
        if hello then
            -- Server greets once per connection (including redials) with its
            -- version, so the console shows WHICH server build we reached.
            local ok, h = pcall(json.decode, hello)
            local v = (ok and type(h) == "table" and h.server_version) or "(unknown)"
            -- Stash it so the OSD can show which server build we're paired with
            -- alongside the bridge's own version.
            BRIDGE.server_version = tostring(v)
            -- Force the OSD to repaint even if paused: HELLO usually lands while
            -- the game is still paused at boot, and the paused throttle otherwise
            -- keeps showing the pre-HELLO "srv v?" until something advances a
            -- frame. -1 makes the next osd_tick redraw regardless of framecount.
            osd_last_frame = -1
            console.log("[mcp-bizhawk] bizhawk connected to mcp server v" .. tostring(v))
        elseif incoming == "BYE" then
            -- Server is shutting down gracefully (restart/upgrade). Mark the
            -- link down NOW so the main loop stops calling tick() — the very
            -- next socketServerResponse() would block forever on the imminent
            -- close and wedge the whole emulator. The watchdog then re-dials
            -- the restarted server. (A hard crash sends no BYE — that case
            -- can still wedge; nothing in BizHawk's Lua lets us avoid it.)
            disconnected = true
            pending_result = nil
            -- Delay the first re-dial by one RECONNECT_INTERVAL so the server
            -- has time to come back up and bind the port. comm.socketServerSetIp
            -- does a BLOCKING connect — re-dialing into a port with no listener
            -- yet hangs the Lua thread long enough for mono's hang-detector to
            -- KILL EmuHawk. Waiting avoids racing the restart.
            last_reconnect_ms = now_ms()
            console.log("[mcp-bizhawk] server said BYE (shutting down) — re-dialing in "
                .. (RECONNECT_INTERVAL_MS // 1000) .. "s")
        elseif incoming ~= "NONE" and #incoming > 0 then
            local parse_ok, cmd = pcall(json.decode, incoming)
            if parse_ok and type(cmd) == "table" then
                local result, rpc_err = dispatch(cmd)
                if rpc_err then
                    pending_result = { id = cmd.id, error = rpc_err }
                else
                    pending_result = { id = cmd.id, result = result }
                end
            else
                pending_result = { id = nil, error = { code = -32700, message = "parse error" } }
            end
        end
    end

    -- Step 2: send for THIS frame. SendString swallows exceptions and
    -- returns -1 on failure, so check the return value (pcall never fires).
    local outgoing
    if pending_result then
        outgoing = "RESULT " .. json.encode(pending_result)
    else
        outgoing = "READY"
    end
    local sent = comm.socketServerSend(outgoing .. "\n")
    if sent == -1 then
        disconnected = true
        pending_result = nil
        -- Same delay rationale as the BYE path: give the server time to rebind
        -- before the blocking re-dial connect.
        last_reconnect_ms = now_ms()
    end
end

-- ── Startup ────────────────────────────────────────────────────────────────

console.log("[mcp-bizhawk] " .. BRIDGE.name .. " v" .. BRIDGE.version .. " starting")

if not (comm and comm.socketServerSend and comm.socketServerResponse) then
    console.log("[mcp-bizhawk] FATAL: comm.socketServer* not available — launch BizHawk with --socket_ip / --socket_port flags pointing at a running mcp-bizhawk server")
    return
end

-- Read the configured target defensively: on some builds the getters THROW
-- when the socket server was never initialized (no --socket_ip/--socket_port
-- and no External Tool config), on others they return nil/"".
local function safe_get(fn)
    if not fn then return nil end
    local ok, v = pcall(fn)
    if ok then return v end
    return nil
end
local ip   = safe_get(comm.socketServerGetIp)
local port = tonumber(safe_get(comm.socketServerGetPort))

-- Without a configured target the comm.socketServer* functions still EXIST,
-- so the capability check above passes — but every send fails, and the
-- watchdog would re-dial an unset address every ~5s forever. Detect the
-- unconfigured state now and stop cleanly instead of looping. (Only when the
-- getters are available and say so — a configured target whose server isn't
-- up yet is the auto-reconnect loop's legitimate job.)
if (comm.socketServerGetIp   and (ip == nil or ip == "")) or
   (comm.socketServerGetPort and (port == nil or port <= 0)) then
    console.log("[mcp-bizhawk] FATAL: socket server target not configured (ip="
        .. tostring(ip) .. ", port=" .. tostring(port) .. ") — not polling.")
    console.log("[mcp-bizhawk] Launch BizHawk with --socket_ip=127.0.0.1 --socket_port=8766 (matching a running mcp-bizhawk server), then reload this script.")
    return
end

-- Cached for the reconnect safety gate (port_listening) in the main loop.
local target_port = port

console.log(string.format("[mcp-bizhawk] socket server target: %s:%s",
    tostring(ip or "(unknown)"), tostring(port or "(unknown)")))

-- Receive timeout for socketServerResponse(). Default BizHawk timeout (5ms)
-- is fine in steady state — replies are sitting in the socket buffer by the
-- time we poll for them — but a slightly longer window costs us nothing and
-- absorbs occasional jitter (GC pause on the Node side, OS scheduling, etc).
-- NOTE: this is re-applied inside redial() — the setter-driven reconnect
-- creates a brand-new socket, which resets ReceiveTimeout to blocking.
if comm.socketServerSetTimeout then
    comm.socketServerSetTimeout(SOCKET_TIMEOUT_MS)
    console.log("[mcp-bizhawk] socket receive timeout set to " .. SOCKET_TIMEOUT_MS .. "ms")
end

console.log("[mcp-bizhawk] frame loop active — bridge is polling once per frame")

-- OSD starts OFF (see TRACE_OSD). Tell the user how to bring it up, and warn if
-- the host input library isn't available to catch the backtick toggle.
if input and has(input, "get") then
    console.log("[mcp-bizhawk] OSD off by default — press End to toggle it on/off")
else
    console.log("[mcp-bizhawk] OSD off by default; input.get unavailable — End-key toggle disabled "
        .. "(use trace_start osd=true)")
end

if CAPS.socket_redial then
    console.log("[mcp-bizhawk] auto-reconnect enabled (SetIp re-dial) — retries every ~5s if the link dies")
else
    console.log("[mcp-bizhawk] WARNING: SetIp/GetIp not available — auto-reconnect disabled")
end

if TRACE_PATH then
    local fh, open_err = io.open(TRACE_PATH, "w")
    if fh then
        trace_fh = fh
        trace_fh:write(trace_header() .. "\n")
        trace_current_path = TRACE_PATH
        console.log("[mcp-bizhawk] NHL94 trace writing to " .. TRACE_PATH)
    else
        console.log("[mcp-bizhawk] WARNING: trace disabled — could not open "
            .. tostring(TRACE_PATH) .. ": " .. tostring(open_err))
    end
end

-- Per-frame poll. Run forever.
while true do
    tick_count = tick_count + 1

    -- Watchdog. The link is DOWN when a send returned -1, the server sent BYE,
    -- or nothing has been received for DEAD_AFTER_MS (wall clock). A healthy
    -- server answers "NONE" every frame, so silence — not the absence of
    -- commands — means dead. CRITICAL: once down we STOP calling tick(). BizHawk's
    -- socketServerResponse() blocks forever on a peer that has closed (no
    -- timeout, no error, no non-blocking probe — verified against 2.11.1), which
    -- would wedge this loop AND the whole emulator. So we gate the read on the
    -- link being up and only redial (rate-limited) while it's down.
    local now = now_ms()
    if not disconnected and last_rx_ms > 0 and (now - last_rx_ms) > DEAD_AFTER_MS then
        disconnected = true  -- silence: stop reading, start re-dialing
        console.log("[mcp-bizhawk] no rx for " .. (DEAD_AFTER_MS // 1000) .. "s — link down")
    end
    if disconnected and (now - last_reconnect_ms) >= RECONNECT_INTERVAL_MS then
        last_reconnect_ms = now
        -- SAFETY GATE: never call the blocking redial() connect unless a server
        -- is actually LISTENing on our port — otherwise SetIp hangs and mono
        -- aborts EmuHawk. port_listening() reads /proc/net/tcp (non-blocking).
        -- false = confirmed down (wait); nil = can't check (non-Linux → attempt).
        local listening = port_listening(target_port)
        if listening == false then
            console.log("[mcp-bizhawk] link down — server not listening on port "
                .. tostring(target_port) .. " yet, waiting")
        else
            console.log("[mcp-bizhawk] link down — re-dialing...")
            local ok, err = redial()
            if ok then
                reconnect_count = reconnect_count + 1
                console.log("[mcp-bizhawk] reconnected (fresh socket, #" .. reconnect_count .. ")")
                disconnected = false
                pending_result = nil
                -- Grace period: treat the re-dial moment as last rx so the silence
                -- check doesn't immediately re-fire before the first round-trip.
                last_rx_ms = now_ms()
            else
                console.log("[mcp-bizhawk] re-dial failed: " .. tostring(err))
            end
        end
    end

    -- Only poll the socket while the link is up — see the CRITICAL note above.
    if not disconnected then
        tick()
    end
    frame_hooks()
    -- ALWAYS yield here, never frameadvance. emu.frameadvance() blocks until
    -- a frame actually emulates, so if the emulator gets paused (keyboard
    -- Pause, or our own client.pause() engaging at end-of-frame) while the
    -- script is parked inside it, the script never resumes and the bridge is
    -- wedged — no unpause command can ever be delivered. Checking ispaused()
    -- before choosing frameadvance-vs-yield doesn't help: pause lands while
    -- we're already blocked, past the check. emu.yield() resumes the script
    -- every frame while running AND on UI updates while paused, so polling
    -- survives pause from any source. Frame-locked stepping still uses
    -- emu.frameadvance(), but only inside command handlers (frame_advance,
    -- play_input_sequence), which unpause first via run_unpaused().
    emu.yield()
end
