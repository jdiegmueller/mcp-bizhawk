import test from "node:test";
import assert from "node:assert/strict";
import { startHarness, textOf } from "./helpers/harness.mjs";

test("bizhawk_trap_memory reports a hit with registers", async () => {
  const h = await startHarness({
    trap_memory: (p) => ({
      hit: { address: p.address, value: 7, registers: { PC: 0x4a2c }, framecount: 5001 },
      frames_waited: 12,
      final_framecount: 5001,
    }),
  });
  try {
    const res = await h.client.callTool({
      name: "bizhawk_trap_memory",
      arguments: { kind: "write", address: 0xc468, timeout_frames: 100 },
    });
    const text = textOf(res);
    assert.match(text, /TRAPPED write @ 0xC468 after 12 frame\(s\)/);
    assert.match(text, /value: 7/);
    assert.match(text, /PC = 18988 \(0x4A2C\)/);
    const call = h.bridge.calls.find((c) => c.method === "trap_memory");
    assert.equal(call.params.kind, "write");
    assert.equal(call.params.timeout_frames, 100);
  } finally {
    await h.close();
  }
});

test("bizhawk_trap_memory reports a timeout without erroring", async () => {
  const h = await startHarness({
    trap_memory: () => ({ frames_waited: 100, final_framecount: 6000 }),
  });
  try {
    const res = await h.client.callTool({
      name: "bizhawk_trap_memory",
      arguments: { address: 0x10 },
    });
    assert.equal(res.isError ?? false, false);
    assert.match(textOf(res), /No write to 0x0010 within 100 frame\(s\)/);
  } finally {
    await h.close();
  }
});
