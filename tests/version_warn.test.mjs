import test from "node:test";
import assert from "node:assert/strict";
import { spawnSync } from "node:child_process";
import { fileURLToPath } from "node:url";
import path from "node:path";

// Runs the standalone lua5.4 unit test for the bridge's OSD version-warning
// logic (tests/version_warn.test.lua) so it's part of `npm test`. Skips cleanly
// when lua5.4 isn't installed — the pure logic is also mirrored by the server
// HELLO test; this just locks the bridge-side truth table where lua is present.
const here = path.dirname(fileURLToPath(import.meta.url));
const luaTest = path.join(here, "version_warn.test.lua");

test("bridge version_warn / version_cmp (lua5.4)", (t) => {
  const probe = spawnSync("lua5.4", ["-v"], { encoding: "utf8" });
  if (probe.error) {
    t.skip("lua5.4 not installed");
    return;
  }
  const r = spawnSync("lua5.4", [luaTest], { encoding: "utf8" });
  if (r.status !== 0) {
    assert.fail(`lua version_warn test failed:\n${r.stdout}\n${r.stderr}`);
  }
});
