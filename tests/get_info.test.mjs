import test from "node:test";
import assert from "node:assert/strict";
import { startHarness, textOf } from "./helpers/harness.mjs";

test("bizhawk_get_info surfaces system_id, paused, lag, and movie fields", async () => {
  const h = await startHarness({
    get_info: () => ({
      bridge: { name: "bridge_JD", version: "0.9.0", pause_safe: true },
      rom_name: "NHL 94", rom_hash: "ABC", framecount: 12345,
      system_id: "GEN", lag_count: 7, is_lagged: true, paused: true,
      movie_loaded: false, movie_mode: "INACTIVE",
      memory_domains: ["68K RAM"], current_memory_domain: "68K RAM",
      capabilities: { framecount: true },
    }),
  });
  try {
    const res = await h.client.callTool({ name: "bizhawk_get_info", arguments: {} });
    const t = textOf(res);
    assert.match(t, /System:\s+GEN/);
    assert.match(t, /Paused:\s+yes/);
    assert.match(t, /Lag frames:\s+7 \(current frame IS a lag frame\)/);
    assert.match(t, /Movie:\s+not loaded \(INACTIVE\)/);
  } finally {
    await h.close();
  }
});

test("bizhawk_get_info preserves real `false` booleans instead of collapsing to nil", async () => {
  const h = await startHarness({
    get_info: () => ({
      bridge: { name: "bridge_JD", version: "0.9.0", pause_safe: true },
      rom_name: "NHL 94", rom_hash: "ABC", framecount: 12345,
      system_id: "GEN", lag_count: 0, is_lagged: false, paused: false,
      movie_loaded: false, movie_mode: "INACTIVE",
      memory_domains: ["68K RAM"], current_memory_domain: "68K RAM",
      capabilities: { framecount: true },
    }),
  });
  try {
    const res = await h.client.callTool({ name: "bizhawk_get_info", arguments: {} });
    const t = textOf(res);
    assert.match(t, /Paused:\s+no/);
    assert.doesNotMatch(t, /current frame IS a lag frame/);
    assert.match(t, /Movie:\s+not loaded \(INACTIVE\)/);
  } finally {
    await h.close();
  }
});
