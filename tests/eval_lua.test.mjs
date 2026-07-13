import test from "node:test";
import assert from "node:assert/strict";
import { startHarness, textOf } from "./helpers/harness.mjs";

test("bizhawk_eval_lua returns the JSON-encoded result", async () => {
  const h = await startHarness({ eval_lua: (p) => ({ echoed: p.code, n: 42 }) });
  try {
    const res = await h.client.callTool({
      name: "bizhawk_eval_lua",
      arguments: { code: "return {echoed='x', n=42}" },
    });
    const parsed = JSON.parse(textOf(res));
    assert.equal(parsed.n, 42);
  } finally {
    await h.close();
  }
});

test("bizhawk_eval_lua renders a nil result as (nil)", async () => {
  const h = await startHarness({ eval_lua: () => undefined });
  try {
    const res = await h.client.callTool({
      name: "bizhawk_eval_lua",
      arguments: { code: "local x = 1" },
    });
    assert.equal(textOf(res), "(nil)");
  } finally {
    await h.close();
  }
});

test("bizhawk_eval_lua surfaces Lua errors as MCP errors (callTool rejects)", async () => {
  // Low-level MCP Server: thrown handler exceptions become JSON-RPC errors,
  // so client.callTool() rejects rather than resolving with isError:true.
  const h = await startHarness({
    eval_lua: () => {
      throw new Error("Lua runtime error: attempt to index a nil value");
    },
  });
  try {
    await assert.rejects(
      h.client.callTool({ name: "bizhawk_eval_lua", arguments: { code: "return nil.x" } }),
      /Lua runtime error/,
    );
  } finally {
    await h.close();
  }
});
