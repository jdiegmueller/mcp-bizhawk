import assert from "node:assert/strict";
import fs from "node:fs";
import path from "node:path";
import test from "node:test";
import { fileURLToPath } from "node:url";

const here = path.dirname(fileURLToPath(import.meta.url));
const bridgePath = path.join(here, "..", "lua", "bridge_JD.lua");
const bridge = fs.readFileSync(bridgePath, "utf8");

test("bridge starts with OSD disabled", () => {
  assert.match(bridge, /local\s+TRACE_OSD\s*=\s*false\b/);
});

test("LuaCanvas window title includes the socket port", () => {
  assert.match(bridge, /local\s+function\s+bridge_window_title\s*\(/);
  assert.match(bridge, /SetTitle\(bridge_window_title\(\)\)/);
  assert.match(bridge, /tostring\(port\)/);
  assert.match(bridge, /socket_port/);
});
