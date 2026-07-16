import test from "node:test";
import assert from "node:assert/strict";
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
      arguments: { action: "start", traps: [{ addr: 0x13d00, name: "entry", capture: ["A2", "A3", "@A3+0x28:s16"] }], limit: 50 },
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
      h.client.callTool({ name: "bizhawk_trap_exec", arguments: { action: "start" } }),
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
    const rd = textOf(await h.client.callTool({ name: "bizhawk_trap_exec", arguments: { action: "read" } }));
    assert.match(rd, /counts=\{"entry":2\}/);
    assert.match(rd, /"f": 100/);
    const st = textOf(await h.client.callTool({ name: "bizhawk_trap_exec", arguments: { action: "status" } }));
    assert.match(st, /active=true/);
    const sp = textOf(await h.client.callTool({ name: "bizhawk_trap_exec", arguments: { action: "stop" } }));
    assert.match(sp, /Stopped trap_exec\. Final counts: \{"entry":2\}/);
  } finally {
    await h.close();
  }
});
