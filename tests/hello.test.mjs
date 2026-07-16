import test from "node:test";
import assert from "node:assert/strict";
import { startHarness } from "./helpers/harness.mjs";
import { VERSION, PROTOCOL_VERSION } from "../dist/version.js";

test("server greets the bridge with HELLO carrying its version, once per connection", async () => {
  const h = await startHarness({ ping: () => ({ pong: true }) });
  try {
    // HELLO is the reply to the bridge's first READY; give it a few polls.
    const deadline = Date.now() + 2000;
    while (!h.bridge.hello) {
      if (Date.now() > deadline) throw new Error("bridge never received HELLO");
      await new Promise((r) => setTimeout(r, 5));
    }
    assert.deepEqual(h.bridge.hello, { server_version: VERSION, protocol_version: PROTOCOL_VERSION });
    assert.equal(typeof PROTOCOL_VERSION, "number");
    assert.equal(h.bridge.helloCount, 1);

    // Normal RPC still works after the greeting.
    await h.client.callTool({ name: "bizhawk_ping", arguments: {} });

    // Every command frame carries the server version/protocol (sv/sp) so the
    // bridge OSD self-heals after a script reload that missed the HELLO.
    const pingCall = h.bridge.calls.find((c) => c.method === "ping");
    assert.equal(pingCall.sv, VERSION);
    assert.equal(pingCall.sp, PROTOCOL_VERSION);

    // Wait a few more polls: HELLO must NOT repeat on the same connection.
    await new Promise((r) => setTimeout(r, 30));
    assert.equal(h.bridge.helloCount, 1);
  } finally {
    await h.close();
  }
});
