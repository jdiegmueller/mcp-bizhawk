import test from "node:test";
import assert from "node:assert/strict";
import { startHarness, textOf } from "./helpers/harness.mjs";

test("bizhawk_osd_message passes the message through and confirms", async () => {
  const h = await startHarness({ osd_message: ({ message }) => ({ message }) });
  try {
    const res = await h.client.callTool({
      name: "bizhawk_osd_message",
      arguments: { message: "hunting puck addr" },
    });
    assert.match(textOf(res), /OSD message shown: hunting puck addr/);
    assert.equal(
      h.bridge.calls.find((c) => c.method === "osd_message").params.message,
      "hunting puck addr",
    );
  } finally {
    await h.close();
  }
});
