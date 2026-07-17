import { Server } from "@modelcontextprotocol/sdk/server/index.js";
import { Client } from "@modelcontextprotocol/sdk/client/index.js";
import { InMemoryTransport } from "@modelcontextprotocol/sdk/inMemory.js";
import { BizhawkServer } from "../../dist/bizhawk.js";
import { registerTools } from "../../dist/tools.js";
import { FakeBridge } from "./fake-bridge.mjs";

export async function startHarness(handlers = {}) {
  let bh = null;
  let port;
  for (let attempt = 0; attempt < 5 && !bh; attempt++) {
    port = 20000 + Math.floor(Math.random() * 20000);
    const candidate = new BizhawkServer();
    try {
      await candidate.start({ test: { bizhawkPort: port } });
      bh = candidate;
      bh.testPort = port;
      bh.testTarget = "test";
    } catch {
      /* port in use — retry */
    }
  }
  if (!bh) throw new Error("could not bind a test port after 5 attempts");

  const bridge = new FakeBridge(port, handlers);
  await bridge.connect();

  const server = new Server(
    { name: "mcp-bizhawk-test", version: "0.0.0" },
    { capabilities: { tools: {} } },
  );
  registerTools(server, bh);

  const [clientTransport, serverTransport] = InMemoryTransport.createLinkedPair();
  const client = new Client({ name: "test-client", version: "0.0.0" }, { capabilities: {} });
  await Promise.all([server.connect(serverTransport), client.connect(clientTransport)]);

  // Wait until the backend is ready.
  const deadline = Date.now() + 2000;
  while (bh.listBackends().find((x) => x.name === "test")?.state !== "ready") {
    if (Date.now() > deadline) throw new Error("fake bridge never became ready");
    await new Promise((r) => setTimeout(r, 5));
  }

  return {
    client,
    bridge,
    bh,
    target: "test",
    close: async () => {
      bridge.close();
      await client.close();
      await bh.stop();
    },
  };
}

export function textOf(result) {
  return result.content
    .filter((c) => c.type === "text")
    .map((c) => c.text)
    .join("\n");
}
