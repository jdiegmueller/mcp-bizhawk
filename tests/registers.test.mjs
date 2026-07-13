import test from "node:test";
import assert from "node:assert/strict";
import { startHarness, textOf } from "./helpers/harness.mjs";

test("bizhawk_get_registers formats sorted name = dec (hex) lines", async () => {
  const h = await startHarness({
    get_registers: () => ({ PC: 0x1234, D0: 255, A7: 0xfffe00 }),
  });
  try {
    const res = await h.client.callTool({ name: "bizhawk_get_registers", arguments: {} });
    const lines = textOf(res).split("\n");
    assert.equal(lines[0], "A7 = 16776704 (0xFFFE00)");
    assert.equal(lines[1], "D0 = 255 (0xFF)");
    assert.equal(lines[2], "PC = 4660 (0x1234)");
  } finally {
    await h.close();
  }
});

test("bizhawk_set_register passes name and value through", async () => {
  const h = await startHarness({ set_register: () => true });
  try {
    const res = await h.client.callTool({
      name: "bizhawk_set_register",
      arguments: { name: "D0", value: 42 },
    });
    assert.match(textOf(res), /Set register D0 = 42/);
    const call = h.bridge.calls.find((c) => c.method === "set_register");
    assert.equal(call.params.name, "D0");
    assert.equal(call.params.value, 42);
  } finally {
    await h.close();
  }
});
