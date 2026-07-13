import test from "node:test";
import assert from "node:assert/strict";
import { startHarness, textOf } from "./helpers/harness.mjs";

test("bizhawk_read_many returns labeled values in request order", async () => {
  const mem = { 0x100: 5, 0x200: 700, 0x300: -12 };
  const h = await startHarness({
    read_many: (p) => Object.fromEntries(p.reads.map((s) => [s.name, mem[s.address] ?? 0])),
  });
  try {
    const res = await h.client.callTool({
      name: "bizhawk_read_many",
      arguments: {
        reads: [
          { name: "hp", address: 0x100, width: "u8" },
          { name: "score", address: 0x200, width: "u16_be" },
          { name: "vel_y", address: 0x300, width: "s16_be" },
        ],
      },
    });
    const lines = textOf(res).split("\n");
    assert.equal(lines[0], "hp = 5 (0x5)");
    assert.equal(lines[1], "score = 700 (0x2BC)");
    assert.equal(lines[2], "vel_y = -12");
    const call = h.bridge.calls.find((c) => c.method === "read_many");
    assert.equal(call.params.reads.length, 3);
    assert.equal(call.params.reads[2].width, "s16_be");
  } finally {
    await h.close();
  }
});
