import test from "node:test";
import assert from "node:assert/strict";
import { spawnSync } from "node:child_process";
import { fileURLToPath } from "node:url";
import path from "node:path";

const here = path.dirname(fileURLToPath(import.meta.url));
const luaTest = path.join(here, "osd_helpers.test.lua");

test("bridge OSD socket badge and clock-freeze helpers (lua5.4)", (t) => {
  const probe = spawnSync("lua5.4", ["-v"], { encoding: "utf8" });
  if (probe.error) {
    t.skip("lua5.4 not installed");
    return;
  }
  const r = spawnSync("lua5.4", [luaTest], { encoding: "utf8" });
  if (r.status !== 0) {
    assert.fail(`lua OSD helper test failed:\n${r.stdout}\n${r.stderr}`);
  }
});
