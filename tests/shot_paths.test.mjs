import test from "node:test";
import assert from "node:assert/strict";
import os from "node:os";
import path from "node:path";
import { shotPaths } from "../dist/tools.js";

const SHOT = "MCP_BIZHAWK_SHOT_DIR";
const BRIDGE = "MCP_BIZHAWK_SHOT_DIR_BRIDGE";

function withEnv(env, fn) {
  const prev = { [SHOT]: process.env[SHOT], [BRIDGE]: process.env[BRIDGE] };
  for (const k of [SHOT, BRIDGE]) (env[k] === undefined ? delete process.env[k] : (process.env[k] = env[k]));
  try { return fn(); } finally {
    for (const k of [SHOT, BRIDGE]) (prev[k] === undefined ? delete process.env[k] : (process.env[k] = prev[k]));
  }
}

test("shotPaths defaults to the OS temp dir for both sides (co-located BizHawk)", () => {
  withEnv({}, () => {
    const { local, remote } = shotPaths("shot.png");
    assert.equal(local, path.join(os.tmpdir(), "shot.png"));
    assert.equal(remote, local, "no translation when unconfigured");
  });
});

test("shotPaths maps a Windows bridge dir to a backslash path, reads back the Linux dir", () => {
  withEnv({ [SHOT]: "/mnt/8tb/jason/tmp", [BRIDGE]: "X:\\tmp" }, () => {
    const { local, remote } = shotPaths("shot.png");
    // Server reads the Linux spelling…
    assert.equal(local, "/mnt/8tb/jason/tmp/shot.png");
    // …BizHawk is told the Windows spelling of the same shared file.
    assert.equal(remote, "X:\\tmp\\shot.png");
  });
});

test("shotPaths trims a trailing separator on the configured bridge dir", () => {
  withEnv({ [SHOT]: "/srv/shots", [BRIDGE]: "X:\\tmp\\" }, () => {
    assert.equal(shotPaths("a.png").remote, "X:\\tmp\\a.png");
  });
});

test("shotPaths uses a custom server dir for both sides when no bridge dir is set", () => {
  withEnv({ [SHOT]: "/srv/shots" }, () => {
    const { local, remote } = shotPaths("b.png");
    assert.equal(local, path.join("/srv/shots", "b.png"));
    assert.equal(remote, local);
  });
});

test("shotPaths joins a POSIX bridge dir with a forward slash", () => {
  withEnv({ [SHOT]: "/srv/shots", [BRIDGE]: "/data/shots" }, () => {
    assert.equal(shotPaths("c.png").remote, "/data/shots/c.png");
  });
});
