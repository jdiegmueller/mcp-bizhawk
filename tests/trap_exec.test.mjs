import test from "node:test";
import assert from "node:assert/strict";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { startHarness, textOf } from "./helpers/harness.mjs";

// Server-side tests: the bridge `trap_exec` command is mocked (its real
// event.on_bus_exec hooks are verified live after a bridge reload). These lock
// the server tool's request shaping and result formatting.

test("bizhawk_trap_exec start forwards traps and reports armed names", async () => {
  let seen;
  const h = await startHarness({
    trap_exec: (p) => { seen = p; return { started: p.traps.length, traps: p.traps.map((t, i) => t.name ?? `t${i + 1}`) }; },
  });
  try {
    const res = await h.client.callTool({
      name: "bizhawk_trap_exec",
      arguments: { target: h.target, action: "start", traps: [{ addr: 0x13d00, name: "entry", capture: ["A2", "A3", "@A3+0x28:s16"] }], limit: 50 },
    });
    assert.match(textOf(res), /Armed 1 trap\(s\): entry/);
    assert.equal(seen.action, "start");
    assert.equal(seen.limit, 50);
    assert.equal(seen.traps[0].capture[2], "@A3+0x28:s16");
  } finally {
    await h.close();
  }
});

test("bizhawk_trap_exec start requires a non-empty traps array", async () => {
  const h = await startHarness({ trap_exec: () => ({}) });
  try {
    await assert.rejects(
      h.client.callTool({ name: "bizhawk_trap_exec", arguments: { target: h.target, action: "start" } }),
      /requires a non-empty `traps`/,
    );
  } finally {
    await h.close();
  }
});

test("bizhawk_trap_exec read/status/stop format the bridge result", async () => {
  const h = await startHarness({
    trap_exec: (p) => {
      if (p.action === "read") return { active: true, counts: { entry: 2 }, traps: { entry: [{ f: 100, A3: 0x10 }, { f: 101, A3: 0x11 }] } };
      if (p.action === "status") return { active: true, counts: { entry: 2 } };
      if (p.action === "stop") return { stopped: true, counts: { entry: 2 } };
      return {};
    },
  });
  try {
    const rd = textOf(await h.client.callTool({ name: "bizhawk_trap_exec", arguments: { target: h.target, action: "read" } }));
    assert.match(rd, /counts=\{"entry":2\}/);
    assert.match(rd, /"f": 100/);
    const st = textOf(await h.client.callTool({ name: "bizhawk_trap_exec", arguments: { target: h.target, action: "status" } }));
    assert.match(st, /active=true/);
    const sp = textOf(await h.client.callTool({ name: "bizhawk_trap_exec", arguments: { target: h.target, action: "stop" } }));
    assert.match(sp, /Stopped trap_exec\. Final counts: \{"entry":2\}/);
  } finally {
    await h.close();
  }
});

test("bizhawk_trap_exec supports summary read mode and read_stop lifecycle", async () => {
  const seen = [];
  const h = await startHarness({
    trap_exec: (p) => {
      seen.push(p);
      if (p.action === "read") {
        return {
          active: true,
          counts: { entry: 3 },
          traps: { entry: [{ f: 100, A3: 0x10 }, { f: 101, A3: 0x11 }, { f: 102, A3: 0x12 }] },
        };
      }
      if (p.action === "stop") return { stopped: true, counts: { entry: 3 } };
      return {};
    },
  });
  try {
    const txt = textOf(await h.client.callTool({
      name: "bizhawk_trap_exec",
      arguments: { target: h.target, action: "read_stop", read_mode: "summary", head: 1, tail: 1 },
    }));
    assert.match(txt, /trap_exec counts=\{"entry":3\}/);
    assert.match(txt, /entry: 3 hit\(s\)/);
    assert.match(txt, /head\[0\].*"f":100/);
    assert.match(txt, /tail\[0\].*"f":102/);
    assert.match(txt, /Stopped trap_exec\. Final counts: \{"entry":3\}/);
    assert.deepEqual(seen.map((s) => s.action), ["read", "stop"]);
  } finally {
    await h.close();
  }
});

test("bizhawk_trap_exec can save readback as JSONL or CSV", async () => {
  const h = await startHarness({
    trap_exec: () => ({
      active: true,
      counts: { entry: 2 },
      traps: { entry: [{ f: 100, D7: 1 }, { f: 101, D7: 2 }] },
    }),
  });
  try {
    const jsonl = textOf(await h.client.callTool({
      name: "bizhawk_trap_exec",
      arguments: { target: h.target, action: "read", read_mode: "jsonl_file", name: "entry" },
    }));
    assert.match(jsonl, /Saved trap_exec JSONL: /);
    assert.match(jsonl, /entry\.jsonl/);
    assert.doesNotMatch(jsonl, /\/tmp|mcp-bizhawk-trap-exec/);

    const csv = textOf(await h.client.callTool({
      name: "bizhawk_trap_exec",
      arguments: { target: h.target, action: "read", read_mode: "csv_file", name: "entry" },
    }));
    assert.match(csv, /Saved trap_exec CSV: /);
    assert.match(csv, /entry\.csv/);
    assert.doesNotMatch(csv, /\/tmp|mcp-bizhawk-trap-exec/);
  } finally {
    await h.close();
    fs.rmSync(path.join(os.tmpdir(), "mcp-bizhawk-trap-exec", "entry.jsonl"), { force: true });
    fs.rmSync(path.join(os.tmpdir(), "mcp-bizhawk-trap-exec", "entry.csv"), { force: true });
  }
});
