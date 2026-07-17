# mcp-bizhawk

[![npm version](https://img.shields.io/npm/v/mcp-bizhawk.svg)](https://www.npmjs.com/package/mcp-bizhawk)
[![npm downloads](https://img.shields.io/npm/dm/mcp-bizhawk.svg)](https://www.npmjs.com/package/mcp-bizhawk)
[![CI](https://github.com/dmang-dev/mcp-bizhawk/actions/workflows/ci.yml/badge.svg)](https://github.com/dmang-dev/mcp-bizhawk/actions/workflows/ci.yml)
[![License: MIT](https://img.shields.io/npm/l/mcp-bizhawk.svg)](LICENSE)
[![Snyk](https://snyk.io/test/npm/mcp-bizhawk/badge.svg)](https://snyk.io/test/npm/mcp-bizhawk)
[![Socket](https://img.shields.io/badge/Socket-security-2F7BFF?logo=socket)](https://socket.dev/npm/package/mcp-bizhawk)
[![Bundlephobia](https://img.shields.io/badge/bundlephobia-size-FF6B81)](https://bundlephobia.com/package/mcp-bizhawk)
[![npmgraph](https://img.shields.io/badge/npmgraph-dependencies-2496ED)](https://npmgraph.js.org/?q=mcp-bizhawk)

An [MCP](https://modelcontextprotocol.io) server that exposes [BizHawk](https://github.com/TASEmulators/BizHawk) — the multi-system emulator the TAS community lives in — to any MCP-compatible client (Claude Desktop, Claude Code, etc.).

One bridge, **many systems**: NES, SNES, Game Boy / GBC / GBA, Sega Master System / Genesis / 32X / Saturn, N64, PlayStation 1, Atari 2600/5200/7800, Lynx, ColecoVision, Intellivision, and more — all through the same MCP tools, with per-system memory domains exposed cleanly.

<p align="center">
  <img src="docs/sm-claude-play.gif" alt="Claude driving Super Metroid through mcp-bizhawk">
</p>

<p align="center"><em>Claude (the agent) drives Samus through the opening of Ceres Station — all input batched through <code>bizhawk_play_input_sequence</code>, all motion verified by reading WRAM addresses found via live RAM-hunt. Recording is 2× speed; the actual playback runs at native 60fps emulation. See <a href="docs/RECIPES.md"><code>docs/RECIPES.md</code></a> and <a href="docs/SUPER-METROID-ADDRESSES.md"><code>docs/SUPER-METROID-ADDRESSES.md</code></a> for the workflow.</em></p>

## How it works

```
 Claude session 1 ─┐
 Claude session 2 ─┼─ HTTP MCP ─▶ mcp-bizhawk daemon ─ TCP :8766 ─▶  BizHawk
 Claude session N ─┘  :8765/mcp    (Node.js, always-on)  newline JSON  bridge_JD.lua
```

The server runs as a **single always-on daemon** that speaks MCP over
**streamable-HTTP** (`http://127.0.0.1:8765/mcp` by default). Any number of MCP
clients (Claude Code sessions, etc.) connect to it concurrently, and it owns the
one TCP socket the BizHawk bridge dials. All clients' commands interleave into a
single serial, frame-paced queue to the one emulator — no arbitration,
last-writer-wins.

The BizHawk transport is **inverted** compared to most other emulator-MCP bridges: BizHawk's Lua doesn't have native server sockets, only an outbound `comm.socketServer*` client. So `mcp-bizhawk` runs the TCP **listener**, and BizHawk's Lua bridge dials in once per frame to ferry commands and replies.

Two pieces:
- **`lua/bridge_JD.lua`** — runs *inside* BizHawk's Lua Console, polls our TCP server once per frame
- **`dist/index.js`** — the Node.js MCP daemon: serves streamable-HTTP on `127.0.0.1:8765/mcp` and listens for the bridge on `127.0.0.1:8766` (both overridable)

Trade-off: this design adds **~one frame of latency** per call (≈16ms at 60Hz). Fine for interactive memory hunting, save-state experimentation, and frame-by-frame inspection. Less ideal for high-rate-of-fire scripting.

## Requirements

- [BizHawk](https://github.com/TASEmulators/BizHawk/releases) **2.6.2 or newer** (earlier builds use an older socket-server wire format)
- **Node.js 22+** (for the MCP server)

Tested on BizHawk 2.11.1 across SNES (Super Metroid). Should work on any system BizHawk supports.

## Install

### Option A — install from npm (recommended)

```bash
npm install -g mcp-bizhawk
```

### Option B — `npx` (no install)

```bash
npx -y mcp-bizhawk
```

### Option C — clone and develop

```bash
git clone https://github.com/dmang-dev/mcp-bizhawk
cd mcp-bizhawk
npm install        # also runs the build via the `prepare` hook
```

## Set up the BizHawk bridge

There are two pieces to configure: telling BizHawk where to connect, and loading the bridge script.

### 1. Point BizHawk at the MCP server

Easiest: launch BizHawk with the socket flags directly.

```bash
EmuHawk.exe --socket_ip=127.0.0.1 --socket_port=8766 <path/to/rom>
```

(Adjust port if you're overriding `BIZHAWK_PORT`.)

Alternative: configure persistently via **Settings → Customize → External Tools** in BizHawk's UI.

### 2. Load the bridge script

In BizHawk: **Tools → Lua Console → Open Script** → select `lua/bridge_JD.lua` from this repo.

You should see in the Lua Console:
```
[mcp-bizhawk] bridge starting
[mcp-bizhawk] socket server target: 127.0.0.1:8766
[mcp-bizhawk] socket receive timeout set to 50ms
[mcp-bizhawk] frame loop active — bridge is polling once per frame
```

And in the `mcp-bizhawk` process's stderr:
```
[mcp-bizhawk] BizHawk client connected (waiting for bridge_JD.lua to start polling)
[mcp-bizhawk] bridge_JD.lua is polling — bridge ready
```

## Run the daemon

The server is an always-on HTTP daemon — start it once and leave it running;
every MCP client connects to it by URL. It's fine to start the daemon before
BizHawk is up: tool calls queue until the bridge dials in.

```bash
npm run daemon        # or: node dist/index.js
# [mcp-bizhawk] MCP server vX ready — streamable-HTTP at http://127.0.0.1:8765/mcp
```

For always-on operation, install the systemd **user** unit in
[`deploy/bizhawk-daemon-windows.service`](deploy/bizhawk-daemon-windows.service):

```bash
mkdir -p ~/.config/systemd/user
cp deploy/bizhawk-daemon-windows.service ~/.config/systemd/user/   # edit WorkingDirectory first
systemctl --user daemon-reload
systemctl --user enable --now bizhawk-daemon-windows
systemctl --user restart bizhawk-daemon-windows    # after `npm run build` on a version bump
```

## Register with your MCP client

Connect to the daemon over HTTP — the same URL works for any number of clients
simultaneously, so there's nothing to toggle per session.

### Claude Code (CLI)

```bash
claude mcp add bizhawk --scope user --transport http http://127.0.0.1:8765/mcp
```

Verify:
```bash
claude mcp list
# bizhawk: http://127.0.0.1:8765/mcp (HTTP) - ✓ Connected
```

### Claude Desktop

Edit `claude_desktop_config.json`:

| Platform | Path |
|---|---|
| macOS    | `~/Library/Application Support/Claude/claude_desktop_config.json` |
| Windows  | `%APPDATA%\Claude\claude_desktop_config.json` |
| Linux    | `~/.config/Claude/claude_desktop_config.json` |

```json
{
  "mcpServers": {
    "bizhawk": {
      "type": "http",
      "url": "http://127.0.0.1:8765/mcp"
    }
  }
}
```

Restart Claude Desktop after editing.

### Other MCP clients

The server speaks standard MCP over **streamable-HTTP** at
`http://127.0.0.1:8765/mcp`. Point any HTTP-capable MCP client (including
`npx @modelcontextprotocol/inspector`) at that URL.

## Configuration

| Env var         | Default       | Purpose                                    |
|-----------------|---------------|--------------------------------------------|
| `MCP_HTTP_HOST` | `127.0.0.1`   | Host the streamable-HTTP MCP endpoint binds |
| `MCP_HTTP_PORT` | `8765`        | Port the streamable-HTTP MCP endpoint binds |
| `BIZHAWK_HOST`  | `127.0.0.1`   | TCP host to listen on for BizHawk          |
| `BIZHAWK_PORT`  | `8766`        | TCP port to listen on for BizHawk          |
| `MCP_BIZHAWK_SHOT_DIR` | OS temp dir | Screenshot directory as the server sees it |
| `MCP_BIZHAWK_SHOT_DIR_BRIDGE` | unset | Same screenshot directory as remote BizHawk sees it, e.g. `X:\tmp` |
| `MCP_BIZHAWK_STATE_DIR` | `~/.mcp-bizhawk/states` | Managed named savestate slot directory as the server sees it |
| `MCP_BIZHAWK_STATE_DIR_BRIDGE` | unset | Same managed state directory as remote BizHawk sees it, e.g. `X:\.mcp-bizhawk\states` |
| `MCP_BIZHAWK_RIG_DIR` | `~/.mcp-bizhawk/rigs` | NHL94 rig directory as the server sees it |
| `MCP_BIZHAWK_RIG_DIR_BRIDGE` | unset | Same rig directory as remote BizHawk sees it, e.g. `X:\.mcp-bizhawk\rigs` |

For remote/cross-OS BizHawk setups, the server must validate files using its local path while BizHawk saves/loads using its own path spelling. Set the `*_BRIDGE` variables when those path spellings differ.

## Tools

| Tool | Description |
|------|-------------|
| `bizhawk_ping` | Verify bridge connectivity (returns `pong`) |
| `bizhawk_get_info` | ROM name, ROM hash, framecount, memory domains, capabilities — plus system id, paused state, lag count, and movie status where the loaded core/build exposes them |
| `bizhawk_list_memory_domains` | List available memory domains for the loaded core |
| `bizhawk_read8` / `bizhawk_read16` / `bizhawk_read32` | Read u8 / u16-LE / u32-LE from memory |
| `bizhawk_write8` / `bizhawk_write16` / `bizhawk_write32` | Write to memory |
| `bizhawk_read_range` | Read up to 4096 bytes as a byte array |
| `bizhawk_write_range` | Write up to 4096 bytes from a byte array |
| `bizhawk_read_many` | Labeled batch reads (`{name, address, width, domain}` specs) in one round-trip |
| `bizhawk_read_struct_array` | Decode N fixed-stride records (entity tables) into labeled fields in one call |
| `bizhawk_press_buttons` | Set joypad state for one player; keys are button names, values booleans |
| `bizhawk_get_input` | Read the current joypad state for a player — held buttons + analog axes, no frame advance |
| `bizhawk_frame_advance` | Step the emulator by N frames |
| `bizhawk_pause` / `bizhawk_unpause` | Pause / resume emulation |
| `bizhawk_reset` | Reset the loaded core |
| `bizhawk_screenshot` | Capture the current display — returns the PNG inline as an image block; optional path to also choose where it's saved |
| `bizhawk_save_state` / `bizhawk_load_state` | Save / load emulator state to a file path; loads pause by default so state does not drift between tool calls |
| `bizhawk_eval_lua` | Run an arbitrary Lua chunk in the bridge (JSON-encoded result); `unpause: true` runs it via the pause-safe path so `emu.frameadvance()` inside the chunk doesn't block forever |
| `bizhawk_disassemble` | Decode one or more machine instructions at an address (or the current PC) |
| `bizhawk_osd_message` | Draw a short message in BizHawk's on-screen OSD area |

All memory r/w tools take an optional `domain` parameter — if omitted, the active "current" memory domain is used. Use `bizhawk_list_memory_domains` to discover the names available on the loaded core.

The bridge also echoes every command it receives (and any handler error) to BizHawk's Lua Console as a `[mcp-bizhawk] << <method> <params>` line, so you can watch exactly what the server is sending in real time.

See [`docs/RECIPES.md`](docs/RECIPES.md) for end-to-end examples (RAM hunting on SNES/NES/N64, frame-precise input, snapshot-experiment-restore, cross-system regression testing) and [`CHANGELOG.md`](CHANGELOG.md) for release history.

### Memory domains by system (cheat sheet)

Names come straight from BizHawk's core implementation. Use `bizhawk_list_memory_domains` to see the exact set for the loaded ROM.

| System  | Main RAM domain | Other common domains              |
|---------|-----------------|-----------------------------------|
| NES     | `RAM`           | `PPU`, `OAM`, `PRG ROM`, `CHR`    |
| SNES    | `WRAM`          | `VRAM`, `CARTROM`, `CARTRAM`      |
| GB/GBC  | `WRAM`          | `VRAM`, `HRAM`, `OAM`, `ROM`      |
| GBA     | `EWRAM`, `IWRAM`| `VRAM`, `PALRAM`, `OAM`, `ROM`    |
| Genesis | `68K RAM`       | `VRAM`, `Z80 RAM`, `CARTRAM`      |
| N64     | `RDRAM`         | `SP DMEM`, `SP IMEM`, `PI Reg`    |
| PSX     | `MainRAM`       | `VRAM`, `Scratchpad`, `BIOS`      |

### Buttons by system

BizHawk's `joypad.set` takes a `{ButtonName=true, ...}` table where button names depend on the core. Common ones:

| System  | Names                                                              |
|---------|---------------------------------------------------------------------|
| NES     | `A`, `B`, `Up`, `Down`, `Left`, `Right`, `Start`, `Select`         |
| SNES    | `A`, `B`, `X`, `Y`, `L`, `R`, `Up`, `Down`, `Left`, `Right`, `Start`, `Select` |
| GB/GBC  | `A`, `B`, `Up`, `Down`, `Left`, `Right`, `Start`, `Select`         |
| GBA     | `A`, `B`, `L`, `R`, `Up`, `Down`, `Left`, `Right`, `Start`, `Select` |
| N64     | `A`, `B`, `Z`, `L`, `R`, `Start`, `Up`, `Down`, `Left`, `Right`, `C-Up`, `C-Down`, `C-Left`, `C-Right` |
| Genesis | `A`, `B`, `C`, `X`, `Y`, `Z`, `Up`, `Down`, `Left`, `Right`, `Start`, `Mode` |

If you're unsure, run a probe: `bizhawk_press_buttons {"A": true}` and watch the active core's input display in BizHawk.

## Troubleshooting

| Symptom | Cause / Fix |
|---|---|
| MCP tool calls hang for 10 seconds, then time out with "is the bridge_JD.lua script still polling?" | bridge_JD.lua isn't loaded. In BizHawk: **Tools → Lua Console → Open Script → bridge_JD.lua**. Check the console for `frame loop active`. |
| BizHawk connects to the server but tool calls still time out | You're on BizHawk older than 2.6.2 — the socket wire format changed then. Upgrade BizHawk. |
| `[mcp-bizhawk] FATAL: comm.socketServer* not available` in the Lua Console | BizHawk wasn't launched with `--socket_ip` / `--socket_port` flags, and no socket server is configured in **Settings → Customize → External Tools**. |
| Tools missing in Claude after install | Restart your MCP client; Claude only enumerates servers on startup. |
| Memory reads return zeros for the first few seconds after boot | The emulator hasn't initialized RAM yet. Either advance some frames (`bizhawk_frame_advance`) or check `bizhawk_get_info` to confirm framecount > 0 before relying on game state. |
| `unknown memory domain: <name>` | The domain name didn't match anything for the loaded core. Call `bizhawk_list_memory_domains` to see the actual list — names are case-sensitive. |
| `client.screenshot not available` or `savestate.* not available` | Some BizHawk cores expose a slightly different surface. Check `bizhawk_get_info` — the `capabilities` map shows which optional functions are present on your current build/core combo. |

## Development

```bash
npm install
npm run dev      # tsc --watch — autobuilds on src/ changes
```

End-to-end smoke test (launches BizHawk, loads ROM + bridge, runs ping/get_info/list_memory_domains/read_range):

```bash
node .scratch/test-all.cjs "I:\path\to\your\rom.smc"
```

Set `DEBUG=1` to dump every RX/TX line.

## Debugging with the MCP Inspector

Browse and call this server's tools interactively with the [MCP Inspector](https://github.com/modelcontextprotocol/inspector):

```bash
npm run inspector
```

Build first if you've edited `src/` since your last `npm install` (`npm run build`, or keep `npm run dev` running). Override the listener with `BIZHAWK_HOST` / `BIZHAWK_PORT` (default `127.0.0.1:8766`). `tools/list` works even without BizHawk connected; *calling* a tool needs EmuHawk running with the socket flags and `lua/bridge_JD.lua` loaded.

## License

[MIT](LICENSE)
