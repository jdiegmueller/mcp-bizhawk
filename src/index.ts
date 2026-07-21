#!/usr/bin/env node
import { BizhawkServer } from "./bizhawk.js";
import { createMcpHttpServer, MCP_PATH } from "./http.js";
import { createWebHttpServer, resolveWebListenerConfig } from "./web.js";
import { loadConfig } from "./config.js";
import { VERSION } from "./version.js";

const HTTP_HOST = process.env.MCP_HTTP_HOST ?? "127.0.0.1";
const HTTP_PORT = parseInt(process.env.MCP_HTTP_PORT ?? "8765", 10);

// Apply vision config from config file to process.env, overriding env vars
function applyVisionEnv(visionConfig?: { baseUrl?: string; model?: string; apiKey?: string }): void {
  if (visionConfig?.baseUrl) process.env.VISION_BASE_URL = visionConfig.baseUrl;
  if (visionConfig?.model) process.env.VISION_MODEL = visionConfig.model;
  if (visionConfig?.apiKey) process.env.VISION_API_KEY = visionConfig.apiKey;
}

async function main() {
  const config = loadConfig();
  applyVisionEnv(config.vision);

  const bh = new BizhawkServer();

  process.stderr.write(`[mcp-bizhawk] v${VERSION} starting multiplexer with ${Object.keys(config.backends).length} backend(s)\n`);
  for (const [name, cfg] of Object.entries(config.backends)) {
    process.stderr.write(
      `              ${name}: ${cfg.bizhawkHost ?? "127.0.0.1"}:${cfg.bizhawkPort}\n`
    );
  }

  try {
    await bh.start(config.backends);
  } catch (err) {
    process.stderr.write(`[mcp-bizhawk] FATAL: could not start backends: ${err}\n`);
    process.exit(1);
  }

  const httpServer = createMcpHttpServer(bh);
  const webConfig = resolveWebListenerConfig(process.env);
  const webServer = createWebHttpServer({ mcpUrl: webConfig.mcpUrl });
  httpServer.listen(HTTP_PORT, HTTP_HOST, () => {
    process.stderr.write(
      `[mcp-bizhawk] MCP server v${VERSION} ready — streamable-HTTP at http://${HTTP_HOST}:${HTTP_PORT}${MCP_PATH}\n`
    );
  });
  httpServer.on("error", (err) => {
    process.stderr.write(`[mcp-bizhawk] FATAL: HTTP server error on ${HTTP_HOST}:${HTTP_PORT}: ${err}\n`);
    process.exit(1);
  });
  webServer.listen(webConfig.port, webConfig.host, () => {
    process.stderr.write(
      `[mcp-bizhawk] web control ready at http://${webConfig.host}:${webConfig.port}/\n`
    );
  });
  webServer.on("error", (err) => {
    process.stderr.write(`[mcp-bizhawk] FATAL: web server error on ${webConfig.host}:${webConfig.port}: ${err}\n`);
    process.exit(1);
  });

  let shuttingDown = false;
  const shutdown = (reason: string) => {
    if (shuttingDown) return;
    shuttingDown = true;
    process.stderr.write(`[mcp-bizhawk] shutting down (${reason})\n`);
    httpServer.close();
    webServer.close();
    bh.stop().catch((e) => process.stderr.write(`[mcp-bizhawk] stop error: ${e}\n`));
    setTimeout(() => process.exit(0), 150);
  };
  process.on("SIGINT", () => shutdown("SIGINT"));
  process.on("SIGTERM", () => shutdown("SIGTERM"));
}

main().catch((err) => {
  process.stderr.write(`[mcp-bizhawk] fatal: ${err}\n`);
  process.exit(1);
});
