import test from "node:test";
import assert from "node:assert/strict";
import { startHarness, textOf } from "./helpers/harness.mjs";

test("bizhawk_freeze passes spec through and reports the count", async () => {
  const h = await startHarness({ freeze: () => ({ frozen_count: 1 }) });
  try {
    const res = await h.client.callTool({
      name: "bizhawk_freeze",
      arguments: { address: 0xc468, value: 0x1234, width: "u16_be", domain: "68K RAM" },
    });
    assert.match(textOf(res), /Froze 0xC468 \(68K RAM\) = 4660 \(0x1234\)\. 1 address\(es\) frozen\./);
    const call = h.bridge.calls.find((c) => c.method === "freeze");
    assert.equal(call.params.width, "u16_be");
    assert.equal(call.params.value, 0x1234);
  } finally {
    await h.close();
  }
});

test("bizhawk_freeze batch entries pass through with shared defaults", async () => {
  const h = await startHarness({ freeze: () => ({ frozen_count: 3 }) });
  try {
    const res = await h.client.callTool({
      name: "bizhawk_freeze",
      arguments: {
        width: "u16_be",
        domain: "M68K BUS",
        entries: [
          { address: 0xffb44a, value: 0xff92 },
          { address: 0xffb45e, value: 0x11d },
          { address: 0xffb4ca, value: 10, width: "u8" },
        ],
      },
    });
    const text = textOf(res);
    assert.match(text, /Froze 0xFFB44A \(M68K BUS\) = 65426 \(0xFF92\)/);
    assert.match(text, /Froze 0xFFB45E \(M68K BUS\) = 285 \(0x11D\)/);
    assert.match(text, /Froze 0xFFB4CA \(M68K BUS\) = 10 \(0xA\)/);
    assert.match(text, /3 address\(es\) frozen\./);
    const call = h.bridge.calls.find((c) => c.method === "freeze");
    assert.equal(call.params.entries.length, 3);
    assert.equal(call.params.width, "u16_be");
    assert.equal(call.params.domain, "M68K BUS");
    assert.equal(call.params.entries[2].width, "u8");
  } finally {
    await h.close();
  }
});

test("bizhawk_freeze rejects a call with neither address/value nor entries", async () => {
  const h = await startHarness({ freeze: () => ({ frozen_count: 0 }) });
  try {
    // Handler errors travel back as JSON-RPC errors, so callTool rejects.
    await assert.rejects(
      h.client.callTool({ name: "bizhawk_freeze", arguments: {} }),
      /address\+value required \(or pass entries/,
    );
    assert.equal(h.bridge.calls.find((c) => c.method === "freeze"), undefined);
  } finally {
    await h.close();
  }
});

test("bizhawk_unfreeze batch addresses pass through", async () => {
  const h = await startHarness({ unfreeze: () => ({ frozen_count: 4 }) });
  try {
    const res = await h.client.callTool({
      name: "bizhawk_unfreeze",
      arguments: { addresses: [0xffb44a, 0xffb45e], domain: "M68K BUS" },
    });
    assert.match(textOf(res), /4 address\(es\) frozen/);
    const call = h.bridge.calls.find((c) => c.method === "unfreeze");
    assert.deepEqual(call.params.addresses, [0xffb44a, 0xffb45e]);
    assert.equal(call.params.domain, "M68K BUS");
  } finally {
    await h.close();
  }
});

test("bizhawk_unfreeze all=true", async () => {
  const h = await startHarness({ unfreeze: () => ({ frozen_count: 0 }) });
  try {
    const res = await h.client.callTool({ name: "bizhawk_unfreeze", arguments: { all: true } });
    assert.match(textOf(res), /0 address\(es\) frozen/);
    const call = h.bridge.calls.find((c) => c.method === "unfreeze");
    assert.equal(call.params.all, true);
  } finally {
    await h.close();
  }
});

test("bizhawk_list_frozen formats entries and handles the empty case", async () => {
  const h = await startHarness({
    list_frozen: () => ({
      count: 2,
      frozen: [
        { address: 0x10, width: "u8", value: 99 },
        { address: 0x20, width: "u16_be", value: 500, domain: "68K RAM" },
      ],
    }),
  });
  try {
    const res = await h.client.callTool({ name: "bizhawk_list_frozen", arguments: {} });
    const text = textOf(res);
    assert.match(text, /0x0010 u8 = 99/);
    assert.match(text, /0x0020 u16_be = 500 \(68K RAM\)/);
  } finally {
    await h.close();
  }

  // Lua sends {} (empty object) when nothing is frozen — must not crash.
  const h2 = await startHarness({ list_frozen: () => ({ count: 0, frozen: {} }) });
  try {
    const res = await h2.client.callTool({ name: "bizhawk_list_frozen", arguments: {} });
    assert.match(textOf(res), /no frozen addresses/i);
  } finally {
    await h2.close();
  }
});
