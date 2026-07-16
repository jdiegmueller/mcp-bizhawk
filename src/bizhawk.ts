// mcp-bizhawk Node.js side
// ────────────────────────
// Hosts a TCP server that BizHawk's Lua bridge connects out to. Each frame
// the Lua script does ONE round-trip:
//
//   Lua → us:  "READY\n"             (no pending result)
//          OR  "RESULT <json>\n"      (carrying back the previous frame's result)
//   us → Lua:  "NONE\n"               (nothing pending)
//          OR  "<json command>\n"     (next queued command)
//          OR  "HELLO <json>\n"       (once, replying to the connection's first
//                                      message: {"server_version","protocol_version"}
//                                      so the bridge can log which build it reached
//                                      and compare RPC protocol for compatibility)
//
// MCP tool calls land via call(method, params) → we enqueue the command and
// resolve the returned promise once the matching RESULT comes back. Each
// command therefore takes at minimum ~one frame (~16ms at 60fps) of latency.

import net from "node:net";

import { VERSION, PROTOCOL_VERSION } from "./version.js";

interface PendingCmd {
  id:      number;
  method:  string;
  params:  Record<string, unknown>;
  resolve: (result: unknown) => void;
  reject:  (err: Error) => void;
}

export interface BizhawkOptions {
  /** TCP host to listen on. Default 127.0.0.1. */
  host?: string;
  /** TCP port the BizHawk Lua bridge will dial. Default 8766. */
  port?: number;
  /** Per-call timeout (ms). Default 10000. */
  timeoutMs?: number;
}

export class BizhawkServer {
  private server: net.Server | null = null;
  private client: net.Socket | null = null;
  private buf = "";
  private queue: PendingCmd[] = [];
  /** Commands sent to BizHawk awaiting a RESULT reply. Keyed by command id. */
  private inflight = new Map<number, PendingCmd>();
  /** True between sending a command and receiving its reply. Lua only handles
   *  one command per round-trip, so we wait for a RESULT before sending the
   *  next command. */
  private awaitingResult = false;
  private nextId = 1;
  private readonly host: string;
  private readonly port: number;
  private readonly timeoutMs: number;

  constructor(opts: BizhawkOptions = {}) {
    this.host      = opts.host      ?? "127.0.0.1";
    this.port      = opts.port      ?? 8766;
    this.timeoutMs = opts.timeoutMs ?? 10000;
  }

  describeTarget(): string {
    return `tcp listening on ${this.host}:${this.port}`;
  }

  isConnected(): boolean {
    return this.client !== null && !this.client.destroyed;
  }

  /**
   * True once we've received at least one message (READY or RESULT) from the
   * bridge. A bare TCP connection isn't enough — BizHawk's CLI flag opens the
   * socket at process startup, but `bridge_JD.lua` only starts polling after the
   * user loads it via Tools > Lua Console. Tools should wait for this before
   * issuing commands.
   */
  isBridgeReady(): boolean {
    return this.bridgeReady;
  }
  private bridgeReady = false;
  /** True once this connection's HELLO greeting (carrying our version) has
   *  been sent. The greeting is the reply to the bridge's first message, so
   *  the bridge can log which server build it reached — reset per connection
   *  so a redial gets greeted again. */
  private helloSent = false;

  /** Start listening. Resolves once the listen socket is bound. */
  async start(): Promise<void> {
    if (this.server) return;
    return new Promise<void>((resolve, reject) => {
      const srv = net.createServer((sock) => this.attachClient(sock));
      srv.once("error", (err) => reject(err));
      srv.listen(this.port, this.host, () => {
        this.server = srv;
        resolve();
      });
    });
  }

  stop(): void {
    // Graceful goodbye: tell the bridge we're going away BEFORE closing, so it
    // redials the (restarting) server instead of wedging on its next blocking
    // socketServerResponse() — a bare FIN/RST makes BizHawk's read spin forever
    // and freezes the whole emulator. end() flushes the BYE then half-closes;
    // callers that then process.exit should give it a brief moment to drain.
    if (this.client && !this.client.destroyed) {
      try {
        this.sendFramed("BYE");
        this.client.end();
      } catch {
        this.client.destroy();
      }
    }
    this.client = null;
    this.server?.close();
    this.server = null;
  }

  private attachClient(sock: net.Socket): void {
    // Capture the peer address up front — sock.remoteAddress reads as undefined
    // once the socket has closed, so the disconnect log needs the saved copy.
    const peer = `${sock.remoteAddress ?? "?"}:${sock.remotePort ?? "?"}`;
    if (this.client && !this.client.destroyed) {
      // Already have a client. Refuse the new one — only one BizHawk at a time.
      process.stderr.write(`[mcp-bizhawk] BizHawk client from ${peer} REFUSED (another already connected)\n`);
      sock.write("ERROR another BizHawk client already connected\n");
      sock.destroy();
      return;
    }
    process.stderr.write(`[mcp-bizhawk v${VERSION}] BizHawk client connected from ${peer} (waiting for bridge_JD.lua to start polling)\n`);
    this.client = sock;
    this.buf = "";
    this.awaitingResult = false;
    this.bridgeReady = false;
    this.helloSent = false;

    // CRITICAL: disable Nagle. Bridge's socketServerResponse has a 5ms timeout;
    // our 5-byte NONE replies get coalesced by Nagle for up to 200ms otherwise,
    // missing every receive window. With Nagle off, writes flush immediately.
    sock.setNoDelay(true);

    sock.setEncoding("utf8");
    sock.on("data", (chunk: string) => this.onData(chunk));
    sock.on("close", () => {
      process.stderr.write(`[mcp-bizhawk] BizHawk client disconnected from ${peer}\n`);
      this.client = null;
      // Leave inflight commands hanging — they'll time out cleanly.
    });
    sock.on("error", (err) => {
      process.stderr.write(`[mcp-bizhawk] socket error: ${err.message}\n`);
    });
  }

  private onData(chunk: string): void {
    if (process.env.MCP_BIZHAWK_DEBUG) {
      process.stderr.write(`[trace] RX raw (${chunk.length}B): ${JSON.stringify(chunk)}\n`);
    }
    this.buf += chunk;
    while (true) {
      const nl = this.buf.indexOf("\n");
      if (nl === -1) break;
      let line = this.buf.slice(0, nl).trim();
      this.buf = this.buf.slice(nl + 1);
      if (line.length === 0) continue;

      // BizHawk's SocketServer.SendString prepends every outgoing message
      // with "<byte-count> " as a framing header. Strip it.
      const m = line.match(/^(\d+) (.+)$/);
      if (m) line = m[2];

      if (process.env.MCP_BIZHAWK_DEBUG) {
        process.stderr.write(`[trace] RX line: ${JSON.stringify(line)}\n`);
      }
      this.handleMessage(line);
    }
  }

  private handleMessage(line: string): void {
    if (!this.bridgeReady) {
      this.bridgeReady = true;
      process.stderr.write(`[mcp-bizhawk v${VERSION}] bridge_JD.lua is polling — bridge ready\n`);
    }
    if (line === "READY") {
      // Lua is asking for work; no result to deliver this round.
      this.maybeDispatchNext();
      return;
    }
    if (line.startsWith("RESULT ")) {
      const json = line.slice(7);
      let parsed: { id?: number; result?: unknown; error?: { code: number; message: string } };
      try {
        parsed = JSON.parse(json);
      } catch (err) {
        process.stderr.write(`[mcp-bizhawk] bad RESULT json: ${(err as Error).message}\n`);
        this.awaitingResult = false;
        this.maybeDispatchNext();
        return;
      }
      const id = parsed.id ?? -1;
      const pending = this.inflight.get(id);
      if (pending) {
        this.inflight.delete(id);
        if (parsed.error) {
          pending.reject(new Error(`BizHawk RPC error [${parsed.error.code}]: ${parsed.error.message}`));
        } else {
          pending.resolve(parsed.result);
        }
      }
      this.awaitingResult = false;
      this.maybeDispatchNext();
      return;
    }
    process.stderr.write(`[mcp-bizhawk] unrecognised line from BizHawk: ${line}\n`);
    this.maybeDispatchNext();
  }

  /**
   * Write a single message to the bridge. BizHawk's socket server, since
   * 2.6.2, requires INCOMING messages to be length-prefixed the same way it
   * frames its OUTGOING ones: `"{length:D} {message}"`. Without the prefix,
   * BizHawk's parser silently discards the line and `socketServerResponse()`
   * returns empty — which is exactly the failure mode we hit before finding
   * this in `Lua/_docs_luacats/comm.d.lua`.
   */
  private sendFramed(payload: string): void {
    if (!this.client || this.client.destroyed) return;
    // length = byte count of the payload itself (not including the framing
    // prefix or the trailing newline that delimits the line on the wire).
    const byteLen = Buffer.byteLength(payload, "utf8");
    const wire = `${byteLen} ${payload}\n`;
    if (process.env.MCP_BIZHAWK_DEBUG) {
      process.stderr.write(`[trace] TX: ${JSON.stringify(wire)}\n`);
    }
    this.client.write(wire);
  }

  /**
   * Called when Lua sends READY. We MUST reply to every send because
   * BizHawk's Lua bridge polls `socketServerResponse()` once per frame and
   * expects something there — and we want to keep the round-trip turning
   * even when there's no work. Reply with the next queued command if
   * available, otherwise NONE.
   */
  private maybeDispatchNext(): void {
    if (!this.client || this.client.destroyed) return;
    if (!this.helloSent) {
      // Greet the bridge before any other traffic so it can log which server
      // build it reached. Costs one round-trip (~1 frame) per connection.
      this.helloSent = true;
      this.sendFramed(`HELLO ${JSON.stringify({ server_version: VERSION, protocol_version: PROTOCOL_VERSION })}`);
      return;
    }
    if (this.awaitingResult) {
      // a command is in flight; tell bridge to keep waiting
      this.sendFramed("NONE");
      return;
    }
    const next = this.queue.shift();
    if (!next) {
      this.sendFramed("NONE");
      return;
    }
    this.inflight.set(next.id, next);
    this.awaitingResult = true;
    // Stamp server version/protocol (sv/sp) onto every command. The bridge
    // captures them on dispatch, so its OSD version line self-heals from normal
    // traffic even when a Lua-script RELOAD reused the socket and thus missed the
    // once-per-connection HELLO (BizHawk owns the External-Tool socket, so a
    // reload does not re-dial and re-trigger HELLO).
    const msg = JSON.stringify({ id: next.id, method: next.method, params: next.params, sv: VERSION, sp: PROTOCOL_VERSION });
    this.sendFramed(msg);
  }

  /**
   * Enqueue a command and return a promise that resolves when BizHawk replies.
   * Frame-locked commands (frame_advance, play_input_sequence, wait_for_memory)
   * inherently take ~16ms per emulated frame, so callers pass a scaled
   * `timeoutMs` for those instead of relying on the flat default.
   */
  async call<T = unknown>(
    method: string,
    params: Record<string, unknown> = {},
    opts: { timeoutMs?: number } = {},
  ): Promise<T> {
    const timeoutMs = Math.max(opts.timeoutMs ?? this.timeoutMs, this.timeoutMs);
    return new Promise<T>((resolve, reject) => {
      const id = this.nextId++;
      const pending: PendingCmd = {
        id,
        method,
        params,
        resolve: (r) => resolve(r as T),
        reject,
      };

      const timer = setTimeout(() => {
        // Drop from queue if still waiting; from inflight if already sent.
        this.queue   = this.queue.filter((p) => p.id !== id);
        this.inflight.delete(id);
        if (this.inflight.size === 0) this.awaitingResult = false;
        reject(new Error(
          `BizHawk call "${method}" timed out (${timeoutMs}ms) — ` +
          `is the bridge_JD.lua script still polling?`,
        ));
      }, timeoutMs);

      // Wrap so the timer always clears
      const origResolve = pending.resolve, origReject = pending.reject;
      pending.resolve = (r) => { clearTimeout(timer); origResolve(r); };
      pending.reject  = (e) => { clearTimeout(timer); origReject(e); };

      this.queue.push(pending);
    });
  }
}
