import test from "node:test";
import assert from "node:assert/strict";
import { Client } from "@modelcontextprotocol/sdk/client/index.js";
import { StreamableHTTPClientTransport } from "@modelcontextprotocol/sdk/client/streamableHttp.js";
import { BizhawkServer } from "../dist/bizhawk.js";
import { createMcpHttpServer, MCP_PATH } from "../dist/http.js";
import { FakeBridge } from "./helpers/fake-bridge.mjs";

/**
 * Boots the real HTTP front end (src/http.ts) over a shared BizhawkServer +
 * FakeBridge, listening on a random port. Returns the base URL and a teardown.
 * This exercises the streamable-HTTP transport end-to-end — the actual daemon
 * path — not the in-memory transport used by the tool-layer tests.
 */
async function startHttpDaemon(handlers = {}) {
  let bh = null;
  let port;
  for (let attempt = 0; attempt < 5 && !bh; attempt++) {
    port = 20000 + Math.floor(Math.random() * 20000);
    const candidate = new BizhawkServer();
    try {
      await candidate.start({ test: { bizhawkPort: port } });
      bh = candidate;
    } catch {
      /* port in use — retry */
    }
  }
  if (!bh) throw new Error("could not bind a BizHawk test port after 5 attempts");

  const bridge = new FakeBridge(port, handlers);
  await bridge.connect();

  const httpServer = createMcpHttpServer(bh);
  await new Promise((resolve) => httpServer.listen(0, "127.0.0.1", resolve));
  const httpPort = httpServer.address().port;
  const url = new URL(`http://127.0.0.1:${httpPort}${MCP_PATH}`);

  // Wait until the backend is ready.
  const deadline = Date.now() + 2000;
  while (bh.listBackends().find((x) => x.name === "test")?.state !== "ready") {
    if (Date.now() > deadline) throw new Error("fake bridge never became ready");
    await new Promise((r) => setTimeout(r, 5));
  }

  return {
    url,
    close: async () => {
      bridge.close();
      await new Promise((resolve) => httpServer.close(resolve));
      await bh.stop();
    },
  };
}

function connectClient(url, name) {
  const client = new Client({ name, version: "0.0.0" }, { capabilities: {} });
  const transport = new StreamableHTTPClientTransport(url);
  return client.connect(transport).then(() => client);
}

test("HTTP daemon: a single client can list tools and call a tool", async () => {
  const d = await startHttpDaemon({ read8: (p) => (p.address === 0x10 ? 42 : 0) });
  try {
    const client = await connectClient(d.url, "solo");
    const tools = await client.listTools();
    assert.ok(tools.tools.some((t) => t.name === "bizhawk_ping"), "bizhawk_ping is advertised");

    const res = await client.callTool({ name: "bizhawk_read8", arguments: { target: "test", address: 0x10 } });
    assert.equal(res.content[0].text, "0x0010: 42 (0x2A)");
    await client.close();
  } finally {
    await d.close();
  }
});

test("HTTP daemon: concurrent clients get correctly-correlated results (no cross-talk)", async () => {
  // Distinct handlers per address so a mis-routed response would produce the
  // wrong number. Both clients hammer the shared BizhawkServer at once; the
  // single serial FIFO must still return each caller its own result.
  const d = await startHttpDaemon({
    read8: (p) => {
      if (p.address === 0xa0) return 0xaa;
      if (p.address === 0xb0) return 0xbb;
      return 0;
    },
  });
  try {
    const [a, b] = await Promise.all([
      connectClient(d.url, "clientA"),
      connectClient(d.url, "clientB"),
    ]);

    // Interleave many calls from both clients concurrently.
    const calls = [];
    for (let i = 0; i < 8; i++) {
      calls.push(a.callTool({ name: "bizhawk_read8", arguments: { target: "test", address: 0xa0 } }));
      calls.push(b.callTool({ name: "bizhawk_read8", arguments: { target: "test", address: 0xb0 } }));
    }
    const results = await Promise.all(calls);

    results.forEach((res, i) => {
      const expected = i % 2 === 0 ? "0x00A0: 170 (0xAA)" : "0x00B0: 187 (0xBB)";
      assert.equal(res.content[0].text, expected, `call ${i} routed to the right client`);
    });

    await Promise.all([a.close(), b.close()]);
  } finally {
    await d.close();
  }
});
