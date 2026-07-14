import test from "node:test";
import assert from "node:assert/strict";
import { startHarness, textOf } from "./helpers/harness.mjs";

// observe_every decouples the memory-observation cadence from screenshots, so
// a dense per-frame RAM trace comes back with ZERO inlined images.

test("bizhawk_play_input_sequence forwards observe_every to the bridge", async () => {
  const h = await startHarness({
    play_input_sequence: () => ({ played: 5, final_framecount: 105, stopped_early: false }),
  });
  try {
    await h.client.callTool({
      name: "bizhawk_play_input_sequence",
      arguments: {
        observe_every: 1,
        observe_memory: [{ name: "x", address: 0x10, width: "u8" }],
        frames: [{ buttons: {}, hold: 5 }],
      },
    });
    const call = h.bridge.calls.find((c) => c.method === "play_input_sequence");
    assert.equal(call.params.observe_every, 1);
  } finally {
    await h.close();
  }
});

test("bizhawk_play_input_sequence returns memory observations with no image blocks when only observe_every is set", async () => {
  const h = await startHarness({
    play_input_sequence: () => ({
      played: 3,
      final_framecount: 103,
      stopped_early: false,
      observations: [
        { frame_offset: 1, memory: { x: 10 } },
        { frame_offset: 2, memory: { x: 20 } },
        { frame_offset: 3, memory: { x: 30 } },
      ],
    }),
  });
  try {
    const res = await h.client.callTool({
      name: "bizhawk_play_input_sequence",
      arguments: {
        observe_every: 1,
        observe_memory: [{ name: "x", address: 0x10, width: "u8" }],
        frames: [{ buttons: {}, hold: 3 }],
      },
    });
    const images = res.content.filter((c) => c.type === "image");
    assert.equal(images.length, 0, "no images when only observe_every is used");
    const t = textOf(res);
    assert.match(t, /Captured 3 observations/);
    assert.match(t, /x=10/);
    assert.match(t, /x=30/);
  } finally {
    await h.close();
  }
});
