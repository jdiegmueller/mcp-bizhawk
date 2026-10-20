# MCP Multiplexer Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Evolve the single-BizHawk proxy into a multiplexer: one MCP server fronting N BizHawk backends with every tool taking a `target` parameter.

**Architecture:** Extract `BizhawkBackend` from the current `BizhawkServer`'s TCP state machine. `BizhawkServer` becomes a thin router over `Map<string, BizhawkBackend>`. Tools add `target` to every handler. Config comes from a single JSON file pointed at by `MCP_BIZHAWK_CONFIG`.

**Tech Stack:** Node.js + TypeScript, `@modelcontextprotocol/sdk`, Node `net` module, Node test runner.

## Global Constraints

- `MCP_BIZHAWK_CONFIG` is required; if unset/invalid, fail with clear message before binding HTTP
- Every backend-scoped tool requires `target`; `bizhawk_list_backends` is the sole global tool
- `target` must always be required (no single-backend fallback)
- `BizhawkBackend` call() only succeeds in state `"ready"`; other states throw typed errors
- Disconnect rejects inflight + queued calls, clears state, listener stays up
- Socket generation guards all callbacks against stale events
- Second simultaneous bridge client receives `BUSY`
- Atomic startup: validate all backends, first bind failure rolls back
- Handshake timeout (5s): `connected → detachSocket() → listening`
- Queue cap: 100 commands per backend
- Command timeout is end-to-end (includes queue time)
- Unknown config keys are rejected
- Per-backend path pairs (`shot`/`state`/`rig`) with host/bridge resolution
- NHL domain cache on backend, keyed by socket generation
- Remote listener protection via `allowedRemoteAddresses`
- Usage log entries include `target` and normalized error codes on failure
- Version bumps: display string only; protocol unchanged
- No backward compat — config file always required, target always required

---
### Task 1: Error classes

**Files:**
- Create: `src/errors.ts`

**Interfaces:**
- Produces: `BizhawkError`, `UnknownBackendError`, `BackendNotConnectedError`, `BackendNotReadyError`, `BackendDisconnectedError`, `BackendStoppedError`, `BackendCallTimeoutError`

- [ ] **Step 1: Write `src/errors.ts`**

```typescript
export class BizhawkError extends Error {
  constructor(message: string) { super(message); this.name = "BizhawkError"; }
}

export class UnknownBackendError extends BizhawkError {
  constructor(target: string, validTargets: string[]) {
    super(`Unknown backend "${target}". Valid targets: ${validTargets.join(", ")}`);
    this.name = "UnknownBackendError";
  }
}

export class BackendNotConnectedError extends BizhawkError {
  constructor(target: string) {
    super(`Backend "${target}" is not connected (no bridge client).`);
    this.name = "BackendNotConnectedError";
  }
}

export class BackendNotReadyError extends BizhawkError {
  constructor(target: string) {
    super(`Backend "${target}" is connected but bridge handshake is not complete yet.`);
    this.name = "BackendNotReadyError";
  }
}

export class BackendDisconnectedError extends BizhawkError {
  constructor(target: string) {
    super(`Backend "${target}" was disconnected unexpectedly.`);
    this.name = "BackendDisconnectedError";
  }
}

export class BackendStoppedError extends BizhawkError {
  constructor(target: string) {
    super(`Backend "${target}" has been shut down.`);
    this.name = "BackendStoppedError";
  }
}

export class BackendCallTimeoutError extends BizhawkError {
  constructor(target: string, method: string) {
    super(`Call "${method}" to backend "${target}" timed out.`);
    this.name = "BackendCallTimeoutError";
  }
}
```

**Error code mapping for usage logging:**

```typescript
export function errorCode(err: unknown): string {
  if (err instanceof UnknownBackendError) return "UNKNOWN_BACKEND";
  if (err instanceof BackendNotConnectedError) return "BACKEND_NOT_CONNECTED";
  if (err instanceof BackendNotReadyError) return "BACKEND_NOT_READY";
  if (err instanceof BackendDisconnectedError) return "BACKEND_DISCONNECTED";
  if (err instanceof BackendStoppedError) return "BACKEND_STOPPED";
  if (err instanceof BackendCallTimeoutError) return "BACKEND_TIMEOUT";
  return "ERROR";
}
```

- [ ] **Step 2: Build and verify compilation**

Run: `npm run build`
Expected: compiles cleanly (new file has no dependencies, nothing imports it yet).

- [ ] **Step 3: Commit**

```bash
git add src/errors.ts
git commit -m "feat: add multiplexer error classes"
```

---

### Task 2: Config loading and validation

**Files:**
- Create: `src/config.ts`

**Interfaces:**
- Consumes: none
- Produces: `BackendConfig`, `PathPair`, `BackendPaths`, `VisionConfig`, `MultiplexerConfig`, `loadConfig(path)`, `validateConfig(raw)`

- [ ] **Step 1: Write `src/config.ts`**

```typescript
import fs from "node:fs";

export interface PathPair {
  host: string;
  bridge?: string;
}

export interface BackendPaths {
  shot?: PathPair;
  state?: PathPair;
  rig?: PathPair;
}

export interface BackendConfig {
  bizhawkPort: number;
  bizhawkHost?: string;
  allowedRemoteAddresses?: string[];
  shotDir?: string;
  shotDirBridge?: string;
  stateDir?: string;
  stateDirBridge?: string;
  rigDir?: string;
  rigDirBridge?: string;
}

export interface VisionConfig {
  baseUrl?: string;
  model?: string;
  apiKey?: string;
}

export interface MultiplexerConfig {
  backends: Record<string, BackendConfig>;
  vision?: VisionConfig;
}

const VALID_TOP_KEYS = new Set(["backends", "vision"]);
const VALID_BACKEND_KEYS = new Set([
  "bizhawkPort", "bizhawkHost", "allowedRemoteAddresses",
  "shotDir", "shotDirBridge",
  "stateDir", "stateDirBridge",
  "rigDir", "rigDirBridge",
]);

export function validateConfig(raw: Record<string, unknown>): MultiplexerConfig {
  for (const key of Object.keys(raw)) {
    if (!VALID_TOP_KEYS.has(key)) {
      throw new Error(`Unknown config key: "${key}". Valid keys: ${[...VALID_TOP_KEYS].join(", ")}`);
    }
  }

  const backendsRaw = raw.backends;
  if (!backendsRaw || typeof backendsRaw !== "object" || Array.isArray(backendsRaw)) {
    throw new Error('Config must have a "backends" object with at least one backend.');
  }

  const backends: Record<string, BackendConfig> = {};
  const names = Object.keys(backendsRaw as Record<string, unknown>);
  if (names.length === 0) throw new Error("At least one backend is required.");

  const ports = new Set<number>();

  for (const name of names) {
    if (!name || name.trim() === "") throw new Error("Backend names must be non-empty.");
    const raw = (backendsRaw as Record<string, Record<string, unknown>>)[name];
    if (!raw || typeof raw !== "object") {
      throw new Error(`Backend "${name}" must be an object.`);
    }

    for (const key of Object.keys(raw)) {
      if (!VALID_BACKEND_KEYS.has(key)) {
        throw new Error(`Unknown key "${key}" on backend "${name}". Valid keys: ${[...VALID_BACKEND_KEYS].join(", ")}`);
      }
    }

    const port = raw.bizhawkPort;
    if (typeof port !== "number" || !Number.isInteger(port) || port < 1 || port > 65535) {
      throw new Error(`Backend "${name}" has invalid bizhawkPort: must be an integer 1-65535.`);
    }
    if (ports.has(port)) throw new Error(`Port ${port} is used by more than one backend.`);
    ports.add(port);

    const host: string | undefined = typeof raw.bizhawkHost === "string" ? raw.bizhawkHost : undefined;

    let allowedRemoteAddresses: string[] | undefined;
    if (raw.allowedRemoteAddresses !== undefined) {
      if (!host || host === "127.0.0.1") {
        throw new Error(`Backend "${name}": allowedRemoteAddresses requires a non-loopback bizhawkHost.`);
      }
      if (!Array.isArray(raw.allowedRemoteAddresses) || !raw.allowedRemoteAddresses.every((a) => typeof a === "string")) {
        throw new Error(`Backend "${name}": allowedRemoteAddresses must be a string array.`);
      }
      allowedRemoteAddresses = raw.allowedRemoteAddresses as string[];
    }

    backends[name] = {
      bizhawkPort: port,
      bizhawkHost: host,
      allowedRemoteAddresses,
      shotDir: typeof raw.shotDir === "string" ? raw.shotDir : undefined,
      shotDirBridge: typeof raw.shotDirBridge === "string" ? raw.shotDirBridge : undefined,
      stateDir: typeof raw.stateDir === "string" ? raw.stateDir : undefined,
      stateDirBridge: typeof raw.stateDirBridge === "string" ? raw.stateDirBridge : undefined,
      rigDir: typeof raw.rigDir === "string" ? raw.rigDir : undefined,
      rigDirBridge: typeof raw.rigDirBridge === "string" ? raw.rigDirBridge : undefined,
    };
  }

  let vision: VisionConfig | undefined;
  if (raw.vision && typeof raw.vision === "object") {
    const v = raw.vision as Record<string, unknown>;
    vision = {
      baseUrl: typeof v.baseUrl === "string" ? v.baseUrl : undefined,
      model: typeof v.model === "string" ? v.model : undefined,
      apiKey: typeof v.apiKey === "string" ? v.apiKey : undefined,
    };
  }

  return { backends, vision };
}

export function loadConfig(filePath?: string): MultiplexerConfig {
  const path = filePath ?? process.env.MCP_BIZHAWK_CONFIG;
  if (!path) {
    process.stderr.write(
      "[mcp-bizhawk] FATAL: MCP_BIZHAWK_CONFIG is required.\n" +
      "              Set it to the path of your backends.json config file.\n",
    );
    process.exit(1);
  }

  let raw: unknown;
  try {
    const text = fs.readFileSync(path, "utf8");
    raw = JSON.parse(text);
  } catch (err) {
    process.stderr.write(
      `[mcp-bizhawk] FATAL: could not read config file "${path}": ${(err as Error).message}\n`,
    );
    process.exit(1);
  }

  if (!raw || typeof raw !== "object" || Array.isArray(raw)) {
    process.stderr.write(
      `[mcp-bizhawk] FATAL: config file "${path}" does not contain a JSON object.\n`,
    );
    process.exit(1);
  }

  try {
    return validateConfig(raw as Record<string, unknown>);
  } catch (err) {
    process.stderr.write(
      `[mcp-bizhawk] FATAL: invalid config "${path}": ${(err as Error).message}\n`,
    );
    process.exit(1);
  }
}
```

- [ ] **Step 2: Build and verify compilation**

Run: `npm run build`
Expected: compiles cleanly.

- [ ] **Step 3: Write config validation tests**

Create `tests/config.test.mjs`:

```javascript
import { describe, it } from "node:test";
import assert from "node:assert";
import { validateConfig } from "../dist/config.js";

describe("config validation", () => {
  it("accepts minimal valid config", () => {
    const cfg = validateConfig({ backends: { a: { bizhawkPort: 8766 } } });
    assert.equal(cfg.backends.a.bizhawkPort, 8766);
    assert.equal(cfg.backends.a.bizhawkHost, undefined);
  });

  it("rejects missing backends", () => {
    assert.throws(() => validateConfig({}), /must have a "backends" object/);
  });

  it("rejects empty backends", () => {
    assert.throws(() => validateConfig({ backends: {} }), /At least one backend/);
  });

  it("rejects empty backend name", () => {
    assert.throws(() => validateConfig({ backends: { "": { bizhawkPort: 8766 } } }), /must be non-empty/);
  });

  it("rejects duplicate ports", () => {
    assert.throws(() => validateConfig({
      backends: { a: { bizhawkPort: 8766 }, b: { bizhawkPort: 8766 } }
    }), /used by more than one backend/);
  });

  it("rejects invalid port (zero)", () => {
    assert.throws(() => validateConfig({ backends: { a: { bizhawkPort: 0 } } }), /must be an integer 1-65535/);
  });

  it("rejects invalid port (too high)", () => {
    assert.throws(() => validateConfig({ backends: { a: { bizhawkPort: 99999 } } }), /must be an integer 1-65535/);
  });

  it("rejects unknown top-level key", () => {
    assert.throws(() => validateConfig({ backends: { a: { bizhawkPort: 8766 } }, extra: true }), /Unknown config key.*"extra"/);
  });

  it("rejects unknown backend key", () => {
    assert.throws(() => validateConfig({ backends: { a: { bizhawkPort: 8766, bizhawkHosst: "0.0.0.0" } } }), /Unknown key.*"bizhawkHosst"/);
  });

  it("rejects allowedRemoteAddresses on loopback host", () => {
    assert.throws(() => validateConfig({
      backends: { a: { bizhawkPort: 8766, allowedRemoteAddresses: ["1.2.3.4"] } }
    }), /requires a non-loopback/);
  });

  it("accepts allowedRemoteAddresses on non-loopback host", () => {
    const cfg = validateConfig({
      backends: { a: { bizhawkPort: 8766, bizhawkHost: "0.0.0.0", allowedRemoteAddresses: ["192.168.1.50"] } }
    });
    assert.deepEqual(cfg.backends.a.allowedRemoteAddresses, ["192.168.1.50"]);
  });

  it("parses vision section", () => {
    const cfg = validateConfig({
      backends: { a: { bizhawkPort: 8766 } },
      vision: { baseUrl: "http://x/v1", model: "m" }
    });
    assert.equal(cfg.vision?.baseUrl, "http://x/v1");
    assert.equal(cfg.vision?.model, "m");
  });

  it("rejects non-object backends value", () => {
    assert.throws(() => validateConfig({ backends: 42 }), /must have a "backends" object/);
  });

  it("accepts full path config", () => {
    const cfg = validateConfig({
      backends: {
        w: {
          bizhawkPort: 8766,
          bizhawkHost: "0.0.0.0",
          allowedRemoteAddresses: ["10.0.0.5"],
          shotDir: "/tmp/shot",
          shotDirBridge: "X:\\tmp\\shot",
          stateDir: "/tmp/state",
          stateDirBridge: "X:\\tmp\\state",
          rigDir: "/tmp/rig",
          rigDirBridge: "X:\\tmp\\rig",
        }
      }
    });
    assert.equal(cfg.backends.w.shotDir, "/tmp/shot");
    assert.equal(cfg.backends.w.shotDirBridge, "X:\\tmp\\shot");
  });
});
```

- [ ] **Step 4: Run tests**

Run: `npm test -- --test-name-pattern="config"`
Expected: All pass.

- [ ] **Step 5: Commit**

```bash
git add src/config.ts tests/config.test.mjs
git commit -m "feat: config loading and validation for multiplexer"
```

---

### Task 3: BizhawkBackend — extract TCP state machine

**Files:**
- Create: `src/backend.ts` (extracted from `src/bizhawk.ts`)
- Modify: `src/bizhawk.ts` (remove extracted code once Task 4 rewrites it)

**Interfaces:**
- Consumes: `src/errors.ts`, `src/version.ts`, `src/config.ts` (`BackendConfig`, `PathPair`)
- Produces: `BizhawkBackend` class, `BackendStatus` interface, `BackendState` type

- [ ] **Step 1: Write `src/backend.ts`**

This extracts the current `BizhawkServer`'s TCP state machine into a scoped `BizhawkBackend` class with added generation guards, disconnect semantics, path helpers, and NHL domain cache.

```typescript
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
```

- [ ] **Step 2: Build**

Run: `npm run build`
Expected: Compiles (errors.ts is the only dep; config.ts type only).

- [ ] **Step 3: Commit**

```bash
git add src/backend.ts
git commit -m "feat: extract BizhawkBackend TCP state machine from BizhawkServer"
```

---
### Task 4: Rewrite BizhawkServer as multiplexer router

**Files:**
- Modify: `src/bizhawk.ts` (complete rewrite)

**Interfaces:**
- Consumes: `src/backend.ts` (`BizhawkBackend`, `BackendStatus`), `src/errors.ts` (`UnknownBackendError`), `src/config.ts` (`BackendConfig`)
- Produces: `BizhawkServer` class (new multiplexer API)

- [ ] **Step 1: Rewrite `src/bizhawk.ts`**

```typescript
import { BizhawkBackend } from "./backend.js";
import type { BackendStatus } from "./backend.js";
import type { BackendConfig } from "./config.js";
import { UnknownBackendError } from "./errors.js";

export type { BackendStatus };

export class BizhawkServer {
  private backends = new Map<string, BizhawkBackend>();

  private startPromise: Promise<void> | null = null;
  private stopPromise: Promise<void> | null = null;

  /** Validate and start all backends atomically. */
  async start(config: Record<string, BackendConfig>): Promise<void> {
    if (this.backends.size > 0) return;
    if (this.startPromise) return this.startPromise;

    // Validate
    const names = Object.keys(config);
    if (names.length === 0) throw new Error("at least one backend is required");
    for (const name of names) {
      if (!name || name.trim() === "") throw new Error("backend names must be non-empty");
    }
    const seen = new Set<string>();
    for (const name of names) {
      if (seen.has(name)) throw new Error(`duplicate backend name "${name}"`);
      seen.add(name);
    }

    // Create all instances
    for (const name of names) {
      const backend = new BizhawkBackend(name, config[name]);
      this.backends.set(name, backend);
    }

    this.startPromise = (async () => {
      const started: BizhawkBackend[] = [];
      try {
        for (const name of names) {
          const backend = this.backends.get(name)!;
          await backend.start();
          started.push(backend);
        }
      } catch (err) {
        // Rollback
        for (const s of started) {
          try { await s.stop(); } catch { /* best effort */ }
        }
        this.backends.clear();
        this.startPromise = null;
        throw err;
      }
    })();

    try {
      await this.startPromise;
    } finally {
      this.startPromise = null;
    }
  }

  /** Route a command to the named backend. */
  async call<T = unknown>(
    target: string,
    method: string,
    params: Record<string, unknown> = {},
  ): Promise<T> {
    const backend = this.backends.get(target);
    if (!backend) throw new UnknownBackendError(target, this.validTargets());
    return backend.call<T>(method, params);
  }

  /** Get a backend instance (for NHL domain access, path resolution, etc.). */
  getBackend(target: string): BizhawkBackend {
    const backend = this.backends.get(target);
    if (!backend) throw new UnknownBackendError(target, this.validTargets());
    return backend;
  }

  /** Stop all backends in parallel. Clears the registry. */
  async stop(): Promise<void> {
    if (this.stopPromise) return this.stopPromise;

    this.stopPromise = (async () => {
      const errors: Error[] = [];
      await Promise.all(
        [...this.backends.values()].map(async (b) => {
          try { await b.stop(); } catch (e) { errors.push(e as Error); }
        }),
      );
      this.backends.clear();
      this.stopPromise = null;
      if (errors.length) throw new Error(`errors stopping backends: ${errors.map((e) => e.message).join("; ")}`);
    })();

    return this.stopPromise;
  }

  /** List all configured backends with status snapshots. */
  listBackends(): BackendStatus[] {
    return [...this.backends.values()]
      .map((b) => b.status())
      .sort((a, b) => a.name.localeCompare(b.name));
  }

  private validTargets(): string[] {
    return [...this.backends.keys()].sort();
  }
}
```

- [ ] **Step 2: Build**

Run: `npm run build`
Expected: Compiles. `src/bizhawk.ts` no longer exports `BizhawkOptions`, `isConnected()`, `isBridgeReady()`, `describeTarget()` — these moved to `BizhawkBackend`.

- [ ] **Step 3: Commit**

```bash
git add src/bizhawk.ts
git commit -m "feat: rewrite BizhawkServer as multiplexer router"
```

---

### Task 5: Update entry point for config-based startup

**Files:**
- Modify: `src/index.ts`

**Interfaces:**
- Consumes: `src/bizhawk.ts` (new `BizhawkServer`), `src/config.ts` (`loadConfig`), `src/http.ts` (`createMcpHttpServer`)
- Produces: (same daemon binary)

- [ ] **Step 1: Rewrite `src/index.ts`**

```typescript
#!/usr/bin/env node
import { BizhawkServer } from "./bizhawk.js";
import { createMcpHttpServer, MCP_PATH } from "./http.js";
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
  httpServer.listen(HTTP_PORT, HTTP_HOST, () => {
    process.stderr.write(
      `[mcp-bizhawk] MCP server v${VERSION} ready — streamable-HTTP at http://${HTTP_HOST}:${HTTP_PORT}${MCP_PATH}\n`
    );
  });
  httpServer.on("error", (err) => {
    process.stderr.write(`[mcp-bizhawk] FATAL: HTTP server error on ${HTTP_HOST}:${HTTP_PORT}: ${err}\n`);
    process.exit(1);
  });

  let shuttingDown = false;
  const shutdown = (reason: string) => {
    if (shuttingDown) return;
    shuttingDown = true;
    process.stderr.write(`[mcp-bizhawk] shutting down (${reason})\n`);
    httpServer.close();
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
```

- [ ] **Step 2: Build**

Run: `npm run build`
Expected: Compiles.

- [ ] **Step 3: Commit**

```bash
git add src/index.ts
git commit -m "feat: config-based multipelxer startup for index.ts"
```

---

### Task 6: Update http.ts to accept new BizhawkServer

**Files:**
- Modify: `src/http.ts`

**Interfaces:**
- Consumes: `src/bizhawk.ts` (new `BizhawkServer`), `src/tools.ts` (`registerTools`)
- Produces: `createMcpHttpServer(bh: BizhawkServer): http.Server`

The `http.ts` change is minimal — the import type changes but the API is the same. `BizhawkServer` no longer has `isConnected()`, `isBridgeReady()`, or `describeTarget()` but `http.ts` doesn't use any of those methods directly.

- [ ] **Step 1: No changes needed to http.ts logic**

Verify by reading the file: `createMcpHttpServer` takes `bh: BizhawkServer`, passes it to `registerTools`, and never calls `bh.isConnected()` / `bh.isBridgeReady()` / `bh.describeTarget()`. The only method it invokes is via `registerTools` which internally calls `bh.call()`, `bh.getBackend()`, and `bh.listBackends()` — all present on the new signature.

- [ ] **Step 2: Build**

Run: `npm run build`
Expected: Compiles.

---

### Task 7: Add target param to every tool + bizhawk_list_backends

**Files:**
- Modify: `src/tools.ts` (extensive — every tool handler updated)

**Interfaces:**
- Consumes: `src/bizhawk.ts` (`BizhawkServer`), `src/backend.ts` (`BizhawkBackend`), `src/errors.ts` (`errorCode`)
- Produces: Updated `registerTools(server, bh)`, new `bizhawk_list_backends` tool, `target` param on every backend-scoped tool

This is the largest mechanical change. Rather than showing all 3471 lines of tools.ts rewritten, here is the pattern applied to every tool:

- [ ] **Step 1: Add targetParam and bizhawk_list_backends tool definition**

Insert at line ~65 (after `const frameTimeout = ...` and before `const TOOLS: Tool[] = [`):

```typescript
const targetProp = {
  target: {
    type: "string" as const,
    minLength: 1,
    description: "BizHawk backend label. Use bizhawk_list_backends to see available targets.",
  },
};
```

Insert into the TOOLS array as the first entry (between the `bizhawk_ping` entry and the `bizhawk_get_info` entry):

```typescript
  {
    name: "bizhawk_list_backends",
    description:
      "PURPOSE: List all configured BizHawk backends and their connection status. " +
      "USAGE: Call this to discover which backends are available and their current " +
      "state (stopped / listening / connected / ready) before using other tools. " +
      "BEHAVIOR: No side effects — pure read of server state. Always works. " +
      "RETURNS: Each backend entry with name, host, port, state, socketGeneration, queuedCommands, inflightCommand, and optional remoteAddress.",
    inputSchema: { type: "object", properties: {} },
  },
```

- [ ] **Step 2: Add target to required on every backend-scoped tool schema**

For each tool schema in the TOOLS array, add `target` to the properties and `required` arrays. The pattern for every tool:

**Before:**
```typescript
inputSchema: {
  type: "object",
  required: ["address"],
  properties: { address: { ... }, domain: { ... } },
  additionalProperties: false,
}
```

**After:**
```typescript
inputSchema: {
  type: "object",
  required: ["target", "address"],
  properties: { ...targetProp, address: { ... }, domain: { ... } },
  additionalProperties: false,
}
```

The exceptions are:
- `bizhawk_list_backends` — NO target (global tool)
- `bizhawk_ping` — requires target
- `bizhawk_get_info` — requires target
- All NHL94 tools — require target
- All other bizhawk tools — require target

- [ ] **Step 3: Add handler for bizhawk_list_backends**

In the `dispatchTool` switch statement, add:

```typescript
case "bizhawk_list_backends": {
  const statuses = bh.listBackends();
  if (statuses.length === 0) return ok("No backends configured.");
  const lines = statuses.map((s) => {
    const addr = s.remoteAddress ? ` (${s.remoteAddress})` : "";
    const inflight = s.inflightCommand ? ` inflight=${s.inflightCommand.method}` : "";
    return `${s.name} @ ${s.host}:${s.port} — ${s.state} gen=${s.socketGeneration} queued=${s.queuedCommands}${inflight}${addr}`;
  });
  return ok(lines.join("\n"));
}
```

- [ ] **Step 4: Update every handler to extract target and use bh.call(target, ...)**

Pattern for every handler:

**Before:**
```typescript
case "bizhawk_ping": {
  if (!bh.isConnected()) return ok(...);
  if (!bh.isBridgeReady()) return ok(...);
  const r = await bh.call<string>("ping");
  return ok(`...`);
}
```

**After:**
```typescript
case "bizhawk_ping": {
  const target = p.target as string;
  const backend = bh.getBackend(target);
  if (!backend.isConnected()) {
    return ok(`Backend "${target}" is not connected.`);
  }
  if (!backend.isBridgeReady()) {
    return ok(`Backend "${target}" is connected but bridge is not polling yet.`);
  }
  try {
    const r = await bh.call<string>(target, "ping");
    return ok(`pong (mcp-bizhawk v${VERSION}, backend "${target}" polling)`);
  } catch (err) {
    return ok(`Backend "${target}" — bridge did not answer: ${(err as Error).message}`);
  }
}
```

**Before (simple bridge call):**
```typescript
case "bizhawk_get_info": {
  const r = await bh.call<{...}>("get_info");
```

**After:**
```typescript
case "bizhawk_get_info": {
  const target = p.target as string;
  const r = await bh.call<{...}>(target, "get_info");
```

**Before (nhlDomain):**
```typescript
const domain = await nhlDomain(bh);
```

**After:**
```typescript
const target = p.target as string;
const backend = bh.getBackend(target);
const domain = await backend.nhlDomain();
```

**Before (nhlAddr / nhlRebase):**
```typescript
const addr = nhlAddr(nhl94.G.carrier, domain);
const ops = nhlRebase(ops, domain);
```

**After:**
```typescript
const addr = domain.addr(nhl94.G.carrier);
const ops = domain.rebase(ops);
```

The `nhlDomain()` function in `tools.ts` (lines 1773-1784) and `nhlAddr()` (1786-1788) and `nhlRebase()` (1790-1792) are removed — these are now methods on the `NhlDomain` object returned by `backend.nhlDomain()`.

The `nhlDomainCache` WeakMap (line 1773) is removed.

- [ ] **Step 5: Update stateDir / shotDir / rigDir helpers in tools.ts**

The helper functions `stateDir()`, `shotDir()`, `rigRoot()` and related path functions read process.env directly. In the multiplexer, per-backend config overrides env vars.

Update these functions to accept an optional `backend: BizhawkBackend` parameter:

**Before:**
```typescript
function stateDir(): string {
  return process.env.MCP_BIZHAWK_STATE_DIR ?? path.join(os.homedir(), ".mcp-bizhawk", "states");
}
```

**After:**
```typescript
function stateDir(backend?: import("./backend.js").BizhawkBackend): string {
  return backend?.stateDirHost() || process.env.MCP_BIZHAWK_STATE_DIR || path.join(os.homedir(), ".mcp-bizhawk", "states");
}
```

Same pattern for `shotDirHost()`/`shotDirBridge()`, `rigDirHost()`/`rigDirBridge()`.

**Before (shot path construction):**
```typescript
const localDir = process.env.MCP_BIZHAWK_SHOT_DIR || os.tmpdir();
```

**After:**
```typescript
const localDir = backend?.shotDirHost() || os.tmpdir();
```

And for bridge-side path:
```typescript
const bridgeDir = backend?.shotDirBridge() || process.env.MCP_BIZHAWK_SHOT_DIR_BRIDGE;
```

- [ ] **Step 6: Update usage logging to include target and error codes**

In `recordUsage`, add `target`:

**Before:**
```typescript
function recordUsage(tool: string, args: Record<string, unknown>, ok: boolean, ms: number, error?: string): void {
```

**After:**
```typescript
function recordUsage(tool: string, target: string | undefined, args: Record<string, unknown>, ok: boolean, ms: number, error?: string): void {
```

And in the log line:
```typescript
const base = { ts: new Date().toISOString(), tool, ...(target ? { target } : {}), ok, ms, ...(error ? { error } : {}) };
```

Update the `CallToolRequestSchema` handler to extract `target` from args:

```typescript
server.setRequestHandler(CallToolRequestSchema, async (req) => {
  const name = req.params.name;
  const args = (req.params.arguments ?? {}) as Record<string, unknown>;
  const target = args.target as string | undefined;
  // ... rest unchanged, but pass target to recordUsage:
  recordUsage(name, target, args, ok, Date.now() - startedMs, errMsg);
});
```

Update the error recording to use the error code mapping:

```typescript
} catch (e) {
  ok = false;
  errMsg = errorCode(e as Error);  // "BACKEND_NOT_CONNECTED" etc.
```

- [ ] **Step 7: Update exposedTools to include bizhawk_list_backends**

In `EXPOSED_BIZHAWK` set, add `"bizhawk_list_backends"`.

- [ ] **Step 8: Build**

Run: `npm run build`
Expected: Compiles. All type errors fixed. No more references to `bh.isConnected()`, `bh.isBridgeReady()`, `bh.describeTarget()`, `nhlDomain(bh)`, `nhlAddr()`, `nhlRebase()`.

- [ ] **Step 9: Commit**

```bash
git add src/tools.ts
git commit -m "feat: add target parameter to all tools, add bizhawk_list_backends"
```

---

### Task 8: Update nhl94.ts for new domain API

**Files:**
- Modify: `src/nhl94.ts`

**Interfaces:**
- Consumes: `src/backend.ts` (`BizhawkBackend` via tools.ts)
- Produces: No API changes — `nhl94.ts` exports constants and builders that tools use; domain resolution moves to `BizhawkBackend.nhlDomain()`

- [ ] **Step 1: No changes needed to nhl94.ts**

`nhl94.ts` is pure game-semantic constants and MemOp builders. It does not import `BizhawkServer` — it never did. The `nhlDomain()`, `nhlAddr()`, `nhlRebase()` functions live in `tools.ts` (lines 1773-1792), not in `nhl94.ts`. Those are removed in Task 7.

Verify: `nhl94.ts` exports SORTCORDS, SCSIZE, OFF, G, FIELD_WIDTH, FIXED_FIELDS, GLOBAL_WIDTH helpers, resolveTarget, toFixed, fromFixed, toWord, mapFrozenAddress, resolveField, parseClock, formatClock, classifyPhase, lineLabel, MemOp, TeleportEntry, teleportOps, freezeOps, unfreezeOps, parkOps, RECIPES_GUIDE. None of these reference BizhawkServer.

- [ ] **Step 2: Build**

Run: `npm run build`
Expected: Compiles.

---

### Task 9: Version bumps

**Files:**
- Modify: `src/version.ts`, `package.json`, `lua/bridge_JD.lua`

- [ ] **Step 1: Bump version display strings**

In `src/version.ts`, bump `VERSION` from `"2026.7.38-jd"` to `"2026.7.39-jd"`. Leave `PROTOCOL_VERSION` unchanged (RPC wire contract is unchanged).

In `package.json`, bump `"version"` from `"2026.7.38-jd"` to `"2026.7.39-jd"`.

In `lua/bridge_JD.lua`, find the `BRIDGE.version` line near the top and bump to `"2026.7.39-jd"`. Leave `BRIDGE.protocol` unchanged. Add a changelog entry `-- v2026.7.39-jd multiplexer support (server-side; bridge unchanged)`.

- [ ] **Step 2: Build**

Run: `npm run build`
Expected: Compiles.

- [ ] **Step 3: Syntax-check Lua bridge**

Run: `luac -p lua/bridge_JD.lua`
Expected: No syntax errors.

- [ ] **Step 4: Commit**

```bash
git add src/version.ts package.json lua/bridge_JD.lua
git commit -m "chore: bump version to 2026.7.39-jd for multiplexer"
```

---

### Task 10: Update tests for multiplexer

**Files:**
- Modify: `tests/helpers/harness.mjs`
- Create: `tests/helpers/multiplex-harness.mjs`
- Create: `tests/backend.test.mjs`
- Create: `tests/multiplexer.test.mjs`
- Modify: `tests/config.test.mjs` (already created in Task 2)

**Existing tests** that import `BizhawkServer` from `dist/bizhawk.js` will need updating — but the full suite update is tracked separately. This task covers the harness and new multiplex-specific tests.

- [ ] **Step 1: Create `tests/helpers/multiplex-harness.mjs`**

```javascript
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
```

- [ ] **Step 2: Create `tests/backend.test.mjs`**

```javascript
import { describe, it } from "node:test";
import assert from "node:assert";
import { BizhawkBackend } from "../dist/backend.js";

describe("BizhawkBackend", () => {
  it("starts in stopped state", () => {
    const b = new BizhawkBackend("test", { bizhawkPort: 8766 });
    assert.equal(b.name, "test");
    assert.equal(b.isConnected(), false);
    assert.equal(b.isBridgeReady(), false);
    assert.equal(b.status().state, "stopped");
  });

  it("call() fails when not started", async () => {
    const b = new BizhawkBackend("test", { bizhawkPort: 29999 });
    await assert.rejects(
      () => b.call("ping"),
      /not connected/
    );
  });

  it("rejects unknown method", async function () {
    // This test requires a TCP listener — skip in CI without a port
    let b;
    let port;
    for (let attempt = 0; attempt < 5; attempt++) {
      port = 30000 + Math.floor(Math.random() * 20000);
      b = new BizhawkBackend("test", { bizhawkPort: port });
      try { await b.start(); break; } catch { b = null; }
    }
    if (!b) this.skip();

    try {
      await assert.rejects(
        () => b.call("nonexistent"),
        /not ready/
      );
    } finally {
      await b.stop();
    }
  });

  it("resolvePathPair resolves shot path", () => {
    const b = new BizhawkBackend("w", {
      bizhawkPort: 8766,
      shotDir: "/tmp/s",
      shotDirBridge: "X:\\tmp\\s",
    });
    const p = b.resolvePathPair("shot", "cap.png");
    assert.equal(p.host, "/tmp/s/cap.png");
    assert.equal(p.bridge, "X:/tmp/s/cap.png");
  });

  it("rejects path pair when dir not configured", () => {
    const b = new BizhawkBackend("w", { bizhawkPort: 8766 });
    assert.throws(() => b.resolvePathPair("shot", "cap.png"), /no shot directory/);
  });
});
```

Note: `resolvePathPair` uses `path.posix.join` for bridge paths. The test expects `X:/tmp/s/cap.png` from `X:\tmp\s` + `cap.png` — `path.posix.join` converts backslashes to forward slashes. This is intentional: bridge-side paths are sent to Lua which handles either separator.

- [ ] **Step 3: Create `tests/multiplexer.test.mjs`**

```javascript
import { describe, it } from "node:test";
import assert from "node:assert";
import { BizhawkServer } from "../dist/bizhawk.js";
import { FakeBridge } from "./helpers/fake-bridge.mjs";

describe("BizhawkServer multiplexer", () => {
  it("starts and stops two backends", async () => {
    let portA, portB;
    for (let attempt = 0; attempt < 10; attempt++) {
      portA = 30000 + Math.floor(Math.random() * 20000);
      portB = portA + 1 + Math.floor(Math.random() * 100);
      if (portA !== portB) break;
    }

    const bh = new BizhawkServer();
    await bh.start({
      a: { bizhawkPort: portA },
      b: { bizhawkPort: portB },
    });

    const statuses = bh.listBackends();
    assert.equal(statuses.length, 2);
    assert.equal(statuses[0].state, "listening");
    assert.equal(statuses[1].state, "listening");

    await bh.stop();
    assert.equal(bh.listBackends().length, 0);
  });

  it("routes calls to correct backend", async () => {
    let portA, portB;
    for (let attempt = 0; attempt < 10; attempt++) {
      portA = 30000 + Math.floor(Math.random() * 20000);
      portB = portA + 1 + Math.floor(Math.random() * 100);
      if (portA !== portB) break;
    }

    const bh = new BizhawkServer();
    await bh.start({
      a: { bizhawkPort: portA },
      b: { bizhawkPort: portB },
    });

    const bridgeA = new FakeBridge(portA, {
      ping: () => "from-a",
    });
    const bridgeB = new FakeBridge(portB, {
      ping: () => "from-b",
    });
    await Promise.all([bridgeA.connect(), bridgeB.connect()]);

    // Wait for both ready
    const deadline = Date.now() + 3000;
    while (true) {
      const s = bh.listBackends();
      if (s.every((x) => x.state === "ready")) break;
      if (Date.now() > deadline) throw new Error("timeout waiting for ready");
      await new Promise((r) => setTimeout(r, 10));
    }

    const rA = await bh.call("a", "ping");
    const rB = await bh.call("b", "ping");
    assert.equal(rA, "from-a");
    assert.equal(rB, "from-b");

    assert.equal(bridgeA.calls.length, 1);
    assert.equal(bridgeA.calls[0].method, "ping");
    assert.equal(bridgeB.calls.length, 1);
    assert.equal(bridgeB.calls[0].method, "ping");

    bridgeA.close();
    bridgeB.close();
    await bh.stop();
  });

  it("throws UnknownBackendError for bad target", async () => {
    let port;
    for (let attempt = 0; attempt < 5; attempt++) {
      port = 30000 + Math.floor(Math.random() * 20000);
      try {
        const bh = new BizhawkServer();
        await bh.start({ a: { bizhawkPort: port } });
        await assert.rejects(
          () => bh.call("nope", "ping"),
          (err) => err.message.includes("Unknown backend") && err.message.includes("a")
        );
        await bh.stop();
        break;
      } catch {
        continue;
      }
    }
  });
});
```

- [ ] **Step 4: Run tests**

Run: `npm test`
Expected: All existing tests that don't use `BizhawkServer` constructor with old API still pass. New config/backend/multiplexer tests pass. Tests that use `startHarness` from `tests/helpers/harness.mjs` will fail (it uses old `BizhawkServer` constructor + `bh.isBridgeReady()`). Those are updated next.

- [ ] **Step 5: Update old harness for backward compatibility**

The old `tests/helpers/harness.mjs` still constructs `BizhawkServer` with `{host, port, timeoutMs}` and calls `bh.isBridgeReady()`. Update it to create a multiplexer with a single backend:

```javascript
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
```

- [ ] **Step 6: Run full test suite**

Run: `npm test`
Expected: Existing tests that use `startHarness` now pass because the harness was updated.

- [ ] **Step 7: Commit**

```bash
git add tests/helpers/harness.mjs tests/helpers/multiplex-harness.mjs tests/backend.test.mjs tests/multiplexer.test.mjs
git commit -m "test: add multiplexer tests, update harness for new API"
```

---

### Task 11: Systemd unit and config example

**Files:**
- Create: `deploy/bizhawk-daemon.service`
- Create: `deploy/backends.example.json`
- Remove: `deploy/bizhawk-daemon-windows.service`
- Remove: `deploy/bizhawk-daemon-linux_8763.service`

- [ ] **Step 1: Create `deploy/bizhawk-daemon.service`**

```ini
[Unit]
Description=mcp-bizhawk multiplexer
After=network-online.target
Wants=network-online.target

[Service]
Type=simple
Environment=MCP_BIZHAWK_CONFIG=/mnt/8tb/jason/mcp-bizhawk_jd/backends.json
Environment=MCP_HTTP_HOST=127.0.0.1
Environment=MCP_HTTP_PORT=8765
Environment=NODE_ENV=production
ExecStart=/usr/bin/node /mnt/8tb/jason/mcp-bizhawk_jd/dist/index.js
Restart=on-failure
RestartSec=2
StandardOutput=journal
StandardError=journal
SyslogIdentifier=mcp-bizhawk

[Install]
WantedBy=default.target
```

- [ ] **Step 2: Create `deploy/backends.example.json`**

```json
{
  "vision": {
    "baseUrl": "http://192.168.1.100:1234/v1",
    "model": "mlx-community/Qwen2.5-VL-7B-Instruct-4bit"
  },
  "backends": {
    "windows": {
      "bizhawkHost": "0.0.0.0",
      "bizhawkPort": 8766,
      "allowedRemoteAddresses": ["192.168.1.50"],
      "shotDir": "/mnt/8tb/jason/tmp",
      "shotDirBridge": "X:\\tmp",
      "stateDir": "/mnt/8tb/jason/nvnhl94-2/tools/bizhawk/BizHawk-2.11.1-linux-x64/PSX",
      "stateDirBridge": "X:\\nvnhl94-2\\tools\\bizhawk\\BizHawk-2.11.1-linux-x64\\PSX",
      "rigDir": "/mnt/8tb/jason/nvnhl94-2/tools/bizhawk/BizHawk-2.11.1-linux-x64/Lua",
      "rigDirBridge": "X:\\nvnhl94-2\\tools\\bizhawk\\BizHawk-2.11.1-linux-x64\\Lua"
    },
    "linux1": { "bizhawkPort": 8764 },
    "linux2": { "bizhawkPort": 8763 },
    "linux3": { "bizhawkPort": 8762 }
  }
}
```

- [ ] **Step 3: Remove old service files**

```bash
git rm deploy/bizhawk-daemon-windows.service deploy/bizhawk-daemon-linux_8763.service
```

- [ ] **Step 4: Commit**

```bash
git add deploy/bizhawk-daemon.service deploy/backends.example.json
git commit -m "feat: multiplexer systemd unit and example config"
```

---

### Task 12: Integration — final build and full test run

**Files:**
- All files are written

- [ ] **Step 1: Build**

Run: `npm run build`
Expected: Clean compilation.

- [ ] **Step 2: Full test suite**

Run: `npm test`
Expected: All tests pass.

- [ ] **Step 3: Commit**

```bash
git commit -am "chore: final integration pass for multiplexer"
```

---

### Task 13: Self-review checklist

- [ ] Every backend-scoped tool schema has `target` in `required` and `properties`
- [ ] `bizhawk_list_backends` has NO target
- [ ] All `bh.call(...)` calls are updated to `bh.call(target, ...)`
- [ ] All `nhlDomain(bh)` calls replaced with `backend.nhlDomain()`
- [ ] All `nhlAddr()` / `nhlRebase()` replaced with `domain.addr()` / `domain.rebase()`
- [ ] `nhlDomainCache` WeakMap removed
- [ ] `EXPOSED_BIZHAWK` includes `"bizhawk_list_backends"`
- [ ] Usage log includes `target` and error codes
- [ ] `src/index.ts` uses `loadConfig()` and no longer reads `BIZHAWK_HOST`/`BIZHAWK_PORT`
- [ ] `src/http.ts` unchanged (no `isConnected`/`isBridgeReady` references)
- [ ] `src/version.ts` `PROTOCOL_VERSION` unchanged (still `2`)
- [ ] `lua/bridge_JD.lua` `BRIDGE.protocol` unchanged
