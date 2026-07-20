-- Standalone lua5.4 unit test for pure OSD helpers in lua/bridge_JD.lua.
-- These helpers keep socket identity/status consistent between the LuaCanvas
-- OSD and the tiny in-game overlay, and make clock freezes highlight the clock
-- value itself.

local here = arg[0]:match("^(.*)/[^/]*$") or "."
local src = assert(io.open(here .. "/../lua/bridge_JD.lua", "r")):read("*a")

local function extract(start_text, end_text, label)
  local a = src:find(start_text, 1, true)
  assert(a, "could not find start of " .. label)
  local b = src:find(end_text, a, true)
  assert(b, "could not find end of " .. label)
  local block = src:sub(a, b + #end_text - 1)
  assert(block, "could not extract " .. label .. " from bridge source")
  return block
end

local socket_block = extract("local function socket_badge_text()", "\nend", "socket_badge_text")
local frozen_block = extract("local function osd_frozen_fields()", "\n    return out\nend", "osd_frozen_fields")
local build_block = extract("local function osd_build(segs)", "\nend", "osd_build")
local clock_block = extract("local function osd_clock_line(", "\nend", "osd_clock_line")
local mode_block = extract("local function osd_game_mode_label(", "\nend", "osd_game_mode_label")
local players_block = extract("local function osd_players_label(", "\nend", "osd_players_label")
local penalties_block = extract("local function osd_penalties_label(", "\nend", "osd_penalties_label")

local env = {
  tostring = tostring,
  string = string,
  pairs = pairs,
  ipairs = ipairs,
  tonumber = tonumber,
  table = table,
  SORTCORDS = 0xFFB04A,
  SCSIZE = 0x80,
  TRACE_G = { gameclock = 0xFFC468, puckc = 0xFFB7AA, gsp = 0xFFC466 },
  frozen = {},
  ip = "127.0.0.1",
  port = 8768,
  disconnected = false,
}

local chunk = assert(load(
  socket_block .. "\n" .. frozen_block .. "\n" .. build_block .. "\n" .. clock_block ..
  "\n" .. mode_block .. "\n" .. players_block .. "\n" .. penalties_block ..
  "\nreturn socket_badge_text, osd_frozen_fields, osd_clock_line, osd_game_mode_label, osd_players_label, osd_penalties_label",
  "osd_helpers", "t", env))
local socket_badge_text, osd_frozen_fields, osd_clock_line, osd_game_mode_label, osd_players_label, osd_penalties_label = chunk()

assert(socket_badge_text() == "127.0.0.1:8768:CONNECTED", socket_badge_text())
env.disconnected = true
assert(socket_badge_text() == "127.0.0.1:8768:NOT CONNECTED", socket_badge_text())
print("ok   socket badge reflects target and link state")

env.frozen = {
  clk = { address = 0xFFC468, width = "u16_be", value = 573, domain = "M68K BUS" },
}
local ff = osd_frozen_fields()
assert(ff.clock == true, "gameclock freeze should mark ff.clock")
print("ok   gameclock freeze maps to clock OSD field")

local visible, overlay = osd_clock_line(ff, "1st", 573, true, 4)
assert(visible:match("1st 9:33 run%s+carry s4"), visible)
assert(overlay and overlay:match("9:33"), overlay or "(nil)")
assert(not overlay:match("1st"), overlay)
print("ok   clock line highlights the time value only")

assert(osd_game_mode_label(0x00) == "Exhibition", osd_game_mode_label(0x00))
assert(osd_game_mode_label(0x87) == "Shootout", osd_game_mode_label(0x87))
print("ok   game mode label distinguishes exhibition and shootout mode")

assert(osd_players_label(0xffff, 0xffff, 0, 0) == "CPU-CPU")
assert(osd_players_label(4, 0xffff, 0x0010, 0) == "1P-CPU")
assert(osd_players_label(4, 0xffff, 0, 0x0010) == "2P-CPU")
assert(osd_players_label(0xffff, 8, 0, 0) == "CPU-1P")
assert(osd_players_label(4, 8, 0, 0) == "1P-2P")
print("ok   players label covers CPU/human control snapshots")

assert(osd_penalties_label(0, 0x0000) == "OFF/offside OFF")
assert(osd_penalties_label(2, 0x0000) == "ON-exc-offside/offside OFF")
assert(osd_penalties_label(1, 0x2000) == "ON/offside ON")
print("ok   penalties label separates penalty option from offside gate")

print("all OSD helper tests passed")
