import test from "node:test";
import assert from "node:assert/strict";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { startHarness, textOf } from "./helpers/harness.mjs";

test("phys trace start/stop/status round-trip", async () => {
  const h = await startHarness({
    phys_trace_start: (p) => ({
      path: p.path ?? "/tmp/nhl94_phys_1.csv",
      latch_addr: "0x7958",
      emit_addr: "0x7966",
    }),
    phys_trace_stop: () => ({ path: "/tmp/nhl94_phys_1.csv", ticks: 123 }),
    phys_trace_status: () => ({ active: true, path: "/tmp/nhl94_phys_1.csv", ticks: 123, latched_d7: 2 }),
  });
  try {
    let res = await h.client.callTool({
      name: "bizhawk_phys_trace_start",
      arguments: { path: "/tmp/nhl94_phys_1.csv" },
    });
    assert.match(textOf(res), /Physics-sync trace started → \/tmp\/nhl94_phys_1\.csv \(latch 0x7958, emit 0x7966\)/);

    res = await h.client.callTool({ name: "bizhawk_phys_trace_status", arguments: {} });
    assert.match(textOf(res), /active.*123 ticks, last D7: 2/s);

    res = await h.client.callTool({ name: "bizhawk_phys_trace_stop", arguments: {} });
    assert.match(textOf(res), /Physics-sync trace stopped after 123 ticks/);
  } finally {
    await h.close();
  }
});

test("bizhawk_phys_trace_tail returns header + last N rows", async () => {
  const file = path.join(os.tmpdir(), `phys-tail-test-${process.pid}.csv`);
  const rows = ["tick,frame,d7,pad,x,xsub,y,ysub,xv,yv,fdir"];
  for (let i = 1; i <= 50; i++) rows.push(`${i},${i * 2},1,0,${i},0,${i},0,0,0,0`);
  fs.writeFileSync(file, rows.join("\n") + "\n");

  const h = await startHarness({
    phys_trace_status: () => ({ active: true, path: file, ticks: 50, latched_d7: 1 }),
  });
  try {
    const res = await h.client.callTool({ name: "bizhawk_phys_trace_tail", arguments: { rows: 3 } });
    const lines = textOf(res).split("\n");
    assert.match(lines[0], /50 ticks, active: yes/);
    assert.equal(lines[1], "tick,frame,d7,pad,x,xsub,y,ysub,xv,yv,fdir");
    assert.equal(lines[2], "48,96,1,0,48,0,48,0,0,0,0");
    assert.equal(lines[4], "50,100,1,0,50,0,50,0,0,0,0");
  } finally {
    await h.close();
    fs.rmSync(file, { force: true });
  }
});

test("bizhawk_phys_trace_tail errors when never started", async () => {
  const h = await startHarness({
    phys_trace_status: () => ({ active: false, ticks: 0, latched_d7: 0 }),
  });
  try {
    // The handler throws, which travels back as a JSON-RPC error, so callTool rejects.
    await assert.rejects(
      h.client.callTool({ name: "bizhawk_phys_trace_tail", arguments: {} }),
      /never been started/,
    );
  } finally {
    await h.close();
  }
});
