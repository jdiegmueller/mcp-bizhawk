// Streamable-HTTP MCP front end for the always-on daemon.
//
// One shared BizhawkServer singleton (the single BizHawk socket + serial,
// frame-paced command queue) is driven by N concurrent Claude sessions over
// HTTP. Runs STATELESS: no per-client MCP session state (all real state lives
// in BizHawk), so — per the SDK's stateless guidance — each request gets a
// fresh Server + transport bound to the shared `bh`, torn down when the
// response ends. This avoids cross-client request-id collisions and matches the
// no-arbitration, last-writer-wins model (all sessions interleave into one FIFO).
import http from "node:http";
import { Server } from "@modelcontextprotocol/sdk/server/index.js";
import { StreamableHTTPServerTransport } from "@modelcontextprotocol/sdk/server/streamableHttp.js";
import type { BizhawkServer } from "./bizhawk.js";
import { registerTools } from "./tools.js";
import { VERSION } from "./version.js";

export const MCP_PATH = "/mcp";

/** Read a request body fully into a string (JSON-RPC envelopes are small). */
function readBody(req: http.IncomingMessage): Promise<string> {
  return new Promise((resolve, reject) => {
    let data = "";
    req.setEncoding("utf8");
    req.on("data", (chunk) => { data += chunk; });
    req.on("end", () => resolve(data));
    req.on("error", reject);
  });
}

function jsonRpcError(res: http.ServerResponse, status: number, message: string, allow?: string): void {
  const headers: Record<string, string> = { "Content-Type": "application/json" };
  if (allow) headers["Allow"] = allow;
  res.writeHead(status, headers);
  res.end(JSON.stringify({ jsonrpc: "2.0", error: { code: -32000, message }, id: null }));
}

/**
 * Build (but do not start) the HTTP server that fronts the shared BizhawkServer.
 * Caller invokes `.listen(port, host)`.
 */
export function createMcpHttpServer(bh: BizhawkServer): http.Server {
  return http.createServer(async (req, res) => {
    const url = new URL(req.url ?? "/", `http://${req.headers.host ?? "127.0.0.1"}`);

    if (url.pathname !== MCP_PATH) {
      jsonRpcError(res, 404, `Not found: ${url.pathname}`);
      return;
    }

    // Stateless server: only POST carries JSON-RPC. GET (server->client SSE) and
    // DELETE (session teardown) have no meaning without sessions — reject them.
    if (req.method !== "POST") {
      jsonRpcError(res, 405, "Method not allowed; POST JSON-RPC to /mcp.", "POST");
      return;
    }

    const mcpServer = new Server(
      { name: "mcp-bizhawk", version: VERSION },
      { capabilities: { tools: {} } },
    );
    registerTools(mcpServer, bh);

    const transport = new StreamableHTTPServerTransport({
      sessionIdGenerator: undefined,   // stateless
      enableJsonResponse: true,        // plain JSON responses, not an SSE stream
    });

    res.on("close", () => {
      transport.close();
      mcpServer.close();
    });

    try {
      await mcpServer.connect(transport);
      const body = await readBody(req);
      const parsed = body.length ? JSON.parse(body) : undefined;
      await transport.handleRequest(req, res, parsed);
    } catch (err) {
      process.stderr.write(`[mcp-bizhawk] request error: ${(err as Error).message}\n`);
      if (!res.headersSent) jsonRpcError(res, 500, "Internal server error");
    }
  });
}
