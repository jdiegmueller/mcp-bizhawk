import test from "node:test";
import assert from "node:assert/strict";
import { startHarness } from "./helpers/harness.mjs";

const EXPECTED_BIZHAWK = [
  "bizhawk_ping", "bizhawk_get_info", "bizhawk_pause", "bizhawk_unpause",
  "bizhawk_frame_advance", "bizhawk_reset", "bizhawk_press_buttons",
  "bizhawk_play_input_sequence", "bizhawk_screenshot", "bizhawk_save_state",
  "bizhawk_load_state", "bizhawk_read_many", "bizhawk_ram_snapshot", "bizhawk_disassemble",
  "bizhawk_trap_exec", "bizhawk_eval_lua",
  "bizhawk_trace_start", "bizhawk_trace_stop", "bizhawk_trace_status", "bizhawk_trace_tail",
  "bizhawk_phys_trace_start", "bizhawk_phys_trace_stop",
  "bizhawk_phys_trace_status", "bizhawk_phys_trace_tail",
];
const EXPECTED_NHL94 = [
  "nhl94_recipes", "nhl94_teleport", "nhl94_freeze", "nhl94_unfreeze",
  "nhl94_state", "nhl94_read", "nhl94_park", "nhl94_rig", "nhl94_possession",
  "nhl94_clock", "nhl94_camera",
];
const HIDDEN_SAMPLE = [
  "bizhawk_read8", "bizhawk_write16", "bizhawk_memory_ops", "bizhawk_freeze",
  "bizhawk_unfreeze", "bizhawk_list_frozen", "bizhawk_read_struct_array",
  "bizhawk_search_begin", "bizhawk_get_registers", "bizhawk_run_trials",
  "bizhawk_save_slot", "bizhawk_list_memory_domains",
];

test("default surface: the nhl94_* set + the curated bizhawk_* core, nothing else", async () => {
  const h = await startHarness({});
  try {
    const names = (await h.client.listTools()).tools.map((t) => t.name);
    const nhl = names.filter((n) => n.startsWith("nhl94_"));
    const biz = names.filter((n) => n.startsWith("bizhawk_"));
    assert.deepEqual(nhl.sort(), [...EXPECTED_NHL94].sort(), "exactly the nhl94_* set");
    assert.deepEqual(biz.sort(), [...EXPECTED_BIZHAWK].sort(), "exactly the core bizhawk_*");
    for (const hidden of HIDDEN_SAMPLE) {
      assert.ok(!names.includes(hidden), `${hidden} should be hidden`);
    }
  } finally {
    await h.close();
  }
});

test("BIZHAWK_ALL_TOOLS=1 re-exposes the full surface", async () => {
  process.env.BIZHAWK_ALL_TOOLS = "1";
  const h = await startHarness({});
  try {
    const names = (await h.client.listTools()).tools.map((t) => t.name);
    for (const hidden of HIDDEN_SAMPLE) {
      assert.ok(names.includes(hidden), `${hidden} should be exposed under override`);
    }
    assert.ok(names.length > 60, "full surface exposed");
  } finally {
    await h.close();
    delete process.env.BIZHAWK_ALL_TOOLS;
  }
});

test("a hidden tool still dispatches when invoked directly (override-safe)", async () => {
  const h = await startHarness({ list_frozen: () => ({ count: 0, frozen: [] }) });
  try {
    const res = await h.client.callTool({ name: "bizhawk_list_frozen", arguments: {} });
    const text = res.content.filter((c) => c.type === "text").map((c) => c.text).join("");
    assert.match(text, /no frozen addresses/);
  } finally {
    await h.close();
  }
});
