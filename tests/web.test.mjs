import test from "node:test";
import assert from "node:assert/strict";
import { BizhawkServer } from "../dist/bizhawk.js";
import { createMcpHttpServer, MCP_PATH } from "../dist/http.js";
import { createWebHttpServer, isAllowedWebAddress, resolveWebListenerConfig } from "../dist/web.js";

async function listen(server) {
  await new Promise((resolve) => server.listen(0, "127.0.0.1", resolve));
  return server.address().port;
}

async function close(server) {
  await new Promise((resolve) => server.close(resolve));
}

test("web IP filter accepts loopback and 10.245/16 only", () => {
  assert.equal(isAllowedWebAddress("127.0.0.1"), true);
  assert.equal(isAllowedWebAddress("::ffff:127.1.2.3"), true);
  assert.equal(isAllowedWebAddress("10.245.0.226"), true);
  assert.equal(isAllowedWebAddress("10.245.255.254"), true);
  assert.equal(isAllowedWebAddress("10.244.0.1"), false);
  assert.equal(isAllowedWebAddress("192.168.1.10"), false);
});

test("web listener follows the MCP bind address and uses port 8767 by default", () => {
  assert.deepEqual(
    resolveWebListenerConfig({ MCP_HTTP_HOST: "10.245.0.226", MCP_HTTP_PORT: "8765" }),
    {
      host: "10.245.0.226",
      port: 8767,
      mcpUrl: new URL("http://10.245.0.226:8765/mcp"),
    },
  );
});

test("web server serves the focused console and proxies the MCP tool catalog", async () => {
  const bh = new BizhawkServer();
  const mcp = createMcpHttpServer(bh);
  const mcpPort = await listen(mcp);
  const web = createWebHttpServer({ mcpUrl: new URL(`http://127.0.0.1:${mcpPort}${MCP_PATH}`) });
  const webPort = await listen(web);
  try {
    const page = await fetch(`http://127.0.0.1:${webPort}/`);
    assert.equal(page.status, 200);
    const html = await page.text();
    assert.match(html, /BIZHAWK \/ CONTROL/);
    assert.match(html, /tool-search/);

    const catalog = await fetch(`http://127.0.0.1:${webPort}/api/tools`);
    assert.equal(catalog.status, 200);
    const json = await catalog.json();
    assert.ok(json.tools.some((tool) => tool.name === "bizhawk_ping"));
    assert.ok(json.tools.some((tool) => tool.name === "nhl94_state"));
  } finally {
    await close(web);
    await close(mcp);
  }
});

test("web server proxies tool calls and validates the request shape", async () => {
  const bh = new BizhawkServer();
  const mcp = createMcpHttpServer(bh);
  const mcpPort = await listen(mcp);
  const web = createWebHttpServer({ mcpUrl: new URL(`http://127.0.0.1:${mcpPort}${MCP_PATH}`) });
  const webPort = await listen(web);
  try {
    const response = await fetch(`http://127.0.0.1:${webPort}/api/call`, {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({ name: "bizhawk_list_backends", arguments: {} }),
    });
    assert.equal(response.status, 200);
    const result = await response.json();
    assert.equal(result.content[0].text, "No backends configured.");

    const bad = await fetch(`http://127.0.0.1:${webPort}/api/call`, {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({ arguments: {} }),
    });
    assert.equal(bad.status, 400);
  } finally {
    await close(web);
    await close(mcp);
  }
});
