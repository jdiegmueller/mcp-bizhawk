import test from "node:test";
import assert from "node:assert/strict";
import { startHarness } from "./helpers/harness.mjs";

const PATH_ERROR = /filesystem paths are not accepted by MCP clients/;

test("state tools reject fully qualified path arguments", async () => {
  const h = await startHarness({});
  try {
    await assert.rejects(
      h.client.callTool({ name: "bizhawk_save_state", arguments: { target: h.target, path: "/mnt/8tb/jason/a.State" } }),
      PATH_ERROR,
    );
    await assert.rejects(
      h.client.callTool({ name: "bizhawk_load_state", arguments: { target: h.target, path: "X:\\a.State" } }),
      PATH_ERROR,
    );
  } finally {
    await h.close();
  }
});

test("sequence and trials reject raw state path arguments", async () => {
  const h = await startHarness({});
  try {
    await assert.rejects(
      h.client.callTool({
        name: "bizhawk_play_input_sequence",
        arguments: { target: h.target, load_state_path: "/mnt/8tb/jason/a.State", frames: [{ buttons: {}, hold: 1 }] },
      }),
      PATH_ERROR,
    );
    await assert.rejects(
      h.client.callTool({
        name: "bizhawk_run_trials",
        arguments: { target: h.target, state_path: "X:\\a.State", trials: [{ frames: [{ buttons: {}, hold: 1 }] }] },
      }),
      PATH_ERROR,
    );
  } finally {
    await h.close();
  }
});

test("screenshot and trace tools reject caller-supplied paths", async () => {
  const h = await startHarness({});
  try {
    await assert.rejects(
      h.client.callTool({ name: "bizhawk_screenshot", arguments: { target: h.target, path: "/mnt/8tb/jason/shot.png", describe: false } }),
      PATH_ERROR,
    );
    await assert.rejects(
      h.client.callTool({ name: "bizhawk_trace_start", arguments: { target: h.target, path: "/mnt/8tb/jason/t.csv" } }),
      PATH_ERROR,
    );
    await assert.rejects(
      h.client.callTool({ name: "bizhawk_phys_trace_start", arguments: { target: h.target, path: "X:\\t.csv" } }),
      PATH_ERROR,
    );
  } finally {
    await h.close();
  }
});
