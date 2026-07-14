import test from "node:test";
import assert from "node:assert/strict";
import { startHarness } from "./helpers/harness.mjs";

// Graceful shutdown must send a framed BYE sentinel to the connected bridge
// BEFORE closing the socket. The bridge uses it to redial the (restarting)
// server instead of wedging on the next blocking socketServerResponse() —
// which is what freezes the whole emulator on a server restart otherwise.
test("server sends BYE to the bridge on graceful stop()", async () => {
  const h = await startHarness({ ping: () => ({ pong: true }) });
  try {
    // Ensure the connection is fully established (HELLO exchanged).
    const dl = Date.now() + 2000;
    while (!h.bridge.hello) {
      if (Date.now() > dl) throw new Error("bridge never received HELLO");
      await new Promise((r) => setTimeout(r, 5));
    }
    assert.equal(h.bridge.bye, false, "no BYE before stop");

    h.bh.stop();

    const dl2 = Date.now() + 1000;
    while (!h.bridge.bye) {
      if (Date.now() > dl2) throw new Error("bridge never received BYE on stop");
      await new Promise((r) => setTimeout(r, 5));
    }
    assert.equal(h.bridge.bye, true);
  } finally {
    await h.close();
  }
});
