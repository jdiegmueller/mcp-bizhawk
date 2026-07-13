import test from "node:test";
import assert from "node:assert/strict";
import { startHarness, textOf } from "./helpers/harness.mjs";

test("search begin → filter → results round-trip", async () => {
  const h = await startHarness({
    search_begin: (p) => ({
      start: p.start ?? 0, length: 65536, width: p.width ?? "u8", potential_candidates: 65536,
    }),
    search_filter: (p) => ({
      count: 2,
      sample: [{ address: 0x09c6, value: 98 }, { address: 0x1200, value: 98 }],
    }),
    search_results: () => ({
      count: 2,
      results: [{ address: 0x09c6, value: 98 }, { address: 0x1200, value: 98 }],
    }),
    search_end: () => true,
  });
  try {
    let res = await h.client.callTool({
      name: "bizhawk_search_begin",
      arguments: { domain: "WRAM", width: "u16" },
    });
    assert.match(textOf(res), /Search started.*65536 bytes.*u16/s);

    res = await h.client.callTool({
      name: "bizhawk_search_filter",
      arguments: { condition: "eq", value: 98 },
    });
    const text = textOf(res);
    assert.match(text, /2 candidate\(s\) remain/);
    assert.match(text, /0x09C6 = 98/);
    const call = h.bridge.calls.find((c) => c.method === "search_filter");
    assert.equal(call.params.condition, "eq");
    assert.equal(call.params.value, 98);

    res = await h.client.callTool({ name: "bizhawk_search_results", arguments: { limit: 10 } });
    assert.match(textOf(res), /0x1200 = 98/);

    res = await h.client.callTool({ name: "bizhawk_search_end", arguments: {} });
    assert.match(textOf(res), /Search ended/);
  } finally {
    await h.close();
  }
});

test("search_filter with zero candidates omits the sample cleanly", async () => {
  const h = await startHarness({ search_filter: () => ({ count: 0 }) });
  try {
    const res = await h.client.callTool({
      name: "bizhawk_search_filter",
      arguments: { condition: "decreased" },
    });
    assert.match(textOf(res), /0 candidate\(s\) remain/);
  } finally {
    await h.close();
  }
});
