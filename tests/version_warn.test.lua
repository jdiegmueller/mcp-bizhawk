-- Standalone lua5.4 unit test for the OSD version-warning logic in
-- lua/bridge_JD.lua (version_cmp + version_warn). Pure functions, so we extract
-- them straight from the bridge source and load() them — no BizHawk globals
-- needed. Run: lua5.4 tests/version_warn.test.lua
--
-- version_warn drives the OSD's orange "stale component" highlight. The whole
-- point of the RPC-protocol change: matching protocols must NOT warn even when
-- the display version strings differ.

local here = arg[0]:match("^(.*)/[^/]*$") or "."
local src = assert(io.open(here .. "/../lua/bridge_JD.lua", "r")):read("*a")

-- Pull the contiguous block that defines version_cmp .. version_warn.
local block = src:match("(local function version_cmp.-\nend)\n\n%-%- Build a visible")
  or src:match("(local function version_cmp.-return false, false\nend)")
assert(block, "could not extract version_cmp/version_warn from bridge source")
-- Expose the two locals to the test by appending a return.
local chunk = assert(load(block .. "\nreturn version_cmp, version_warn"))
local version_cmp, version_warn = chunk()
assert(type(version_warn) == "function", "version_warn not loaded")

local fails = 0
local function check(name, gotc, gots, wantc, wants)
  if gotc ~= wantc or gots ~= wants then
    fails = fails + 1
    io.stderr:write(string.format("FAIL %s: got (cli=%s,srv=%s) want (cli=%s,srv=%s)\n",
      name, tostring(gotc), tostring(gots), tostring(wantc), tostring(wants)))
  else
    print("ok   " .. name)
  end
end

-- Identical versions + matching protocol → never warn.
do local c,s = version_warn("2026.7.22-jd","2026.7.22-jd",1,1); check("identical", c,s, false,false) end

-- Versions differ but SAME protocol → NO warning (the key new behavior).
do local c,s = version_warn("2026.7.30-jd","2026.7.22-jd",1,1); check("diff-ver-same-proto", c,s, false,false) end

-- Protocol mismatch → flag the OLDER-protocol half (protocol is the authority,
-- regardless of which display-version string looks newer).
do local c,s = version_warn("2026.9.1-jd","2026.7.22-jd",1,2); check("proto cli<srv", c,s, true,false) end
do local c,s = version_warn("2026.7.1-jd","2026.7.22-jd",3,2); check("proto cli>srv", c,s, false,true) end

-- Server protocol unknown (pre-protocol server) → fall back to version-string age.
do local c,s = version_warn("2026.7.22-jd","2026.7.10-jd",1,nil); check("fallback srv-older", c,s, false,true) end
do local c,s = version_warn("2026.7.10-jd","2026.7.22-jd",1,nil); check("fallback cli-older", c,s, true,false) end

-- version_cmp sanity.
assert(version_cmp("2026.7.6-jd","2026.7.10-jd") == -1)
assert(version_cmp("2026.7.10-jd","2026.7.6-jd") == 1)
assert(version_cmp("2026.7.6-jd","2026.7.6-jd") == 0)
print("ok   version_cmp ordering")

if fails > 0 then io.stderr:write(fails .. " failure(s)\n"); os.exit(1) end
print("all version_warn tests passed")
