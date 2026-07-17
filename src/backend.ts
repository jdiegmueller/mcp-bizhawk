import net from "node:net";
import path from "node:path";
import { VERSION, PROTOCOL_VERSION } from "./version.js";
import { BackendDisconnectedError, BackendStoppedError, BackendNotConnectedError, BackendNotReadyError, BackendCallTimeoutError } from "./errors.js";
import type { BackendConfig, PathPair } from "./config.js";

export type BackendState = "stopped" | "listening" | "connected" | "ready";

export interface BackendStatus {
  name: string;
  host: string;
  port: number;
  state: BackendState;
  socketGeneration: number;
  queuedCommands: number;
  inflightCommand: { id: number; method: string } | null;
  remoteAddress?: string;
}

interface PendingCmd {
  id: number;
  method: string;
  params: Record<string, unknown>;
  resolve: (result: unknown) => void;
  reject: (err: Error) => void;
}

interface NhlDomain {
  detect: (params: Record<string, unknown>) => Promise<string>;
  addr: (abs: number) => number;
  rebase: (ops: { address: number }[]) => { address: number }[];
}

const HANDSHAKE_TIMEOUT_MS = 5_000;
const MAX_QUEUED_COMMANDS = 100;

export class BizhawkBackend {
  readonly name: string;
  readonly config: BackendConfig;

  private server: net.Server | null = null;
  private socket: net.Socket | null = null;
  private socketGeneration = 0;
  private peerAddress: string | undefined;

  private buf = "";
  private queue: PendingCmd[] = [];
  private inflight: PendingCmd | null = null;
  private awaitingResult = false;
  private bridgeReady = false;
  private helloSent = false;
  private nextId = 1;
  private state: BackendState = "stopped";
  private handshakeTimer: ReturnType<typeof setTimeout> | null = null;

  private startPromise: Promise<void> | null = null;
  private stopPromise: Promise<void> | null = null;

  private _nhlDomain: NhlDomain | null = null;
  private _nhlDomainCache:
    | { generation: number; domain: NhlDomain }
    | null = null;

  constructor(name: string, config: BackendConfig) {
    this.name = name;
    this.config = config;
  }

  get host(): string { return this.config.bizhawkHost ?? "127.0.0.1"; }
  get port(): number { return this.config.bizhawkPort; }

  isConnected(): boolean { return this.state === "connected" || this.state === "ready"; }
  isBridgeReady(): boolean { return this.state === "ready"; }

  // ── Path resolution ──────────────────────────────────────────

  resolvePathPair(kind: "shot" | "state" | "rig", filename: string): PathPair {
    const dirKey = `${kind}Dir` as const;
    const bridgeDirKey = `${kind}DirBridge` as const;
    const hostDir = this.config[dirKey];
    if (!hostDir) throw new Error(
      `Backend "${this.name}" has no ${kind} directory configured. ` +
      `Set ${kind}Dir in the backend config.`
    );
    const host = path.join(hostDir, filename);
    const bridgeDir = this.config[bridgeDirKey];
    return { host, bridge: bridgeDir ? path.posix.join(bridgeDir, filename) : undefined };
  }

  /** Return the host-side shot dir, or undefined. Falls back to env var. */
  shotDirHost(): string | undefined {
    return this.config.shotDir || process.env.MCP_BIZHAWK_SHOT_DIR || undefined;
  }

  /** Return the bridge-side shot dir, or undefined. Falls back to env var. */
  shotDirBridge(): string | undefined {
    return this.config.shotDirBridge || process.env.MCP_BIZHAWK_SHOT_DIR_BRIDGE || undefined;
  }

  stateDirHost(): string | undefined {
    return this.config.stateDir || process.env.MCP_BIZHAWK_STATE_DIR || undefined;
  }

  stateDirBridge(): string | undefined {
    return this.config.stateDirBridge || process.env.MCP_BIZHAWK_STATE_DIR_BRIDGE || undefined;
  }

  rigDirHost(): string | undefined {
    return this.config.rigDir || process.env.MCP_BIZHAWK_RIG_DIR || undefined;
  }

  rigDirBridge(): string | undefined {
    return this.config.rigDirBridge || process.env.MCP_BIZHAWK_RIG_DIR_BRIDGE || undefined;
  }

  // ── NHL domain cache ─────────────────────────────────────────

  /** Returns an NhlDomain proxy that resolves/caches per socket generation. */
  async nhlDomain(): Promise<NhlDomain> {
    if (this.state !== "ready") throw new BackendNotReadyError(this.name);
    const cached = this._nhlDomainCache;
    if (cached?.generation === this.socketGeneration) return cached.domain;

    const domains = await this.call<string[]>("list_memory_domains");
    const d = domains.includes("M68K BUS") ? "M68K BUS"
      : domains.includes("68K RAM") ? "68K RAM"
      : null;
    if (!d) throw new Error("no Genesis 68K memory domain (M68K BUS / 68K RAM) on the loaded core");

    const domain: NhlDomain = {
      detect: async () => d,
      addr: (abs: number) => d === "68K RAM" ? abs - 0xff0000 : abs,
      rebase: (ops) => ops.map((o) => ({ ...o, address: d === "68K RAM" ? o.address - 0xff0000 : o.address })),
    };

    this._nhlDomainCache = { generation: this.socketGeneration, domain };
    return domain;
  }

  // ── Lifecycle ────────────────────────────────────────────────

  async start(): Promise<void> {
    if (this.state !== "stopped") {
      if (this.startPromise) return this.startPromise;
      return;
    }
    if (this.stopPromise) throw new Error(`Backend "${this.name}" is stopping — cannot start.`);

    this.startPromise = (async () => {
      try {
        await new Promise<void>((resolve, reject) => {
          const srv = net.createServer((sock) => this.attachClient(sock));
          srv.once("error", (err) => reject(err));
          srv.listen(this.port, this.host, () => {
            this.server = srv;
            this.state = "listening";
            process.stderr.write(
              `[mcp-bizhawk] backend "${this.name}" listening on ${this.host}:${this.port}\n`
            );
            resolve();
          });
        });
      } finally {
        this.startPromise = null;
      }
    })();
    return this.startPromise;
  }

  async stop(): Promise<void> {
    if (this.state === "stopped") return;
    if (this.stopPromise) return this.stopPromise;

    this.stopPromise = (async () => {
      try {
        // Invalidate generation so socket callbacks don't transform stop into BackendDisconnectedError
        this.socketGeneration++;
        this.handshakeTimer != null && clearTimeout(this.handshakeTimer);
        this.handshakeTimer = null;

        this.state = "stopped";

        // Send BYE and close socket
        if (this.socket && !this.socket.destroyed) {
          try {
            this.sendFramed("BYE");
            this.socket.end();
          } catch {
            this.socket.destroy();
          }
        }
        this.socket = null;

        // Reject pending work
        const stopped = new BackendStoppedError(this.name);
        this.failInflight(stopped);
        this.rejectQueue(stopped);

        this.server?.close();
        this.server = null;

        this.buf = "";
        this.bridgeReady = false;
        this.helloSent = false;
        this.awaitingResult = false;
        this._nhlDomainCache = null;
        process.stderr.write(`[mcp-bizhawk] backend "${this.name}" stopped\n`);
      } finally {
        this.stopPromise = null;
      }
    })();
    return this.stopPromise;
  }

  status(): BackendStatus {
    return {
      name: this.name,
      host: this.host,
      port: this.port,
      state: this.state,
      socketGeneration: this.socketGeneration,
      queuedCommands: this.queue.length,
      inflightCommand: this.inflight
        ? { id: this.inflight.id, method: this.inflight.method }
        : null,
      remoteAddress: this.peerAddress,
    };
  }

  // ── TCP protocol ─────────────────────────────────────────────

  private attachClient(sock: net.Socket): void {
    const peer = `${sock.remoteAddress ?? "?"}:${sock.remotePort ?? "?"}`;

    // Check remote authorization
    if (this.config.allowedRemoteAddresses) {
      const addr = sock.remoteAddress;
      if (addr && !this.config.allowedRemoteAddresses.includes(addr)) {
        process.stderr.write(
          `[mcp-bizhawk] backend "${this.name}" REJECTED connection from ${peer} (not in allowedRemoteAddresses)\n`
        );
        sock.end("UNAUTHORIZED\n");
        sock.destroy();
        return;
      }
    }

    // Second-client rejection
    if (this.socket && !this.socket.destroyed) {
      process.stderr.write(
        `[mcp-bizhawk] backend "${this.name}" REJECTED connection from ${peer} (another already connected)\n`
      );
      sock.end("BUSY\n");
      sock.destroy();
      return;
    }

    // Accept
    const generation = ++this.socketGeneration;
    this.socket = sock;
    this.peerAddress = peer;
    this.buf = "";
    this.awaitingResult = false;
    this.bridgeReady = false;
    this.helloSent = false;
    this.state = "connected";

    process.stderr.write(
      `[mcp-bizhawk v${VERSION}] backend "${this.name}" client connected from ${peer}\n`
    );

    sock.setNoDelay(true);
    sock.setEncoding("utf8");

    sock.on("data", (chunk: string) => {
      if (sock !== this.socket) return;
      this.onData(chunk);
    });

    sock.on("close", () => {
      if (sock !== this.socket) return;
      if (generation !== this.socketGeneration) return;
      this.detachSocket(sock, generation, new Error("socket closed"));
    });

    sock.on("error", (err: Error) => {
      if (sock !== this.socket) return;
      if (generation !== this.socketGeneration) return;
      process.stderr.write(
        `[mcp-bizhawk] backend "${this.name}" socket error: ${err.message}\n`
      );
    });

    // Handshake timeout
    this.handshakeTimer = setTimeout(() => {
      if (this.state !== "connected") return;
      if (sock !== this.socket) return;
      if (generation !== this.socketGeneration) return;
      process.stderr.write(
        `[mcp-bizhawk] backend "${this.name}" handshake timeout — client never sent READY\n`
      );
      this.detachSocket(sock, generation, new Error("handshake timeout"));
    }, HANDSHAKE_TIMEOUT_MS);
  }

  private detachSocket(
    socket: net.Socket,
    generation: number,
    cause: unknown,
  ): void {
    if (socket !== this.socket) return;
    if (generation !== this.socketGeneration) return;

    this.socket = null;
    this.peerAddress = undefined;
    this.state = "listening";
    this.buf = "";
    this.bridgeReady = false;
    this.helloSent = false;
    this.awaitingResult = false;

    this.handshakeTimer != null && clearTimeout(this.handshakeTimer);
    this.handshakeTimer = null;
    this._nhlDomainCache = null;

    const error = new BackendDisconnectedError(this.name);
    this.failInflight(error);
    this.rejectQueue(error);

    process.stderr.write(
      `[mcp-bizhawk] backend "${this.name}" disconnected\n`
    );
  }

  private onData(chunk: string): void {
    if (process.env.MCP_BIZHAWK_DEBUG) {
      process.stderr.write(`[trace] ${this.name} RX raw (${chunk.length}B): ${JSON.stringify(chunk)}\n`);
    }
    this.buf += chunk;
    while (true) {
      const nl = this.buf.indexOf("\n");
      if (nl === -1) break;
      let line = this.buf.slice(0, nl).trim();
      this.buf = this.buf.slice(nl + 1);
      if (line.length === 0) continue;

      const m = line.match(/^(\d+) (.+)$/);
      if (m) line = m[2];

      if (process.env.MCP_BIZHAWK_DEBUG) {
        process.stderr.write(`[trace] ${this.name} RX line: ${JSON.stringify(line)}\n`);
      }
      this.handleMessage(line);
    }
  }

  private handleMessage(line: string): void {
    if (!this.bridgeReady) {
      this.bridgeReady = true;
      this.state = "ready";
      this.handshakeTimer != null && clearTimeout(this.handshakeTimer);
      this.handshakeTimer = null;
      process.stderr.write(
        `[mcp-bizhawk v${VERSION}] backend "${this.name}" bridge polling — ready\n`
      );
    }
    if (line === "READY") {
      this.maybeDispatchNext();
      return;
    }
    if (line.startsWith("RESULT ")) {
      const json = line.slice(7);
      let parsed: { id?: number; result?: unknown; error?: { code: number; message: string } };
      try {
        parsed = JSON.parse(json);
      } catch (err) {
        process.stderr.write(
          `[mcp-bizhawk] backend "${this.name}" bad RESULT json: ${(err as Error).message}\n`
        );
        this.awaitingResult = false;
        this.maybeDispatchNext();
        return;
      }
      const id = parsed.id ?? -1;
      const pending = this.inflight;
      if (pending && pending.id === id) {
        this.inflight = null;
        if (parsed.error) {
          pending.reject(new Error(
            `BizHawk RPC error [${parsed.error.code}]: ${parsed.error.message}`
          ));
        } else {
          pending.resolve(parsed.result);
        }
      }
      this.awaitingResult = false;
      this.maybeDispatchNext();
      return;
    }
    process.stderr.write(
      `[mcp-bizhawk] backend "${this.name}" unrecognised line: ${line}\n`
    );
    this.maybeDispatchNext();
  }

  private sendFramed(payload: string): void {
    if (!this.socket || this.socket.destroyed) return;
    const byteLen = Buffer.byteLength(payload, "utf8");
    const wire = `${byteLen} ${payload}\n`;
    if (process.env.MCP_BIZHAWK_DEBUG) {
      process.stderr.write(`[trace] ${this.name} TX: ${JSON.stringify(wire)}\n`);
    }
    this.socket.write(wire);
  }

  private maybeDispatchNext(): void {
    if (!this.socket || this.socket.destroyed) return;
    if (!this.helloSent) {
      this.helloSent = true;
      this.sendFramed(
        `HELLO ${JSON.stringify({ server_version: VERSION, protocol_version: PROTOCOL_VERSION })}`
      );
      return;
    }
    if (this.awaitingResult) {
      this.sendFramed("NONE");
      return;
    }
    const next = this.queue.shift();
    if (!next) {
      this.sendFramed("NONE");
      return;
    }
    this.inflight = next;
    this.awaitingResult = true;
    const msg = JSON.stringify({
      id: next.id, method: next.method, params: next.params,
      sv: VERSION, sp: PROTOCOL_VERSION,
    });
    this.sendFramed(msg);
  }

  // ── Public call() ────────────────────────────────────────────

  async call<T = unknown>(
    method: string,
    params: Record<string, unknown> = {},
    opts: { timeoutMs?: number } = {},
  ): Promise<T> {
    switch (this.state) {
      case "stopped":
      case "listening":
        throw new BackendNotConnectedError(this.name);
      case "connected":
        throw new BackendNotReadyError(this.name);
      case "ready":
        break; // fall through
    }

    if (this.queue.length >= MAX_QUEUED_COMMANDS) {
      throw new Error(
        `Backend "${this.name}" has too many queued commands (${MAX_QUEUED_COMMANDS} max).`
      );
    }

    const timeoutMs = Math.max(opts.timeoutMs ?? 10_000, 10_000);
    return new Promise<T>((resolve, reject) => {
      const id = this.nextId++;
      const generation = this.socketGeneration;

      const pending: PendingCmd = {
        id, method, params,
        resolve: (r) => resolve(r as T),
        reject,
      };

      const timer = setTimeout(() => {
        if (generation !== this.socketGeneration) return;
        if (this.inflight !== pending) {
          this.queue = this.queue.filter((p) => p.id !== id);
        }
        if (this.inflight === pending) {
          const timeoutErr = new BackendCallTimeoutError(this.name, method);
          pending.reject(timeoutErr);
          this.inflight = null;
          this.awaitingResult = false;
          this.maybeDispatchNext();
        }
      }, timeoutMs);

      const origResolve = pending.resolve;
      const origReject = pending.reject;
      pending.resolve = (r) => { clearTimeout(timer); origResolve(r); };
      pending.reject = (e) => { clearTimeout(timer); origReject(e); };

      this.queue.push(pending);
    });
  }

  // ── Internal helpers ─────────────────────────────────────────

  private failInflight(error: Error): void {
    const pending = this.inflight;
    if (pending) {
      this.inflight = null;
      this.awaitingResult = false;
      pending.reject(error);
    }
  }

  private rejectQueue(error: Error): void {
    for (const p of this.queue) p.reject(error);
    this.queue = [];
  }
}
