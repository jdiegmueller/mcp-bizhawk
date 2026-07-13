import test from "node:test";
import assert from "node:assert/strict";
import { startHarness, textOf } from "./helpers/harness.mjs";

test("bizhawk_memory_ops passes a mixed batch through and reports each op", async () => {
  const h = await startHarness({ memory_ops: () => ({ applied: 4, frozen_count: 2 }) });
  try {
    const res = await h.client.callTool({
      name: "bizhawk_memory_ops",
      arguments: {
        width: "u16_be",
        domain: "M68K BUS",
        ops: [
          { op: "write",    address: 0xffb44a, value: 0xff92 },
          { op: "freeze",   address: 0xffb45e, value: 0x11d },
          { op: "freeze",   address: 0xffb4ca, value: 10, width: "u8" },
          { op: "unfreeze", address: 0xffb54a },
        ],
      },
    });
    const text = textOf(res);
    assert.match(text, /Wrote 0xFFB44A \(M68K BUS\) = 65426 \(0xFF92\)/);
    assert.match(text, /Froze 0xFFB45E \(M68K BUS\) = 285 \(0x11D\)/);
    assert.match(text, /Froze 0xFFB4CA \(M68K BUS\) = 10 \(0xA\)/);
    assert.match(text, /Unfroze 0xFFB54A \(M68K BUS\)/);
    assert.match(text, /4 op\(s\) applied in one frame\. 2 address\(es\) frozen\./);

    const call = h.bridge.calls.find((c) => c.method === "memory_ops");
    assert.equal(call.params.ops.length, 4);
    assert.equal(call.params.width, "u16_be");
    assert.equal(call.params.domain, "M68K BUS");
    assert.equal(call.params.ops[2].width, "u8");
    assert.equal(call.params.ops[3].op, "unfreeze");
  } finally {
    await h.close();
  }
});
