import test from "node:test";
import assert from "node:assert/strict";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { startHarness, textOf } from "./helpers/harness.mjs";

test("trace start/stop/status round-trip", async () => {
  const h = await startHarness({
    trace_start: (p) => ({ path: p.path ?? "/tmp/nhl94_trace_test.csv", osd: true }),
    trace_stop: () => ({ path: "/tmp/nhl94_trace_test.csv", frames: 480 }),
    trace_status: () => ({ active: true, path: "/tmp/nhl94_trace_test.csv", frames: 480, osd: true }),
  });
  try {
    let res = await h.client.callTool({
      name: "bizhawk_trace_start",
      arguments: { target: h.target },
    });
    assert.match(textOf(res), /Trace started → \/tmp\/nhl94_trace_test\.csv/);

    res = await h.client.callTool({ name: "bizhawk_trace_status", arguments: { target: h.target } });
    assert.match(textOf(res), /active.*480 rows/s);

    res = await h.client.callTool({ name: "bizhawk_trace_stop", arguments: { target: h.target } });
    assert.match(textOf(res), /Trace stopped after 480 rows/);
  } finally {
    await h.close();
  }
});

test("bizhawk_trace_tail returns header + last N rows", async () => {
  const file = path.join(os.tmpdir(), `trace-tail-test-${process.pid}.csv`);
  const rows = ["frame,x,y"];
  for (let i = 1; i <= 50; i++) rows.push(`${i},${i * 2},${i * 3}`);
  fs.writeFileSync(file, rows.join("\n") + "\n");

  const h = await startHarness({
    trace_status: () => ({ active: true, path: file, frames: 50, osd: false }),
  });
  try {
    const res = await h.client.callTool({ name: "bizhawk_trace_tail", arguments: { target: h.target, rows: 3 } });
    const lines = textOf(res).split("\n");
    assert.match(lines[0], /50 rows/);
    assert.equal(lines[1], "frame,x,y");
    assert.equal(lines[2], "48,96,144");
    assert.equal(lines[4], "50,100,150");
  } finally {
    await h.close();
    fs.rmSync(file, { force: true });
  }
});
