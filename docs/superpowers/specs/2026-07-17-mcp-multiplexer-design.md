# MCP-BizHawk Multiplexer Design

**Date**: 2026-07-17
**Goal**: Evolve the single-BizHawk proxy into a multiplexer that presents one MCP server fronting N BizHawk backends, with every backend-scoped tool taking a `target` parameter.

## Architecture Overview

```
Config file → BizhawkServer.start() → N BizhawkBackend instances
                                         │
                                         ├── BizhawkBackend("windows") :8766 → Windows BizHawk
                                         ├── BizhawkBackend("linux1")  :8764 → Linux BizHawk
                                         ├── BizhawkBackend("linux2")  :8763 → Linux BizHawk
                                         └── BizhawkBackend("linux3")  :8762 → Linux BizHawk

HTTP /mcp → tools.ts → bh.call(target, method, params) → BizhawkBackend.call()
```

**Key separation**: `BizhawkServer` owns a registry of `BizhawkBackend` instances. Each backend independently owns its `net.Server` listener, socket, request queue, inflight command, handshake state, reconnect lifecycle, path mappings, and NHL domain state. The HTTP/MCP layer is unchanged — it still binds a single `BizhawkServer`.

## Core Classes

### BizhawkBackend

Extracted from the current `BizhawkServer`'s TCP state machine. Represents a persistent backend endpoint, not a single TCP connection.

```
stopped ──start──▶ listening ──accept──▶ connected ──READY──▶ ready
   ▲                   ▲                    │                  │
   │                   └──── disconnect ────┴──────────────────┘
   └──────────────────────── stop ─────────────────────────────
```

States:
- `stopped`: no listener, no socket
- `listening`: `net.Server` bound, waiting for bridge to dial
- `connected`: socket accepted, HELLO/READY handshake in progress
- `ready`: bridge has completed handshake and is accepting commands

Per-connection state (extracted from current `BizhawkServer`):
- `socket`, `socketGeneration`: guards stale callbacks
- `buf`: line buffer
- `queue`, `inflight`, `awaitingResult`: command pipeline
- `bridgeReady`, `helloSent`: handshake state
- `nextId`: monotonic command ID (never reset across reconnects)

#### Disconnect semantics
- Reject inflight and all queued calls with `BackendDisconnectedError`
- Clear `buf`, reset `bridgeReady`, `helloSent`
- Clear NHL domain cache
- Keep listener running — bridge reconnects, handshake repeats
- New `socketGeneration` on each accept

#### call() gating
```
call() only succeeds in state "ready"
  "stopped"/"listening" → BackendNotConnectedError
  "connected"           → BackendNotReadyError
  "ready"               → enqueue
```

#### Command timeout (end-to-end deadline)
Timeout starts when `call()` is invoked (includes queue time). A command that sits queued behind other work still has a finite deadline.

```typescript
const CALL_TIMEOUT_MS = 10_000           // general commands
const FRAME_CALL_TIMEOUT_MS = 3_000      // fast operations (read_many, etc.)
```

Frame-scaled commands (frame_advance, play_input_sequence) use their existing formula (20ms/frame + margin).

#### Queue cap
```typescript
const MAX_QUEUED_COMMANDS = 100
```
`call()` throws if `queue.length >= MAX_QUEUED_COMMANDS`. Prevents unbounded accumulation against a slow or stuck backend.

#### Stale socket guards
- Every socket callback checks `socket !== this.socket` before mutating
- Timeout callbacks check both `socketGeneration` and `inflight` command identity
- Centralized `detachSocket(socket, generation, cause)` for idempotent cleanup
- `stop()` invalidates generation before closing — prevents disconnection callbacks from firing `BackendDisconnectedError` during intentional shutdown

#### Second-client rejection
If a bridge connects while a socket is already active and healthy:
```
newSocket.end("BUSY\n"); newSocket.destroy(); return;
```
If the old socket is already destroyed, normal replacement is fine.

#### Handshake timeout
A `connected` socket that never reaches `READY` is detached after a fixed timeout:

```typescript
const HANDSHAKE_TIMEOUT_MS = 5_000
```

On expiry: `connected → detachSocket() → listening`. Prevents a dead client from occupying the backend and causing every legitimate reconnect to receive `BUSY`.

#### Lifecycle serialization
- Concurrent `start()` calls return the same promise
- Concurrent `stop()` calls return the same promise
- `start()` does not race an in-progress `stop()`
- Failed `start()` resets and leaves backend stopped

#### Remote listener protection
Backends bound to anything other than `127.0.0.1` must specify allowed peer addresses:

```json
{
  "bizhawkHost": "0.0.0.0",
  "bizhawkPort": 8766,
  "allowedRemoteAddresses": ["192.168.1.50"]
}
```

Unauthorized sockets are rejected before the handshake starts:
```
newSocket.end("UNAUTHORIZED\n"); newSocket.destroy(); return;
```

When `bizhawkHost` is `127.0.0.1` (default), no restriction is applied.

#### NHL domain cache

Owned by `BizhawkBackend`, keyed by socket generation so a reconnect (new ROM) invalidates it:

```typescript
class BizhawkBackend {
  private nhlDomainCache: { generation: number; domain: NhlDomain } | null = null

  nhlDomain(): NhlDomain {
    this.assertReady()
    const cached = this.nhlDomainCache
    if (cached?.generation === this.socketGeneration) return cached.domain
    const domain = new NhlDomain(this)
    this.nhlDomainCache = { generation: this.socketGeneration, domain }
    return domain
  }
}
```

`detachSocket()` sets `this.nhlDomainCache = null`.

#### Backend path ownership

Each backend understands how its emulator machine sees screenshots, savestates, and Lua rig files:

```typescript
interface PathPair { host: string; bridge?: string }
interface BackendPaths { shot?: PathPair; state?: PathPair; rig?: PathPair }
```

Helper methods for tools:

```typescript
backend.resolvePathPair(kind: "shot" | "state" | "rig", filename: string): PathPair
```

For the Windows backend `resolvePathPair("shot", "capture-001.png")` returns:
```
{ host: "/mnt/8tb/jason/tmp/capture-001.png", bridge: "X:\\tmp\\capture-001.png" }
```

Path precedence:
1. Explicit path argument in the tool call (used verbatim)
2. Backend config dir + filename
3. Omitted — bridge uses its own env-var / Lua default

### BizhawkServer (multiplexer)

Thin router — no TCP, no protocol.

```
start(config: Record<string, BackendConfig>): Promise<void>
call<T>(target: string, method: string, params?: unknown): Promise<T>
getBackend(target: string): BizhawkBackend
stop(): Promise<void>
listBackends(): BackendStatus[]
```

- **`start()`**: validates all backends (names unique/nonempty, ports unique), creates all instances, calls each `backend.start()`. First failure rolls back already-started backends and clears the registry. Atomic all-or-nothing.
- **`call()`**: looks up backend by `target`, throws `UnknownBackendError(validTargets=[...])` on miss, delegates to `backend.call()`.
- **`getBackend()`**: same lookup, returns the `BizhawkBackend` instance. Used by NHL tools for `nhlDomain()` and path resolution. Same `UnknownBackendError` on miss.
- **`stop()`**: calls all backends in parallel, aggregates errors. Clears the registry after completion.
- **`listBackends()`**: iterates all, returns `BackendStatus[]` snapshots in alphabetical order.

#### Server lifecycle semantics
- Concurrent `start()` calls share one startup promise.
- A failed `start()` stops all successfully started backends and clears the registry.
- Concurrent `stop()` calls share one shutdown promise.
- Restarting after a completed `stop()` is supported (creates new backends from the same config).
- `listBackends()` ordering is alphabetical by name.
- `stop()` clears the registry entirely — the map always represents the active configuration.

#### BackendStatus shape (returned by listBackends / bizhawk_list_backends)

```typescript
interface BackendStatus {
  name: string
  host: string
  port: number
  state: "stopped" | "listening" | "connected" | "ready"
  socketGeneration: number
  queuedCommands: number
  inflightCommand: { id: number; method: string } | null
  remoteAddress?: string
}
```

## Config File

Single JSON file (path from `MCP_BIZHAWK_CONFIG` env var). **Required** — if unset, empty, unreadable, or invalid, the daemon logs a fatal error, does not bind the HTTP server, and exits nonzero. `BIZHAWK_HOST` and `BIZHAWK_PORT` env vars are no longer read.

Parsed and validated in `src/config.ts` before passing to `BizhawkServer.start()`.

```json
{
  "vision": {
    "baseUrl": "http://192.168.1.100:1234/v1",
    "model": "mlx-community/Qwen2.5-VL-7B-Instruct-4bit"
  },
  "backends": {
    "windows": {
      "bizhawkPort": 8766,
      "bizhawkHost": "0.0.0.0",
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

- `bizhawkPort`: required per backend
- `bizhawkHost`: defaults to `127.0.0.1`
- `allowedRemoteAddresses`: only valid when `bizhawkHost` is not `127.0.0.1`
- Per-backend `shotDir`/`stateDir`/`rigDir` (and `*Bridge` variants): per-backend defaults for path resolution. If omitted, tools fall back to env vars or Lua defaults.
- `vision`: optional global section, falls back to `VISION_*` env vars
- `MCP_HTTP_PORT`: stays as `MCP_HTTP_PORT` env var (not in config file, for systemd port binding)

### Config validation
- `MCP_BIZHAWK_CONFIG` is required
- File must exist and parse as valid JSON
- Backend names: nonempty, unique
- Ports: valid integers, unique
- Unknown top-level keys: rejected
- Unknown backend keys: rejected (typo detection > forward compatibility)
- At least one backend
- `allowedRemoteAddresses` is only valid with non-loopback `bizhawkHost`

## Error Hierarchy

```typescript
class BizhawkError extends Error {}
class UnknownBackendError extends BizhawkError {}
class BackendNotConnectedError extends BizhawkError {}
class BackendNotReadyError extends BizhawkError {}
class BackendDisconnectedError extends BizhawkError {}
class BackendStoppedError extends BizhawkError {}
class BackendCallTimeoutError extends BizhawkError {}
```

## Tool Surface Changes

### target parameter
Every backend-scoped tool's `inputSchema` gains a required `target` property:
```typescript
target: z.string().min(1).describe("BizHawk backend label (use bizhawk_list_backends to see available)")
```

A shared `targetParam` exported from `src/tools.ts` is spread into every tool schema. Handlers destructure `{ target, ...params }` and call `bh.call(target, method, params)`.

The global discovery tool `bizhawk_list_backends` takes **no `target`**.

### New tool: bizhawk_list_backends
```
name: bizhawk_list_backends
description: List all configured backends and their connection status
parameters: none (no target required)
returns: BackendStatus[] snapshot
```

### NHL94 tools
`nhlDomain()` call moves to `BizhawkBackend.nhlDomain()` — cached per backend with generation guard, invalidated on disconnect. Tools call `bh.getBackend(target).nhlDomain()` instead of the current `nhlDomain(bh)`.

Path-dependent tools (screenshots, save/load state, rigs) call `bh.getBackend(target).resolvePathPair(kind, filename)` for host/bridge path resolution.

### Usage logging
Usage log path stays per-MCP-port (`~/.mcp-bizhawk/usage/usage-{port}.jsonl`). Every entry now includes the selected backend:

```json
{ "target": "windows", "tool": "nhl94_state", "ok": true, "ms": 452, "args": {...} }
```

On failure, includes a normalized error code:

```json
{ "target": "linux2", "tool": "bizhawk_load_state", "ok": false, "ms": 89, "args": {...}, "error": "BACKEND_DISCONNECTED" }
```

## Version Handling

- `PROTOCOL_VERSION` in `src/version.ts` and `BRIDGE.protocol` in `lua/bridge_JD.lua` remain un-bumped — the RPC wire contract is unchanged.
- `VERSION` (display string) is bumped in `src/version.ts`, `package.json`, and `lua/bridge_JD.lua`.
- The bridge version bump adds a `-- vYYYY.M.NN-jd` changelog entry; nothing else changes in the bridge.

## File Changes

| File | Change |
|------|--------|
| `src/errors.ts` | **New** — error classes |
| `src/config.ts` | **New** — config loading, validation, typed output |
| `src/backend.ts` | **New** — `BizhawkBackend` (extracted state machine + path helpers + NHL domain cache) |
| `src/bizhawk.ts` | Rewrite — `BizhawkServer` as multiplexer router (registry, validation, atomic start/stop) |
| `src/tools.ts` | Add `target` to every backend-scoped tool + handler; add `bizhawk_list_backends` |
| `src/nhl94.ts` | Accept `BizhawkBackend` instead of `BizhawkServer`; domain cache moves to backend |
| `src/index.ts` | Config-based startup; remove env-based port config; config mandatory |
| `src/http.ts` | No changes |
| `src/version.ts` | Bump `VERSION` display string only |
| `package.json` | Bump `version` to match |
| `lua/bridge_JD.lua` | Bump version display string only; no protocol or behavioral changes |
| `tests/` | Config validation, backend lifecycle, multiplexer routing, NHL domain caching, path resolution |
| `deploy/bizhawk-daemon.service` | **New** — single unit referencing `MCP_BIZHAWK_CONFIG` |
| `deploy/bizhawk-daemon-windows.service` | **Remove** |
| `deploy/bizhawk-daemon-linux_8763.service` | **Remove** |

## Migration

No backward compatibility — the multiplexer always requires `MCP_BIZHAWK_CONFIG` and every backend-scoped tool requires `target`.

```
1. Build and install the new code and config.
2. Update each bridge or launcher with its assigned backend port.
3. Stop and disable the old per-backend services.
4. Run systemctl daemon-reload.
5. Start the new multiplexer service.
6. Verify bizhawk_list_backends shows every configured backend.
7. Reconnect each bridge and verify every backend reaches "ready".
8. Update MCP callers so every backend-scoped tool includes "target".
9. Remove obsolete unit files after successful verification.
```

## Test Coverage

Required test cases:

- Two backends executing commands concurrently (separate sockets, no cross-talk)
- Commands remain serialized within each individual backend (queue order preserved)
- One backend disconnecting does not affect any other backend (their calls proceed normally)
- Late events from an old socket ignored after reconnection (socket/double-close/double-error)
- Stale timeout unable to reject a newer inflight command (generation + identity guard)
- Connected client that never sends `READY` detached after handshake timeout
- Second healthy client receives `BUSY`, legitimate reconnect succeeds on destroyed socket
- One listener bind failure rolls back all other listeners (atomic start)
- Concurrent `start()` and `stop()` calls (promise dedup, no races)
- Intentional shutdown produces `BackendStoppedError` (not `BackendDisconnectedError`)
- Unexpected socket loss produces `BackendDisconnectedError`
- Every backend-scoped MCP schema requires `target` in its `inputSchema.required`
- `bizhawk_list_backends` requires no target
- Unknown-target errors list valid targets in the error message
- Windows and Linux host/bridge path resolution (`resolvePathPair`)
- NHL domain cache recreated after socket generation changes (reconnect)
- Usage records contain the target and normalized error codes on failure
- Remote socket rejected when IP not in `allowedRemoteAddresses`
- Config validation rejects unknown keys, missing fields, port collisions, empty names
- `MCP_BIZHAWK_CONFIG` unset → fatal error, no HTTP server bound, nonzero exit
