import test from "node:test";
import assert from "node:assert/strict";
import { startHarness, textOf } from "./helpers/harness.mjs";

test("bizhawk_observe_frames forwards passive observation to the bridge", async () => {
  let seen;
  const h = await startHarness({
    observe_frames: (p) => {
      seen = p;
      return {
        played: 12,
        final_framecount: 112,
        observations: [
          { frame_offset: 6, memory: { clock: 300 } },
          { frame_offset: 12, memory: { clock: 299 } },
        ],
        state: { framecount: 112, paused: true, lag_count: 5, current_memory_domain: "M68K BUS" },
      };
    },
  });
  try {
    const res = await h.client.callTool({
      name: "bizhawk_observe_frames",
      arguments: {
        target: h.target,
        frames: 12,
        observe_every: 6,
        observe_memory: [{ name: "clock", address: 0xffc468, width: "u16_be", domain: "M68K BUS" }],
        turbo: true,
      },
    });
    const text = textOf(res);
    assert.match(text, /Observed 12 frames\. Final framecount: 112\./);
    assert.match(text, /Captured 2 observations\./);
    assert.match(text, /obs\[0\] frame_offset=6 memory=\{clock=300\}/);
    assert.equal(seen.count, 12);
    assert.equal(seen.observe_every, 6);
    assert.equal(seen.turbo, true);
    assert.deepEqual(seen.observe_memory[0], { name: "clock", address: 0xffc468, width: "u16_be", domain: "M68K BUS" });
  } finally {
    await h.close();
  }
});
