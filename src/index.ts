#!/usr/bin/env node
import { BizhawkServer } from "./bizhawk.js";
import { createMcpHttpServer, MCP_PATH } from "./http.js";
import { VERSION } from "./version.js";

// --- BizHawk side (downstream): the single TCP socket the Lua bridge dials ---
const BIZHAWK_HOST = process.env.BIZHAWK_HOST ?? "127.0.0.1";
const BIZHAWK_PORT = parseInt(process.env.BIZHAWK_PORT ?? "8766", 10);

// --- MCP side (upstream): the always-on HTTP endpoint Claude sessions connect to ---
const HTTP_HOST = process.env.MCP_HTTP_HOST ?? "127.0.0.1";
const HTTP_PORT = parseInt(process.env.MCP_HTTP_PORT ?? "8765", 10);

async function main() {
  // The one shared BizHawk connection + serial, frame-paced command queue.
  // Every per-request MCP Server (see http.ts) drives this same singleton, so N
  // Claude sessions interleave into one FIFO to the one emulator (last-writer-
  // wins; there is deliberately no arbitration between sessions).
  const bh = new BizhawkServer({ host: BIZHAWK_HOST, port: BIZHAWK_PORT });

  try {
    await bh.start();
    process.stderr.write(
      `[mcp-bizhawk] v${VERSION}; ${bh.describeTarget()}; waiting for BizHawk to connect...\n` +
      `             1. In BizHawk: Settings > Customize > External Tools (or use --socket_ip / --socket_port flags)\n` +
      `             2. Set socket server target to ${BIZHAWK_HOST}:${BIZHAWK_PORT}\n` +
      `             3. Tools > Lua Console > Open Script > select lua/bridge_JD.lua from this repo\n`,
    );
  } catch (err) {
    process.stderr.write(`[mcp-bizhawk] FATAL: could not bind ${BIZHAWK_HOST}:${BIZHAWK_PORT}: ${err}\n`);
    process.exit(1);
  }

  const httpServer = createMcpHttpServer(bh);
  httpServer.listen(HTTP_PORT, HTTP_HOST, () => {
    process.stderr.write(
      `[mcp-bizhawk] MCP server v${VERSION} ready — streamable-HTTP at http://${HTTP_HOST}:${HTTP_PORT}${MCP_PATH}\n`,
    );
  });
  httpServer.on("error", (err) => {
    process.stderr.write(`[mcp-bizhawk] FATAL: HTTP server error on ${HTTP_HOST}:${HTTP_PORT}: ${err}\n`);
    process.exit(1);
  });

  // Clean shutdown. systemd sends SIGTERM on stop/restart; give the bridge's BYE
  // + FIN a beat to flush before exit so it redials the new server instead of
  // wedging on its next read.
  let shuttingDown = false;
  const shutdown = (reason: string) => {
    if (shuttingDown) return;
    shuttingDown = true;
    process.stderr.write(`[mcp-bizhawk] shutting down (${reason})\n`);
    httpServer.close();
    bh.stop(); // sends BYE + half-closes the bridge socket
    setTimeout(() => process.exit(0), 150);
  };
  process.on("SIGINT",  () => shutdown("SIGINT"));
  process.on("SIGTERM", () => shutdown("SIGTERM"));
}

main().catch((err) => {
  process.stderr.write(`[mcp-bizhawk] fatal: ${err}\n`);
  process.exit(1);
});
