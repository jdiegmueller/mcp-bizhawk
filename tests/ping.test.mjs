import test from "node:test";
import assert from "node:assert/strict";
import { startHarness, textOf } from "./helpers/harness.mjs";

test("bizhawk_ping reports pong + server version when the bridge polls", async () => {
  const h = await startHarness({ ping: () => "pong" });
  try {
    const res = await h.client.callTool({ name: "bizhawk_ping", arguments: { target: h.target } });
    assert.match(textOf(res), /^pong \(mcp-bizhawk v.+, backend "test" polling\)$/);
  } finally {
    await h.close();
  }
});

test("bizhawk_read8 formats a read through the bridge", async () => {
  const h = await startHarness({ read8: (p) => (p.address === 0x09c6 ? 99 : 0) });
  try {
    const res = await h.client.callTool({
      name: "bizhawk_read8",
      arguments: { target: h.target, address: 0x09c6 },
    });
    assert.equal(textOf(res), "0x09C6: 99 (0x63)");
  } finally {
    await h.close();
  }
});

test("bridge RPC errors surface as MCP errors (callTool rejects)", async () => {
  // NOTE: this repo uses the low-level MCP Server, which turns a thrown
  // handler exception into a JSON-RPC error — client.callTool() REJECTS,
  // it does not resolve with isError:true.
  const h = await startHarness({
    read8: () => {
      throw new Error("unknown memory domain: BOGUS");
    },
  });
  try {
    await assert.rejects(
      h.client.callTool({ name: "bizhawk_read8", arguments: { target: h.target, address: 0, domain: "BOGUS" } }),
      /unknown memory domain: BOGUS/,
    );
  } finally {
    await h.close();
  }
});
