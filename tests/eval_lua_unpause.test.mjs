import test from "node:test";
import assert from "node:assert/strict";
import { startHarness } from "./helpers/harness.mjs";

test("bizhawk_eval_lua forwards unpause:true to the bridge", async () => {
  const h = await startHarness({ eval_lua: () => 42 });
  try {
    await h.client.callTool({
      name: "bizhawk_eval_lua",
      arguments: { code: "return 42", unpause: true },
    });
    const call = h.bridge.calls.find((c) => c.method === "eval_lua");
    assert.equal(call.params.unpause, true);
    assert.equal(call.params.code, "return 42");
  } finally {
    await h.close();
  }
});

test("bizhawk_eval_lua omits unpause when not requested", async () => {
  const h = await startHarness({ eval_lua: () => 1 });
  try {
    await h.client.callTool({ name: "bizhawk_eval_lua", arguments: { code: "return 1" } });
    const call = h.bridge.calls.find((c) => c.method === "eval_lua");
    assert.equal(call.params.unpause, undefined);
  } finally {
    await h.close();
  }
});
