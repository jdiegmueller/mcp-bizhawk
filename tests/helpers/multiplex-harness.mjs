import { Server } from "@modelcontextprotocol/sdk/server/index.js";
import { Client } from "@modelcontextprotocol/sdk/client/index.js";
import { InMemoryTransport } from "@modelcontextprotocol/sdk/inMemory.js";
import { BizhawkServer } from "../../dist/bizhawk.js";
import { registerTools } from "../../dist/tools.js";
import { FakeBridge } from "./fake-bridge.mjs";

/**
 * Boots a multiplexer with N backends, each dialled by a FakeBridge.
 */
export async function startMultiplexHarness(backendConfigs, handlersPerBackend = {}) {
  const bh = new BizhawkServer();
  const cfg = {};
  const ports = [];
  for (const name of Object.keys(backendConfigs)) {
    let port;
    for (let attempt = 0; attempt < 10; attempt++) {
      port = 20000 + Math.floor(Math.random() * 20000);
      if (!ports.includes(port)) break;
    }
    ports.push(port);
    cfg[name] = { bizhawkPort: port, ...backendConfigs[name] };
  }
  await bh.start(cfg);

  const bridges = {};
  for (const name of Object.keys(cfg)) {
    const handlers = (handlersPerBackend[name] || {});
    const bridge = new FakeBridge(cfg[name].bizhawkPort, handlers);
    await bridge.connect();
    bridges[name] = bridge;
  }

  // Wait for all backends to be ready
  const deadline = Date.now() + 5000;
  for (const name of Object.keys(cfg)) {
    while (true) {
      const statuses = bh.listBackends();
      const s = statuses.find((x) => x.name === name);
      if (s && s.state === "ready") break;
      if (Date.now() > deadline) throw new Error(`Backend "${name}" never became ready`);
      await new Promise((r) => setTimeout(r, 10));
    }
  }

  const server = new Server(
    { name: "mcp-bizhawk-test", version: "0.0.0" },
    { capabilities: { tools: {} } },
  );
  registerTools(server, bh);

  const [clientTransport, serverTransport] = InMemoryTransport.createLinkedPair();
  const client = new Client({ name: "test-client", version: "0.0.0" }, { capabilities: {} });
  await Promise.all([server.connect(serverTransport), client.connect(clientTransport)]);

  return {
    client,
    bridges,
    bh,
    close: async () => {
      for (const b of Object.values(bridges)) b.close();
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
