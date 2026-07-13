import test from "node:test";
import assert from "node:assert/strict";
import { startHarness, textOf } from "./helpers/harness.mjs";

test("bizhawk_record_input returns RLE frames as play_input_sequence-ready JSON", async () => {
  const h = await startHarness({
    record_input: () => ({
      recorded: 90,
      stopped_early: false,
      frames: [
        { buttons: {}, hold: 30 },
        { buttons: { Right: true }, hold: 55 },
        { buttons: { Right: true, A: true }, hold: 5 },
      ],
    }),
  });
  try {
    const res = await h.client.callTool({
      name: "bizhawk_record_input",
      arguments: { max_frames: 90 },
    });
    const text = textOf(res);
    assert.match(text, /Recorded 90 frame\(s\) in 3 entr(y|ies)/);
    const json = JSON.parse(text.slice(text.indexOf("[")));
    assert.equal(json.length, 3);
    assert.equal(json[1].hold, 55);
    assert.equal(json[1].buttons.Right, true);
  } finally {
    await h.close();
  }
});

test("bizhawk_record_input handles the no-input empty-frames case", async () => {
  // Lua omits `frames` when nothing was recorded (empty-table pitfall).
  const h = await startHarness({
    record_input: () => ({ recorded: 0, stopped_early: true }),
  });
  try {
    const res = await h.client.callTool({
      name: "bizhawk_record_input",
      arguments: { max_frames: 10, stop_on_memory_change: { address: 0x10, width: "u8" } },
    });
    assert.match(textOf(res), /Recorded 0 frame\(s\)/);
    assert.match(textOf(res), /stopped early/);
  } finally {
    await h.close();
  }
});
