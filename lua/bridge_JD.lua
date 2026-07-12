-- bridge_JD.lua: BizHawk-side polling client for mcp-bizhawk
-- v0.5.5
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
--   3. If a command came back, execute it locally and stash the result so
--      the next frame's send carries it back.
--
-- Wire format: newline-delimited UTF-8.
--   - Lua → server: "READY\n" | "RESULT <json>\n"
--   - Server → Lua: "NONE\n"  | "<json command>\n"
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
    version    = "0.5.5",
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

local TRACE_PATH
do
    local port = nil
    if comm and has(comm, "socketServerGetPort") then
        local ok, p = pcall(function() return comm.socketServerGetPort() end)
        if ok then port = tonumber(p) end
    end
    TRACE_PATH = port and ("/tmp/nhl94_trace_" .. port .. ".csv")
                      or  "/tmp/nhl94_trace.csv"
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

-- ── Live animation OSD (v0.5.4) ─────────────────────────────────────────────
-- On-screen readout of the same animation state the trace records: one line
-- per player slot showing resolved frame (+0x06), SPA anim# (+0x58), SPAnum
-- slot (+0x5A, shown /4 as a slot index) and "x" when attribute bit 3
-- (x-flip) is set, plus the puck frame. Set TRACE_OSD = false to disable.
local TRACE_OSD = true

-- gui.text (EmuHawk OSD renderer, window coords) — NOT gui.pixelText, whose
-- bitmap font renders as empty boxes under mono/Linux.
local osd_text
if gui and has(gui, "text") then
    osd_text = function(x, y, s) gui.text(x, y, s) end
end

local OSD_LINE_H = 16   -- gui.text line height in window pixels

local function osd_tick()
    if not TRACE_OSD or not osd_text then return end
    for n = 0, 11 do
        local base = SORTCORDS + n * SCSIZE
        osd_text(4, 4 + n * OSD_LINE_H, string.format("s%-2d f%-3d a%02X.%d%s",
            n,
            tr_u16(base + 0x06),
            tr_u16(base + 0x58),
            tr_u16(base + 0x5A) // 4,
            (tr_u16(base + 0x04) & 0x8) ~= 0 and " x" or ""))
    end
    osd_text(4, 4 + 12 * OSD_LINE_H, string.format("pk f%-3d", tr_u16(PUCK_ADDR + 0x06)))
end

local CAPS = {
    -- emu
    framecount   = emu and has(emu, "framecount"),
    frameadvance = emu and has(emu, "frameadvance"),
    yield        = emu and has(emu, "yield"),
    -- client (pause control lives here, NOT on emu — emu.pause doesn't exist
    -- in BizHawk; that's an mGBA-ism)
    pause        = client and has(client, "pause"),
    unpause      = client and has(client, "unpause"),
    ispaused     = client and has(client, "ispaused"),
    reboot_core  = client and has(client, "reboot_core"),
    screenshot   = client and has(client, "screenshot"),
    -- savestate
    savestate_save = savestate and has(savestate, "save"),
    savestate_load = savestate and has(savestate, "load"),
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
}

-- ── Command handlers ────────────────────────────────────────────────────────

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
    return {
        bridge        = BRIDGE,
        rom_name      = CAPS.gameinfo_getromname and gameinfo.getromname() or nil,
        rom_hash      = CAPS.gameinfo_getromhash and gameinfo.getromhash() or nil,
        framecount    = CAPS.framecount and emu.framecount() or nil,
        memory_domains = memory_domain_list(),
        -- Which domain is read/written when a memory tool call omits `domain`.
        -- Useful because BizHawk's "current" domain can drift after savestate
        -- loads or other Lua scripts changing it underneath us.
        current_memory_domain = CAPS.memory_get_current_memorydomain
            and memory.getcurrentmemorydomain() or nil,
        capabilities  = CAPS,
    }
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
--                         "u8" | "u16" | "u32" | "u16_be" | "u32_be"
--                         (the _be widths since v0.3.0). Results land in each
--                         observation as `memory = { name = value, ... }`.
--   p.stop_on_memory_change — {domain, address, width} — record this
--                         value at the start, abort play the moment it
--                         changes. Result includes stopped_early=true and
--                         stop_reason='memory_changed'. The final
--                         observation (if screenshot/memory enabled) is
--                         always captured at the stop frame.
-- width: "u8" | "u16" | "u32" (little-endian) | "u16_be" | "u32_be"
local function read_width(address, width)
    if     width == "u8"     then return memory.read_u8(address)
    elseif width == "u16"    then return memory.read_u16_le(address)
    elseif width == "u32"    then return memory.read_u32_le(address)
    elseif width == "u16_be" then return memory.read_u16_be(address)
    elseif width == "u32_be" then return memory.read_u32_be(address)
    else error("width must be 'u8', 'u16', 'u32', 'u16_be', or 'u32_be' (got " .. tostring(width) .. ")") end
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
    for i, frame in ipairs(frames) do
        local buttons = (type(frame) == "table" and frame.buttons) or {}
        local player  = (type(frame) == "table" and frame.player) or 1
        local hold    = (type(frame) == "table" and frame.hold) or 1
        for _ = 1, hold do
            -- joypad.set only applies for one frame, so re-assert each frame
            -- of the hold.
            joypad.set(buttons, player)
            emu.frameadvance()
            trace_tick()
            osd_tick()
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
        for _ = 1, n do
            emu.frameadvance()
            trace_tick()
            osd_tick()
        end
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
            while waited < timeout do
                emu.frameadvance()
                trace_tick()
                osd_tick()
                waited = waited + 1
                current = read_memory_widthed(p.domain, address, width)
                if satisfied(current) then
                    matched = true
                    break
                end
            end
        end)
    end
    return {
        matched = matched,
        frames_waited = waited,
        value = current,
        final_framecount = CAPS.framecount and emu.framecount() or nil,
    }
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
}

local function dispatch(cmd)
    if not cmd.method then
        return nil, { code = -32600, message = "missing method field" }
    end
    local handler = HANDLERS[cmd.method]
    if not handler then
        return nil, { code = -32601, message = "unknown method: " .. cmd.method }
    end
    local ok, result = pcall(handler, cmd.params or {})
    if not ok then
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
        if incoming ~= "NONE" and #incoming > 0 then
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

local ip   = comm.socketServerGetIp   and comm.socketServerGetIp()   or "(unknown)"
local port = comm.socketServerGetPort and comm.socketServerGetPort() or "(unknown)"
console.log(string.format("[mcp-bizhawk] socket server target: %s:%s", tostring(ip), tostring(port)))

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
    trace_fh = assert(io.open(TRACE_PATH, "w"))
    trace_fh:write(trace_header() .. "\n")
    console.log("[mcp-bizhawk] NHL94 trace writing to " .. TRACE_PATH)
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
    trace_tick()
    osd_tick()
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
