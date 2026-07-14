import { Server } from "@modelcontextprotocol/sdk/server/index.js";
import { Client } from "@modelcontextprotocol/sdk/client/index.js";
import { InMemoryTransport } from "@modelcontextprotocol/sdk/inMemory.js";
import { BizhawkServer } from "../../dist/bizhawk.js";
import { registerTools } from "../../dist/tools.js";
import { FakeBridge } from "./fake-bridge.mjs";

/**
 * Boots the full stack for one test: BizhawkServer TCP listener on a random
 * port, a FakeBridge dialed into it, and an MCP client wired to the tool
 * layer over an in-memory transport.
 *
 * Use `await client.callTool({name, arguments})` to exercise a tool
 * end-to-end; inspect `bridge.calls` for what reached the (fake) Lua side.
 */
export async function startHarness(handlers = {}) {
  let bh = null;
  for (let attempt = 0; attempt < 5 && !bh; attempt++) {
    const port = 20000 + Math.floor(Math.random() * 20000);
    const candidate = new BizhawkServer({ host: "127.0.0.1", port, timeoutMs: 3000 });
    try {
      await candidate.start();
      bh = candidate;
      bh.testPort = port;
    } catch {
      /* port in use — retry */
    }
  }
  if (!bh) throw new Error("could not bind a test port after 5 attempts");

  const bridge = new FakeBridge(bh.testPort, handlers);
  await bridge.connect();

  const server = new Server(
    { name: "mcp-bizhawk-test", version: "0.0.0" },
    { capabilities: { tools: {} } },
  );
  registerTools(server, bh);

  const [clientTransport, serverTransport] = InMemoryTransport.createLinkedPair();
  const client = new Client({ name: "test-client", version: "0.0.0" }, { capabilities: {} });
  await Promise.all([server.connect(serverTransport), client.connect(clientTransport)]);

  // Wait until the server has seen at least one READY from the fake bridge.
  const deadline = Date.now() + 2000;
  while (!bh.isBridgeReady()) {
    if (Date.now() > deadline) throw new Error("fake bridge never became ready");
    await new Promise((r) => setTimeout(r, 5));
  }

  return {
    client,
    bridge,
    bh,
    close: async () => {
      bridge.close();
      await client.close();
      bh.stop();
    },
  };
}

/** Concatenate all text content blocks of a tool result. */
export function textOf(result) {
  return result.content
    .filter((c) => c.type === "text")
    .map((c) => c.text)
    .join("\n");
}
