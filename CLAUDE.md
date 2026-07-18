# mcp-bizhawk (JD build)

MCP server (Node/TypeScript) + BizHawk-side Lua bridge that drives emulation
and exposes NHL94 state/physics tooling. The `-jd` suffix marks this modified
build vs upstream.

## Architecture — one HTTP daemon, N BizHawk backends

The server runs as a **single always-on process** that speaks MCP over
**streamable-HTTP** (`http://127.0.0.1:8765/mcp` by default) and internally
manages **N labelled BizHawk backends**, each on its own TCP port. Any number
of Claude Code sessions connect to the HTTP endpoint concurrently (stateless
mode, a fresh MCP `Server` per request bound to the shared `BizhawkServer`
singleton). All sessions' commands interleave into one serial, frame-paced FIFO
per backend — **no arbitration, last-writer-wins**. Every backend-scoped tool
requires a `target` parameter (use `bizhawk_list_backends` to discover names).

- `src/errors.ts` — typed error hierarchy (`BizhawkError` subclasses) + `errorCode()` mapping for usage logging.
- `src/config.ts` — `loadConfig()` / `validateConfig()` for `MCP_BIZHAWK_CONFIG` JSON file.
- `src/backend.ts` — `BizhawkBackend`: per-emulator TCP state machine (listener, command queue, generation guards, handshake timeout, NHL domain cache, path resolution).
- `src/bizhawk.ts` — `BizhawkServer`: thin multiplexer router over `Map<string, BizhawkBackend>`.
- `src/http.ts` — the streamable-HTTP front end (`createMcpHttpServer(bh)`).
- `src/index.ts` — wires config → backends → HTTP, handles startup/shutdown.
- `deploy/bizhawk-daemon.service` — systemd **user** unit for always-on operation (`systemctl --user {enable --now,restart,status} bizhawk-daemon`).

Sessions configure this as an **HTTP** MCP server (by `url`), not a `command`
stdio subprocess. There is no stdio transport — point `npm run inspector` at
the HTTP URL.

Backends are configured via a single JSON file pointed at by
`MCP_BIZHAWK_CONFIG`. Each entry gets its own TCP listener; a second bridge
client dialling the same port gets `BUSY`. Adding an emulator means adding
one stanza — no new daemon, MCP endpoint, or port pair needed.

## Versioning — keep the two halves in sync

The **server** and the **Lua bridge** ship a version string each, displayed
side-by-side on the OSD. Convention is still to **bump BOTH to the same value on
any release** so the OSD version line collapses to one `v…` and drift stays
visible. As of `2026.7.22-jd`, however, differing version strings are **no longer
a warning by themselves**: the OSD's orange+bold "stale component" highlight is
driven by the **RPC protocol version**, not the version string.

- `src/version.ts` `PROTOCOL_VERSION` (int) and `lua/bridge_JD.lua` `BRIDGE.protocol`
  are the wire-contract version, sent in the HELLO handshake. Same protocol on
  both halves → NO warning even if the display versions differ (so a bridge-only
  or server-only release is fine). Bump `PROTOCOL_VERSION`/`BRIDGE.protocol`
  together **only when the RPC contract itself changes** (command framing,
  command/RESULT shapes, HELLO) — a tool-surface or OSD change does NOT touch it.
  Currently `2`. (A pre-protocol server that sends no `protocol_version` falls
  back to the old version-string-age comparison.)

Version lives in three files — update all three together:

- `src/version.ts` — `VERSION` const (server source of truth; ping/HELLO read this)
- `package.json` — `"version"` (keep identical to `src/version.ts`)
- `lua/bridge_JD.lua` — `BRIDGE.version` (near the top) **and** add a matching
  `-- vYYYY.M.NN-jd changes (...)` entry to the changelog comment block at the
  top of the file

Scheme is `YYYY.M.NN-jd`, where the last component is a **release counter**
(monotonic, à la Home Assistant), NOT the day of the month — bump it by one
each release (e.g. `2026.7.9-jd` → `2026.7.10-jd`). Note `package-lock.json`
carries an unrelated stale `version` and is NOT maintained on this scheme —
leave it alone.

## After a version bump / code change

- **Server** (`src/**`): run `npm run build` (compiles to `dist/`, what the
  server actually runs), then restart the daemon so the running instance
  reports the new version — `systemctl --user restart bizhawk-daemon` (or, if
  running it by hand, kill and re-run `npm run daemon`). The bridge
  auto-reconnects on restart.
- **Bridge** (`lua/bridge_JD.lua`): reload the Lua script in BizHawk. If the
  external BizHawk deployment is in use, also copy the file to
  `/mnt/8tb/jason/nvnhl94-2/tools/bizhawk/BizHawk-2.11.1-linux-x64/Lua/`.

## Vision screenshots across a filesystem boundary

Screenshot-backed vision (`nhl94_state`/`bizhawk_screenshot` `describe`, on by
default) writes a PNG that the **server** then reads back to inline/caption it.
When BizHawk runs on the **same** host (e.g. the linux daemon) the default OS
temp dir works. When BizHawk is **remote on another OS** (the windows daemon:
Windows BizHawk, Linux server over a shared mount) the two spell the shared dir
differently, so set both per backend: `shotDir`/`shotDirBridge` in the backend's
config stanza (or `MCP_BIZHAWK_SHOT_DIR` + `MCP_BIZHAWK_SHOT_DIR_BRIDGE` env
vars as fallback). E.g. `X:\` (Windows) == `/mnt/8tb/jason` (Linux)
→ `shotDir=/mnt/8tb/jason/tmp` + `shotDirBridge=X:\tmp`
(see `deploy/backends.example.json`). Auto paths only; an explicit
`path` arg is used verbatim. Without this, remote describe fails `ENOENT`.

## Usage logging

Every MCP tool call appends one JSONL row (`ts`/`tool`/`target`/`ok`/`ms`/`args`, plus
`error` on failure) to `~/.mcp-bizhawk/usage/usage-<MCP_HTTP_PORT>.jsonl` — a
per-daemon record of what's actually being exercised, to inform where the tool
surface grows next. On by default; `MCP_BIZHAWK_USAGE_LOG=off` disables it,
`MCP_BIZHAWK_USAGE_LOG=<path>` redirects. Best-effort (never throws into the
request path; self-disables on write failure). Tally with e.g.
`jq -r .tool ~/.mcp-bizhawk/usage/usage-8765.jsonl | sort | uniq -c | sort -rn`.

## Verifying

- `luac -p lua/bridge_JD.lua` syntax-checks the bridge.
- `npm test` builds then runs `tests/**/*.test.mjs` (server-side).
- Pure Lua OSD/render logic can be unit-tested with a standalone `lua5.4`
  harness (see how the system-line / carrier-highlight logic was verified).
