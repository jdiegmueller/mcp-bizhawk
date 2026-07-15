# mcp-bizhawk (JD build)

MCP server (Node/TypeScript) + BizHawk-side Lua bridge that drives emulation
and exposes NHL94 state/physics tooling. The `-jd` suffix marks this modified
build vs upstream.

## Architecture — one always-on HTTP daemon

The server runs as a **single always-on process** that speaks MCP over
**streamable-HTTP** (`http://127.0.0.1:8765/mcp` by default) and internally owns
the one TCP socket the Lua bridge dials (`:8766`). Any number of Claude Code
sessions connect to the HTTP endpoint concurrently (stateless mode, a fresh MCP
`Server` per request bound to the shared `BizhawkServer` singleton). All
sessions' commands interleave into one serial, frame-paced FIFO to the single
emulator — **no arbitration, last-writer-wins**.

- `src/bizhawk.ts` — the `BizhawkServer` singleton: `:8766` listener, command
  queue, id-correlated `RESULT` handling, HELLO/version handshake.
- `src/http.ts` — the streamable-HTTP front end (`createMcpHttpServer(bh)`).
- `src/index.ts` — wires the two together, handles startup/shutdown.
- `deploy/bizhawk-daemon.service` — systemd **user** unit for always-on
  operation (`systemctl --user {enable --now,restart,status} bizhawk-daemon`).

Sessions configure this as an **HTTP** MCP server (by `url`), not a `command`
stdio subprocess. There is no stdio transport — point `npm run inspector` at
the HTTP URL.

## Versioning — keep the two halves in sync

The **server** and the **Lua bridge** ship a version string each, and they are
displayed side-by-side on the OSD. **Always bump BOTH to the same value on any
release, even when only one side actually changed** — a mismatch makes the OSD
split the version line and draw the older half orange+bold as a "stale
component" warning, so drift is visible and undesirable.

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

## Verifying

- `luac -p lua/bridge_JD.lua` syntax-checks the bridge.
- `npm test` builds then runs `tests/**/*.test.mjs` (server-side).
- Pure Lua OSD/render logic can be unit-tested with a standalone `lua5.4`
  harness (see how the system-line / carrier-highlight logic was verified).
