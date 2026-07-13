import test from "node:test";
import assert from "node:assert/strict";
import { startHarness, textOf } from "./helpers/harness.mjs";

test("bizhawk_disassemble formats address, mnemonic, and length per instruction", async () => {
  const h = await startHarness({
    disassemble: ({ count }) => ({
      instructions: [
        { address: 0x200, disasm: "move.w d0, d1", length: 2 },
        { address: 0x202, disasm: "rts", length: 2 },
      ].slice(0, count ?? 1),
    }),
  });
  try {
    const res = await h.client.callTool({
      name: "bizhawk_disassemble",
      arguments: { address: 0x200, count: 2 },
    });
    const lines = textOf(res).split("\n");
    assert.equal(lines[0], "0x200: move.w d0, d1  (2 bytes)");
    assert.equal(lines[1], "0x202: rts  (2 bytes)");
    const call = h.bridge.calls.find((c) => c.method === "disassemble");
    assert.equal(call.params.address, 0x200);
    assert.equal(call.params.count, 2);
  } finally {
    await h.close();
  }
});
