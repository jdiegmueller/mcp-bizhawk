#!/usr/bin/env node
import { Server } from "@modelcontextprotocol/sdk/server/index.js";
import { StdioServerTransport } from "@modelcontextprotocol/sdk/server/stdio.js";
import { BizhawkServer } from "./bizhawk.js";
import { registerTools } from "./tools.js";
import { VERSION } from "./version.js";

const HOST = process.env.BIZHAWK_HOST ?? "127.0.0.1";
const PORT = parseInt(process.env.BIZHAWK_PORT ?? "8766", 10);

async function main() {
  const bh = new BizhawkServer({ host: HOST, port: PORT });

  // Start the TCP listener immediately. Tool calls will queue up until BizHawk
  // connects (via lua/bridge_JD.lua loaded in BizHawk's Lua Console + the
  // socket server IP/port configured to point here).
  try {
    await bh.start();
    process.stderr.write(
      `[mcp-bizhawk] v${VERSION}; ${bh.describeTarget()}; waiting for BizHawk to connect...\n` +
      `             1. In BizHawk: Settings > Customize > External Tools (or use --socket_ip / --socket_port flags)\n` +
      `             2. Set socket server target to ${HOST}:${PORT}\n` +
      `             3. Tools > Lua Console > Open Script > select lua/bridge_JD.lua from this repo\n`,
    );
  } catch (err) {
    process.stderr.write(`[mcp-bizhawk] FATAL: could not bind ${HOST}:${PORT}: ${err}\n`);
    process.exit(1);
  }

  const server = new Server(
    { name: "mcp-bizhawk", version: VERSION },
    { capabilities: { tools: {} } },
  );

  registerTools(server, bh);

  const transport = new StdioServerTransport();
  await server.connect(transport);
  process.stderr.write(`[mcp-bizhawk] MCP server v${VERSION} ready (stdio)\n`);

  // Clean shutdown when the MCP client (Claude Code, Claude Desktop, etc.)
  // disconnects. Without this, the TCP listener for bridge_JD.lua keeps the
  // event loop alive after stdin closes — leaving an orphan process bound
  // to the port. Every subsequent MCP-client restart would then fail with
  // EADDRINUSE until the orphan is manually killed.
  const shutdown = (reason: string) => {
    process.stderr.write(`[mcp-bizhawk] shutting down (${reason})\n`);
    bh.stop(); // sends BYE + half-closes the bridge socket
    // Give the BYE + FIN a beat to flush to the bridge before we exit — without
    // it process.exit() can truncate the write and the bridge never sees BYE
    // (then it wedges on its next read instead of redialing the new server).
    setTimeout(() => process.exit(0), 150);
  };
  process.stdin.on("end",   () => shutdown("stdin closed"));
  process.stdin.on("close", () => shutdown("stdin closed"));
  process.on("SIGINT",  () => shutdown("SIGINT"));
  process.on("SIGTERM", () => shutdown("SIGTERM"));
}

main().catch((err) => {
  process.stderr.write(`[mcp-bizhawk] fatal: ${err}\n`);
  process.exit(1);
});
