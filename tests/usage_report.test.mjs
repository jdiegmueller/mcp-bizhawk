import { strict as assert } from "node:assert";
import { mkdtempSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { execFileSync } from "node:child_process";
import test from "node:test";

test("usage-report summarizes JSONL tool-call logs", () => {
  const dir = mkdtempSync(join(tmpdir(), "mcp-bizhawk-usage-"));
  const log = join(dir, "usage.jsonl");
  writeFileSync(
    log,
    [
      JSON.stringify({
        ts: "2026-07-19T12:00:00Z",
        tool: "nhl94_state",
        target: "bizhawk_8713",
        duration_ms: 120,
        ok: true,
        args: { describe: true },
      }),
      JSON.stringify({
        ts: "2026-07-19T12:00:02Z",
        tool: "bizhawk_eval_lua",
        target: "bizhawk_8713",
        ms: 15000,
        ok: false,
        error: "timeout",
        args: { code: "for i=1,900 do emu.frameadvance() end" },
      }),
      JSON.stringify({
        ts: "2026-07-19T12:00:04Z",
        tool: "bizhawk_play_input_sequence",
        target: "bizhawk_8714",
        duration_ms: 240,
        ok: true,
        args: { frames: [{ buttons: {}, hold: 30 }] },
      }),
      "",
    ].join("\n"),
  );

  const out = execFileSync(process.execPath, ["scripts/usage-report.cjs", log, "--json"], {
    cwd: process.cwd(),
    encoding: "utf8",
  });
  const report = JSON.parse(out);

  assert.equal(report.totalCalls, 3);
  assert.equal(report.failures, 1);
  assert.equal(report.tools.nhl94_state.count, 1);
  assert.equal(report.tools.bizhawk_eval_lua.failures, 1);
  assert.equal(report.targets.bizhawk_8713.count, 2);
  assert.equal(report.flags.evalLuaFrameadvanceCalls, 1);
  assert.equal(report.flags.longCalls, 1);
});
