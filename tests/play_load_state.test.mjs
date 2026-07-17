import test from "node:test";
import assert from "node:assert/strict";
import { startHarness } from "./helpers/harness.mjs";

// Feature 2: play_input_sequence takes an optional load_state_path so the
// load+play trial loop collapses from two bridge round-trips to one.

test("bizhawk_play_input_sequence forwards load_state_path to the bridge", async () => {
  const h = await startHarness({
    play_input_sequence: () => ({ played: 5, final_framecount: 105, stopped_early: false }),
  });
  try {
    await h.client.callTool({
      name: "bizhawk_play_input_sequence",
      arguments: { target: h.target, load_state_path: "/mnt/states/home.State",
        frames: [{ buttons: { A: true }, hold: 1 }, { buttons: {}, hold: 4 }],
      },
    });
    const call = h.bridge.calls.find((c) => c.method === "play_input_sequence");
    assert.equal(call.params.load_state_path, "/mnt/states/home.State");
  } finally {
    await h.close();
  }
});

test("bizhawk_play_input_sequence omits load_state_path when not provided", async () => {
  const h = await startHarness({
    play_input_sequence: () => ({ played: 5, final_framecount: 105, stopped_early: false }),
  });
  try {
    await h.client.callTool({
      name: "bizhawk_play_input_sequence",
      arguments: { target: h.target, frames: [{ buttons: {}, hold: 5 }] },
    });
    const call = h.bridge.calls.find((c) => c.method === "play_input_sequence");
    assert.equal(call.params.load_state_path, undefined);
  } finally {
    await h.close();
  }
});
