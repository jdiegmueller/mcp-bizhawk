import test from "node:test";
import assert from "node:assert/strict";
import { startHarness, textOf } from "./helpers/harness.mjs";

test("bizhawk_read_struct_array formats one line per record, fields in request order", async () => {
  const h = await startHarness({
    read_struct_array: (p) =>
      Array.from({ length: p.count }, (_, i) => ({ _index: i, x: 10 + i, y: 20 + i })),
  });
  try {
    const res = await h.client.callTool({
      name: "bizhawk_read_struct_array",
      arguments: {
        base: 0xb04a,
        stride: 0x80,
        count: 2,
        fields: [
          { name: "x", offset: 0x00, width: "s16_be" },
          { name: "y", offset: 0x14, width: "s16_be" },
        ],
      },
    });
    const text = textOf(res);
    assert.match(text, /2 records @ base 0xB04A stride 128/);
    assert.match(text, /\[0\] x=10 y=20/);
    assert.match(text, /\[1\] x=11 y=21/);
    const call = h.bridge.calls.find((c) => c.method === "read_struct_array");
    assert.equal(call.params.stride, 0x80);
    assert.equal(call.params.fields[1].offset, 0x14);
  } finally {
    await h.close();
  }
});
