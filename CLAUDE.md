# mcp-bizhawk (JD build)

MCP server (Node/TypeScript) + BizHawk-side Lua bridge that drives emulation
and exposes NHL94 state/physics tooling. The `-jd` suffix marks this modified
build vs upstream.

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
  `-- vYYYY.M.D-jd changes (...)` entry to the changelog comment block at the
  top of the file

Scheme is calendar-style `YYYY.M.D-jd` (e.g. `2026.7.7-jd`). Note
`package-lock.json` carries an unrelated stale `version` and is NOT maintained
on this scheme — leave it alone.

## After a version bump / code change

- **Server** (`src/**`): run `npm run build` (compiles to `dist/`, what the
  server actually runs), then restart the server process for the running
  instance to report the new version. The bridge auto-reconnects on restart.
- **Bridge** (`lua/bridge_JD.lua`): reload the Lua script in BizHawk. If the
  external BizHawk deployment is in use, also copy the file to
  `/mnt/8tb/jason/nvnhl94-2/tools/bizhawk/BizHawk-2.11.1-linux-x64/Lua/`.

## Verifying

- `luac -p lua/bridge_JD.lua` syntax-checks the bridge.
- `npm test` builds then runs `tests/**/*.test.mjs` (server-side).
- Pure Lua OSD/render logic can be unit-tested with a standalone `lua5.4`
  harness (see how the system-line / carrier-highlight logic was verified).
