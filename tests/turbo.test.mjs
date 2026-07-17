import test from "node:test";
import assert from "node:assert/strict";
import { startHarness, textOf } from "./helpers/harness.mjs";

test("bizhawk_frame_advance passes turbo through to the bridge", async () => {
  const h = await startHarness({ frame_advance: () => 1234 });
  try {
    const res = await h.client.callTool({
      name: "bizhawk_frame_advance",
      arguments: { target: h.target, count: 5, turbo: true },
    });
    assert.match(textOf(res), /Advanced 5 frame\(s\)\. Framecount: 1234/);
    const call = h.bridge.calls.find((c) => c.method === "frame_advance");
    assert.equal(call.params.turbo, true);
    assert.equal(call.params.count, 5);
  } finally {
    await h.close();
  }
});

test("bizhawk_wait_for_memory passes turbo through to the bridge", async () => {
  const h = await startHarness({
    wait_for_memory: () => ({ matched: true, frames_waited: 3, value: 7, final_framecount: 100 }),
  });
  try {
    await h.client.callTool({
      name: "bizhawk_wait_for_memory",
      arguments: { target: h.target, address: 0x10, condition: "eq", value: 7, turbo: true },
    });
    const call = h.bridge.calls.find((c) => c.method === "wait_for_memory");
    assert.equal(call.params.turbo, true);
  } finally {
    await h.close();
  }
});

test("bizhawk_play_input_sequence passes turbo through to the bridge", async () => {
  const h = await startHarness({
    play_input_sequence: () => ({ played: 10, final_framecount: 110, stopped_early: false }),
  });
  try {
    await h.client.callTool({
      name: "bizhawk_play_input_sequence",
      arguments: { target: h.target, frames: [{ buttons: { Right: true }, hold: 10 }], turbo: true },
    });
    const call = h.bridge.calls.find((c) => c.method === "play_input_sequence");
    assert.equal(call.params.turbo, true);
  } finally {
    await h.close();
  }
});
