-- bridge_JD.lua: BizHawk-side polling client for mcp-bizhawk
-- v0.15.1
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
--   * Watchdog is rate-limited (last_reconnect_tick) — the old heartbeat
--     condition re-fired every frame once stale.
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
    version    = "0.15.1",
    pause_safe = true,
}

-- Pending result from last frame's command. Sent back at the start of the
-- next frame's round-trip (instead of a bare "READY").
local pending_result = nil
local tick_count = 0
local disconnected = false

-- Link-liveness bookkeeping (v0.5.2). The server answers every frame's
-- READY with at least "NONE", so a healthy link RECEIVES bytes every frame.
-- last_rx_tick is bumped on ANY received bytes (including "NONE") and is
-- the only heartbeat; command traffic is irrelevant to liveness.
local last_rx_tick        = 0
local last_reconnect_tick = 0
local RECONNECT_INTERVAL  = 300   -- ticks between re-dial attempts (~5s)
local DEAD_AFTER          = 600   -- ticks without rx before declaring dead (~10s)
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
    RNGseed   = 0xFFD066, collflag = 0xFFBFA0, evalue = 0xFFBFA2,
    gmode     = 0xFFC2EA, shotplayer = 0xFFBED8, lastplayer = 0xFFBEDA,
    passdir   = 0xFFBEDC, passspeed = 0xFFBEDE,
}

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
    phys_fh:write(string.format("%d,%d,%d,%s,%d,%d,%d,%d,%d,%d,%d\n",
        phys_tick, emu.framecount(), phys_latch_d7, trace_pad_string(1),
        tr_s16(b + 0x00), tr_u16(b + 0x02),      -- X 16.16: whole, sub
        tr_s16(b + 0x14), tr_u16(b + 0x16),      -- Y 16.16: whole, sub
        tr_s16(b + 0x28), tr_s16(b + 0x2A),      -- xv, yv
        tr_u16(b + 0x54)))                       -- fdir
    if phys_tick % TRACE_FLUSH == 0 then phys_fh:flush() end
end

local function phys_header()
    return "tick,frame,d7,pad,x,xsub,y,ysub,xv,yv,fdir"
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
-- Set TRACE_OSD = false to disable, or toggle at runtime via
-- trace_start/trace_stop's `osd` param.
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

local OSD_LINE_H = 16   -- gui.text fallback line height (fixed OSD font)
local OSD_LINES  = 16   -- header + 12 slots + puck + globals + version

-- Canvas render metrics (v0.14.0: 2x the original size).
local OSD_CANVAS_LINE_H = 32
local OSD_CANVAS_FONT   = 24
local OSD_CANVAS_W      = 640

local osd_canvas = nil
local osd_canvas_failed = false   -- don't retry a broken canvas every frame

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

local function osd_lines()
    local lines = {}
    local clock   = tr_u16(TRACE_G.gameclock)   -- seconds remaining in period
    -- gmode bit 0 SET means the clock is STOPPED (verified live 2026-07-13:
    -- clock ticks down while gmode==0, holds while gmode==1). Note the trace
    -- CSV's "clockrun" column records the raw gmode&1, i.e. it is actually
    -- a clock-STOPPED flag.
    local running = (tr_u8(TRACE_G.gmode) & 1) == 0
    local carrier = osd_carrier()
    lines[#lines + 1] = string.format("clk %d:%02d %s   carry %s",
        clock // 60, clock % 60,
        running and "run " or "stop",
        carrier and ("s" .. carrier) or "--")
    for n = 0, 11 do
        local base = SORTCORDS + n * SCSIZE
        lines[#lines + 1] = string.format("s%-2d%s x%-5d y%-5d d%-2d v %d,%d",
            n,
            n == carrier and "*" or " ",
            tr_s16(base + 0x00),
            tr_s16(base + 0x14),
            tr_u16(base + 0x54),
            tr_s16(base + 0x28),
            tr_s16(base + 0x2A))
    end
    lines[#lines + 1] = string.format("pk   x%-5d y%-5d      v %d,%d",
        tr_s16(PUCK_ADDR + 0x00),
        tr_s16(PUCK_ADDR + 0x14),
        tr_s16(PUCK_ADDR + 0x28),
        tr_s16(PUCK_ADDR + 0x2A))
    lines[#lines + 1] = string.format("shot s%d  last s%d  pass d%d,%d",
        tr_s16(TRACE_G.shotplayer),
        tr_s16(TRACE_G.lastplayer),
        tr_s16(TRACE_G.passdir),
        tr_s16(TRACE_G.passspeed))
    lines[#lines + 1] = string.format("%s v%s", BRIDGE.name, BRIDGE.version)
    return lines
end

local function osd_tick()
    if not TRACE_OSD then return end
    local canvas = osd_get_canvas()
    if canvas then
        local ok = pcall(function()
            local lines = osd_lines()
            canvas.Clear(0xFF101010)
            for i, s in ipairs(lines) do
                canvas.DrawText(4, 4 + (i - 1) * OSD_CANVAS_LINE_H, s,
                    0xFFFFFFFF, nil, OSD_CANVAS_FONT, "Courier New")
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
    return true
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
local frozen = {}

local function freeze_key(domain, address)
    return (domain or "") .. ":" .. tostring(address)
end

local function frozen_count()
    local n = 0
    for _ in pairs(frozen) do n = n + 1 end
    return n
end

local function freeze_tick()
    for _, f in pairs(frozen) do
        -- pcall: a stale entry (domain gone after core switch) must never
        -- kill the poll loop.
        pcall(function()
            if f.domain then
                local prev = memory.getcurrentmemorydomain and memory.getcurrentmemorydomain() or nil
                if not memory.usememorydomain(f.domain) then error("unknown domain") end
                write_width(f.address, f.width, f.value)
                if prev then memory.usememorydomain(prev) end
            else
                write_width(f.address, f.width, f.value)
            end
        end)
    end
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

    local screenshot_every  = p.screenshot_every
    local screenshot_dir    = p.screenshot_dir    or "C:/temp"
    local screenshot_prefix = p.screenshot_prefix or "obs"
    if screenshot_every and not CAPS.screenshot then
        error("screenshot_every requested but client.screenshot is not available on this build")
    end

    local observe_memory = p.observe_memory  -- nil or array of {name, domain, address, width}
    local stop_spec      = p.stop_on_memory_change  -- nil or {domain, address, width}

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
                    -- Always capture the stop frame as an observation (regardless of screenshot_every cadence)
                    if screenshot_every or observe_memory then
                        capture_observation()
                    end
                    break
                end
            end

            -- Periodic observation (only if we didn't already capture for stop)
            if (screenshot_every or observe_memory) and (count % (screenshot_every or 0xFFFF) == 0 or count == total) then
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
    }
end

local function cmd_pause(p)
    if not CAPS.pause then error("client.pause not available") end
    client.pause(); return true
end
local function cmd_unpause(p)
    if not CAPS.unpause then error("client.unpause not available") end
    client.unpause(); return true
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
    return CAPS.framecount and emu.framecount() or nil
end
local function cmd_reset(p)
    if not CAPS.reboot_core then error("client.reboot_core not available") end
    client.reboot_core(); return true
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
    return { path = path, paused = want_paused }
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

local function freeze_one(addr, width, value, domain)
    -- Validate NOW (bad width/domain/address should error on this call, not
    -- silently every subsequent frame) — this also applies the first write.
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
    if #ps > 200 then ps = ps:sub(1, 197) .. "..." end
    console.log(string.format("[mcp-bizhawk] << %s %s", cmd.method, ps))
    local handler = HANDLERS[cmd.method]
    if not handler then
        console.log("[mcp-bizhawk] !! unknown method: " .. tostring(cmd.method))
        return nil, { code = -32601, message = "unknown method: " .. cmd.method }
    end
    local ok, result = pcall(handler, cmd.params or {})
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
        last_rx_tick = tick_count
        incoming = incoming:gsub("[\r\n]+$", "")
        local hello = incoming:match("^HELLO (.+)$")
        if hello then
            -- Server greets once per connection (including redials) with its
            -- version, so the console shows WHICH server build we reached.
            local ok, h = pcall(json.decode, hello)
            local v = (ok and type(h) == "table" and h.server_version) or "(unknown)"
            console.log("[mcp-bizhawk] bizhawk connected to mcp server v" .. tostring(v))
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

    -- Watchdog (v0.5.2). Declare the link dead when EITHER a send returned
    -- -1 OR nothing has been received for DEAD_AFTER ticks (~10s) after we
    -- had traffic at least once. A healthy server answers "NONE" every
    -- frame, so silence — not the absence of commands — means dead. The
    -- attempt itself is rate-limited so a stale condition can't fire at
    -- 60Hz like the old heartbeat did.
    local silent = last_rx_tick > 0 and (tick_count - last_rx_tick) > DEAD_AFTER
    if (disconnected or silent)
        and (tick_count - last_reconnect_tick) >= RECONNECT_INTERVAL then
        last_reconnect_tick = tick_count
        console.log("[mcp-bizhawk] link dead ("
            .. (disconnected and "send failed" or "no rx for 10s")
            .. ") — re-dialing...")
        local ok, err = redial()
        if ok then
            console.log("[mcp-bizhawk] reconnected (fresh socket)")
            disconnected = false
            pending_result = nil
            -- Grace period: treat the re-dial moment as last rx so the
            -- silence check doesn't immediately re-fire before the first
            -- round-trip completes.
            last_rx_tick = tick_count
        else
            console.log("[mcp-bizhawk] re-dial failed: " .. tostring(err))
        end
    end

    tick()
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
