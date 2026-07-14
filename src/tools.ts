import {
  CallToolRequestSchema,
  ListToolsRequestSchema,
  Tool,
} from "@modelcontextprotocol/sdk/types.js";
import type { Server } from "@modelcontextprotocol/sdk/server/index.js";
import { BizhawkServer } from "./bizhawk.js";
import { VERSION } from "./version.js";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";

const VALID_BUTTONS = [
  "A", "B", "X", "Y",                 // Face buttons
  "Up", "Down", "Left", "Right",      // D-pad
  "Start", "Select",                  // System
  "L", "R", "L1", "R1", "L2", "R2", "L3", "R3", // Shoulders/triggers/sticks
  "C", "Z", "C-Up", "C-Down", "C-Left", "C-Right",  // N64
  "Mode",                             // Genesis 6-button
];

// ──────────────────────────────────────────────────────────────────────────────
// Tool descriptions are written to the TDQS rubric (Glama's Tool Definition
// Quality Score). Each description covers, in order:
//
//   • PURPOSE — one clear action sentence.
//   • USAGE — when to use this vs sibling tools (read8 vs read16 vs read_range,
//     write* vs load_state, frame_advance vs unpause, etc.).
//   • BEHAVIOR — side effects, error conditions, destructive notes. Reads say
//     "no side effects — pure read." Writes say "DESTRUCTIVE: overwrites".
//     Every tool documents the failure mode it can return (unknown domain,
//     out-of-range address, oversize range, missing capability, etc.).
//   • RETURNS — exact shape of the success output.
//
// Each parameter has a `description` that adds context the schema can't
// (interactions, examples, units, alignment requirements).
// ──────────────────────────────────────────────────────────────────────────────

const DOMAIN_PARAM_DESC =
  "Optional case-sensitive memory domain name. Omit to use BizHawk's currently selected domain " +
  "(see bizhawk_get_info → current_memory_domain). Discover available names with " +
  "bizhawk_list_memory_domains; they vary per system (WRAM on SNES, RAM on NES, RDRAM on N64, " +
  "68K RAM on Genesis, MainRAM on PSX, EWRAM/IWRAM on GBA). Returns an error if the name doesn't " +
  "match any domain on the loaded core.";

const BYTEORDER_PARAM_DESC =
  "Byte order for the value: 'le' (little-endian, default) or 'be' (big-endian). " +
  "Use 'be' on big-endian systems — notably the Genesis/Mega Drive 68K, where game values " +
  "are stored big-endian and a little-endian read returns byte-swapped garbage. " +
  "Requires the bridge's memory_read/write_*_be capability (present on standard BizHawk builds).";

const WIDTH_ENUM = ["u8", "s8", "u16", "s16", "u32", "s32", "u16_be", "s16_be", "u32_be", "s32_be"];
const WRITE_WIDTH_ENUM = ["u8", "u16", "u32", "u16_be", "u32_be"];
const WIDTH_PARAM_DESC =
  "Read width and signedness: u/s 8/16/32 bits. Plain u16/u32/s16/s32 are little-endian; " +
  "'_be' variants are big-endian (use these on Genesis/Mega Drive 68K). Default 'u8'.";

// Frame-locked commands take ~16.7ms per emulated frame at 60Hz. Scale the
// RPC timeout with the requested frame count (20ms/frame headroom + fixed
// margin) so long batches don't die at the flat default timeout.
const frameTimeout = (frames: number) => frames * 20 + 5000;

const ADDRESS_PARAM_DESC = (widthBytes: number) =>
  `Byte offset within the chosen memory domain. Per-domain offsets are 0-based and INDEPENDENT ` +
  `of system bus addresses (e.g. SNES WRAM uses 0x09C6, NOT 0x7E09C6). Reads ${widthBytes} ` +
  `consecutive byte${widthBytes === 1 ? "" : "s"} starting here. Returns an error if address < 0 ` +
  `or address + ${widthBytes} exceeds the domain's size.`;

const TOOLS: Tool[] = [
  // ── Connectivity & introspection ────────────────────────────────────────

  {
    name: "bizhawk_ping",
    description:
      "PURPOSE: Report the MCP server version and the BizHawk bridge's connection/liveness state. " +
      "USAGE: Call this once at start-of-session before issuing other tool calls. ALWAYS answers immediately, even when BizHawk isn't running — so it doubles as a check of which server build is installed. Only a 'pong ... bridge polling' response means other tools will work. " +
      "BEHAVIOR: No side effects — pure probe. Never errors: if BizHawk isn't connected or bridge_JD.lua isn't polling, it says so in the response instead of timing out. " +
      "RETURNS: 'pong (mcp-bizhawk vX.Y.Z, bridge polling)' when fully up; otherwise 'mcp-bizhawk vX.Y.Z — <what's missing>'. A '-jd' version suffix identifies the modified server build (frame-scaled timeouts, byteorder, hold, wait_for_memory).",
    inputSchema: { type: "object", properties: {} },
  },
  {
    name: "bizhawk_get_info",
    description:
      "PURPOSE: Get the loaded ROM's name and hash, current frame count, the list of available memory domains, the active default domain (the one used when 'domain' is omitted on read/write tool calls), and the bridge's capability map (which optional emu/client/savestate/joypad/memory methods this BizHawk build exposes). " +
      "USAGE: Call after bizhawk_ping to learn what system is loaded and which optional features are available; before any memory tool call to confirm the active domain and avoid silent reads from the wrong address space; before pause / unpause / reset / screenshot / save_state to check the corresponding `capabilities.*` flag. " +
      "BEHAVIOR: No side effects — pure read of emulator metadata. Returns 'unavailable' for fields the loaded core doesn't expose (rom_name when no ROM is loaded, framecount on cores without emu.framecount, etc.). " +
      "RETURNS: Multi-line text with ROM, ROM hash, framecount, memory_domains list, active domain, and a list of any missing capabilities for this build.",
    inputSchema: { type: "object", properties: {} },
  },
  {
    name: "bizhawk_list_memory_domains",
    description:
      "PURPOSE: List the memory domains available on the loaded core (e.g. 'WRAM', 'CARTRAM', 'VRAM', 'System Bus' on SNES; 'RAM', 'PPU', 'OAM' on NES). " +
      "USAGE: Call before any memory r/w tool when you don't know the domain layout for the loaded system. The returned names are exactly what to pass as the `domain` parameter on bizhawk_read*/write* tools (case-sensitive). " +
      "BEHAVIOR: No side effects — pure read. Returns an error if the loaded BizHawk core doesn't implement memory.getmemorydomainlist (extremely rare). " +
      "RETURNS: Newline-formatted list of domain names, one per line.",
    inputSchema: { type: "object", properties: {} },
  },

  // ── Memory reads ────────────────────────────────────────────────────────

  {
    name: "bizhawk_read8",
    description:
      "PURPOSE: Read an unsigned 8-bit byte from emulator memory at the given address. " +
      "USAGE: Use for single-byte status flags, counters, and 8-bit fields. For 16- or 32-bit values use bizhawk_read16/read32 (one call instead of multi-byte assembly); for spans of more than ~4 bytes use bizhawk_read_range (one round-trip instead of N frame-latency hops). " +
      "BEHAVIOR: No side effects — pure read. Reads work the same way whether emulation is paused or running. Returns an error if the named domain doesn't exist, the address is out of range for the domain, or the loaded core doesn't expose memory.read_u8. " +
      "RETURNS: Single line 'ADDR_HEX: VAL_DEC (0xVAL_HEX)', e.g. '0x09C6: 99 (0x63)'.",
    inputSchema: {
      type: "object",
      required: ["address"],
      properties: {
        address: { type: "integer", minimum: 0, description: ADDRESS_PARAM_DESC(1) },
        domain:  { type: "string", description: DOMAIN_PARAM_DESC },
      },
      additionalProperties: false,
    },
  },
  {
    name: "bizhawk_read16",
    description:
      "PURPOSE: Read an unsigned 16-bit value from emulator memory at the given address, little-endian by default or big-endian with byteorder='be'. " +
      "USAGE: Use for 16-bit fields (most game-state values: HP, score, coordinates). For single bytes use bizhawk_read8; for 32-bit values use bizhawk_read32; for non-aligned spans use bizhawk_read_range. On big-endian systems (Genesis/Mega Drive 68K) pass byteorder='be' — the little-endian default returns byte-swapped values there. " +
      "BEHAVIOR: No side effects — pure read. Reads two consecutive bytes starting at `address` and combines them per `byteorder`. Returns an error if the named domain doesn't exist, address+2 exceeds domain size, or the core doesn't expose memory.read_u16_le/read_u16_be. " +
      "RETURNS: Single line 'ADDR_HEX: VAL_DEC (0xVAL_HEX)'.",
    inputSchema: {
      type: "object",
      required: ["address"],
      properties: {
        address:   { type: "integer", minimum: 0, description: ADDRESS_PARAM_DESC(2) },
        domain:    { type: "string", description: DOMAIN_PARAM_DESC },
        byteorder: { type: "string", enum: ["le", "be"], default: "le", description: BYTEORDER_PARAM_DESC },
      },
      additionalProperties: false,
    },
  },
  {
    name: "bizhawk_read32",
    description:
      "PURPOSE: Read an unsigned 32-bit value from emulator memory at the given address, little-endian by default or big-endian with byteorder='be'. " +
      "USAGE: Use for 32-bit fields (timestamps, large counters, pointers on 32-bit systems, RGBA colors). For 8/16-bit reads use bizhawk_read8/read16; for unaligned multi-word reads use bizhawk_read_range. On big-endian systems (Genesis/Mega Drive 68K) pass byteorder='be'. " +
      "BEHAVIOR: No side effects — pure read. Reads four consecutive bytes starting at `address` and combines them per `byteorder`. Returns an error if the domain doesn't exist, address+4 exceeds the domain, or the core lacks memory.read_u32_le/read_u32_be. " +
      "RETURNS: Single line 'ADDR_HEX: VAL_DEC (0xVAL_HEX)'.",
    inputSchema: {
      type: "object",
      required: ["address"],
      properties: {
        address:   { type: "integer", minimum: 0, description: ADDRESS_PARAM_DESC(4) },
        domain:    { type: "string", description: DOMAIN_PARAM_DESC },
        byteorder: { type: "string", enum: ["le", "be"], default: "le", description: BYTEORDER_PARAM_DESC },
      },
      additionalProperties: false,
    },
  },
  {
    name: "bizhawk_read_range",
    description:
      "PURPOSE: Read a contiguous range of bytes from emulator memory as a hex dump. " +
      "USAGE: Use for >4 bytes (one round-trip vs N frame-latency hops). Max 4096 bytes/call (BizHawk serialization limit); chunk larger reads in 4 KiB. Powers the two-snapshot RAM-hunt workflow (snapshot before/after a known change, diff for matching deltas). " +
      "BEHAVIOR: No side effects — pure read. Returns an error if domain is unknown, length is out of 1-4096, or address+length exceeds the domain. " +
      "RETURNS: 'ADDR_HEX [N bytes, DOMAIN]:' header + space-separated 2-digit uppercase hex bytes.",
    inputSchema: {
      type: "object",
      required: ["address", "length"],
      properties: {
        address: { type: "integer", minimum: 0, description: "Starting byte offset within the chosen memory domain (0-based per-domain, NOT a system-bus address). Reads [address, address+length)." },
        length:  { type: "integer", minimum: 1, maximum: 4096, description: "Number of bytes to read (1-4096; hard cap is BizHawk's per-call serialization limit)." },
        domain:  { type: "string", description: DOMAIN_PARAM_DESC },
      },
      additionalProperties: false,
    },
  },

  // ── Memory writes ───────────────────────────────────────────────────────

  {
    name: "bizhawk_write8",
    description:
      "PURPOSE: Write a single unsigned byte (0-255) to emulator memory at the given address. " +
      "USAGE: Use for single-byte cheats, debug pokes, and game-state mutations (give a player N lives, unlock a flag, set a counter). For 16/32-bit values prefer bizhawk_write16/write32 (single call instead of byte-at-a-time); for spans use bizhawk_write_range. To seed cart save RAM realistically (with proper MBC behavior), prefer bizhawk_load_state with a pre-prepared .State file rather than poking SRAM bytes here. " +
      "BEHAVIOR: DESTRUCTIVE: overwrites whatever was at `address` with no undo (snapshot via bizhawk_save_state first if you need rollback). The write is direct memory access — bypasses MBC bank switches, cartridge mapper side-effects, and DMA semantics — so it cannot be used to emulate cartridge hardware. Returns an error if the domain is unknown, address is out of range, value < 0 or > 255, or the core lacks memory.write_u8. Works whether emulation is paused or running. " +
      "RETURNS: Single line 'Wrote VAL_DEC (0xVAL_HEX) → ADDR_HEX (DOMAIN)'.",
    inputSchema: {
      type: "object",
      required: ["address", "value"],
      properties: {
        address: { type: "integer", minimum: 0, description: ADDRESS_PARAM_DESC(1) },
        value:   { type: "integer", minimum: 0, maximum: 255, description: "Byte value to write. Must be 0-255 (0x00-0xFF). Values outside this range return an error." },
        domain:  { type: "string", description: DOMAIN_PARAM_DESC },
      },
      additionalProperties: false,
    },
  },
  {
    name: "bizhawk_write16",
    description:
      "PURPOSE: Write an unsigned 16-bit value to emulator memory at the given address, little-endian by default or big-endian with byteorder='be'. " +
      "USAGE: Use for 16-bit cheats and pokes (HP, score, coordinates). For single bytes use bizhawk_write8; for 32-bit use bizhawk_write32; for cart save RAM seeding, use bizhawk_load_state. On big-endian systems (Genesis/Mega Drive 68K) pass byteorder='be'. " +
      "BEHAVIOR: DESTRUCTIVE: overwrites two bytes starting at `address` with no undo, in the byte order given by `byteorder`. Direct memory write — no MBC/mapper/DMA mediation, see bizhawk_write8 notes. Returns an error if the domain is unknown, address+2 exceeds the domain, value < 0 or > 65535, or the core lacks memory.write_u16_le/write_u16_be. " +
      "RETURNS: Single line 'Wrote VAL_DEC (0xVAL_HEX) → ADDR_HEX (DOMAIN)'.",
    inputSchema: {
      type: "object",
      required: ["address", "value"],
      properties: {
        address:   { type: "integer", minimum: 0, description: ADDRESS_PARAM_DESC(2) },
        value:     { type: "integer", minimum: 0, maximum: 65535, description: "16-bit value to write. Must be 0-65535 (0x0000-0xFFFF). Byte placement follows `byteorder`. Values outside this range return an error." },
        domain:    { type: "string", description: DOMAIN_PARAM_DESC },
        byteorder: { type: "string", enum: ["le", "be"], default: "le", description: BYTEORDER_PARAM_DESC },
      },
      additionalProperties: false,
    },
  },
  {
    name: "bizhawk_write32",
    description:
      "PURPOSE: Write an unsigned 32-bit value to emulator memory at the given address, little-endian by default or big-endian with byteorder='be'. " +
      "USAGE: Use for 32-bit cheats and pokes (timestamps, large counters, pointers on 32-bit systems). For 8/16-bit values use bizhawk_write8/write16. On big-endian systems (Genesis/Mega Drive 68K) pass byteorder='be'. " +
      "BEHAVIOR: DESTRUCTIVE: overwrites four bytes starting at `address` with no undo (snapshot via bizhawk_save_state first if you need rollback), in the byte order given by `byteorder`. Direct memory write — bypasses MBC/mapper/DMA, see bizhawk_write8 notes. Returns an error if the domain is unknown, address+4 exceeds the domain, value < 0 or > 4294967295, or the core lacks memory.write_u32_le/write_u32_be. " +
      "RETURNS: Single line 'Wrote VAL_DEC (0xVAL_HEX) → ADDR_HEX (DOMAIN)'.",
    inputSchema: {
      type: "object",
      required: ["address", "value"],
      properties: {
        address:   { type: "integer", minimum: 0, description: ADDRESS_PARAM_DESC(4) },
        value:     { type: "integer", minimum: 0, maximum: 4294967295, description: "32-bit value to write. Must be 0-4294967295 (0x00000000-0xFFFFFFFF). Byte placement follows `byteorder`. Values outside this range return an error." },
        domain:    { type: "string", description: DOMAIN_PARAM_DESC },
        byteorder: { type: "string", enum: ["le", "be"], default: "le", description: BYTEORDER_PARAM_DESC },
      },
      additionalProperties: false,
    },
  },
  {
    name: "bizhawk_write_range",
    description:
      "PURPOSE: Write a contiguous byte sequence to emulator memory starting at the given address. " +
      "USAGE: Use whenever you're seeding more than ~4 bytes — one round-trip vs N frame-latency hops compared to looping bizhawk_write8. Maximum 4096 bytes per call (BizHawk serialization limit); for larger writes, batch in 4 KiB chunks. Useful for installing cheat tables, patching code blocks, restoring a captured byte window after experiments, and writing big-endian multi-byte values (byteswap them yourself first). For cart save RAM seeding with proper MBC semantics, use bizhawk_load_state instead. " +
      "BEHAVIOR: DESTRUCTIVE: overwrites N bytes starting at `address` with no undo. Direct memory write — bypasses MBC/mapper/DMA, see bizhawk_write8 notes. Bytes are written sequentially address, address+1, ..., address+N-1. Returns an error if the domain is unknown, address+N exceeds the domain, the array contains a value outside 0-255, or the array length is < 1 or > 4096. " +
      "RETURNS: Single line 'Wrote N bytes → ADDR_HEX (DOMAIN)'.",
    inputSchema: {
      type: "object",
      required: ["address", "bytes"],
      properties: {
        address: { type: "integer", minimum: 0, description: "Starting byte offset within the chosen memory domain. The N bytes [address, address+len) are written." },
        bytes: {
          type: "array",
          items: { type: "integer", minimum: 0, maximum: 255 },
          minItems: 1,
          // NOTE: deliberately NO `maxItems` here. The 4096 upper bound is enforced
          // at runtime (bridge cmd_write_range errors if #bytes > 4096) and stated in
          // the description. A schema `maxItems: 4096` makes llama.cpp's
          // json-schema-to-grammar emit a {0,4095} repetition, which exceeds its
          // hardcoded MAX_REPETITION_THRESHOLD (2000, src/llama-grammar.cpp) and fails
          // the ENTIRE tool-call grammar → HTTP 500 for any client (e.g. opencode) that
          // compiles the full tool list against a llama.cpp server. Keep it code-enforced.
          description: "Byte values to write, one per element (each 0-255). Length 1-4096 — the upper cap is enforced by the server, not this schema (see code note). Written sequentially from `address`.",
        },
        domain:  { type: "string", description: DOMAIN_PARAM_DESC },
      },
      additionalProperties: false,
    },
  },

  // ── Input ───────────────────────────────────────────────────────────────

  {
    name: "bizhawk_press_buttons",
    description:
      "PURPOSE: Set the joypad button state for one player for EXACTLY the next emulated frame. " +
      "USAGE: Drive games with input. Each call sets joypad state for ONE frame only — the very next frame BizHawk processes. After that frame, BizHawk's input goes back to whatever the human user is holding (typically nothing). " +
      "To HOLD a button across N consecutive frames, INTERLEAVE: call bizhawk_press_buttons + bizhawk_frame_advance(count=1) N times in a loop. " +
      "DO NOT call bizhawk_press_buttons once and then bizhawk_frame_advance(count=N) — only the first of those N frames sees the button; the rest are no-input. Verified empirically against SNES Super Metroid in May 2026: a 60-frame advance after a single press_buttons(Right) moved Samus the same +1 pixel as a 10-frame advance, because frames 2-60 had no input. " +
      "To release a button mid-hold, just stop calling press_buttons for it; the next frame_advance will see it released. " +
      "BEHAVIOR: Modifies emulator input state for the next frame poll only — no other side effects. Returns an error if the loaded core doesn't expose joypad.set. Button names that aren't valid for the active core are silently ignored by BizHawk (no error). " +
      "RETURNS: Single line 'Set joypad N: BUTTON+BUTTON+...' or '... (all released)' if nothing was pressed. " +
      `\n\nButton names vary per system. Common names across cores: ${VALID_BUTTONS.join(", ")}. Use whatever names the active core understands — if unsure, try a name and check BizHawk's input display, or use bizhawk_get_info to confirm joypad_set is available.`,
    inputSchema: {
      type: "object",
      required: ["buttons"],
      properties: {
        buttons: {
          type: "object",
          description: "Map of button name (string, case-sensitive per the active core) → pressed (boolean: true=pressed, false=released). Example: {\"A\": true, \"Up\": true} presses A and Up while leaving everything else released. Names not recognized by the active core are silently ignored.",
          additionalProperties: { type: "boolean" },
        },
        player: {
          type: "integer",
          minimum: 1,
          default: 1,
          description: "Player number (1-based). Default 1. For multi-controller cores (e.g. N64 with 4 controllers) pass 2/3/4 to address other players.",
        },
      },
      additionalProperties: false,
    },
  },
  {
    name: "bizhawk_play_input_sequence",
    description:
      "PURPOSE: Play a pre-built sequence of per-frame joypad inputs back-to-back, advancing one frame per element, ENTIRELY SERVER-SIDE in a single bridge round-trip. Optionally captures screenshots AND labeled memory reads at fixed frame intervals during the play, and optionally aborts play early when a specified memory address changes. All observations come back inline so the agent sees the full trajectory + game state in one tool response. " +
      "USAGE: Use whenever you have ≥10 frames of inputs to play in order — TAS movie playback, scripted multi-frame sequences, AI-search of input patterns, agent-driven gameplay. ONE bridge round-trip ships N frames instead of the 2N round-trips you'd pay looping bizhawk_press_buttons + bizhawk_frame_advance(1). Use `hold` on each element to run-length-encode repeated input ({buttons:{}, hold:60} = 60 idle frames in one entry) — this keeps the JSON tiny for long sequences. The RPC timeout scales with the total frame count, so multi-thousand-frame batches are fine; the practical reason to chunk is responsiveness (the bridge can't service other calls mid-batch). " +
      "FOR AGENT-DRIVEN PLAY: combine `screenshot_every`, `observe_memory`, and `stop_on_memory_change` for the killer pattern — 'walk right for up to 200 frames, observing screenshot+x+y+hp every second, but STOP the moment the room ID changes'. The agent sees: where Samus was at each second, AND whether the goal (room transition) was reached, AND screenshots for visual confirmation — all in one tool response. " +
      "BEHAVIOR: For each `frames` element, calls joypad.set with that frame's buttons then emu.frameadvance. The bridge's main poll loop is BLOCKED for the duration of the call (no other RPCs, no heartbeat) until the sequence finishes or fails. With `screenshot_every`, each captured screenshot adds ~1 frame of wall-clock. With `observe_memory`, each observation also reads the listed memory addresses at the same frame the screenshot was taken — values come back labeled by `name` in each observation's `memory` field. With `stop_on_memory_change`, the bridge records the listed address's value before the first frame, re-reads it after each frame, and aborts the sequence the moment it changes (a final observation is captured at the stop frame regardless of cadence). Returns an error if joypad.set / emu.frameadvance / client.screenshot is missing when needed, if any `observe_memory` entry references an unknown domain, if any `width` isn't 'u8' / 'u16' / 'u32', or if any address is out of range. " +
      "RETURNS: A text summary ('Played N frames. Final framecount: M. Stopped early: yes/no [reason]. Captured K observations with their memory values') followed by K inline image content blocks (one per observation, in frame order). Each observation in the text summary includes its frame_offset and labeled memory values so the agent can correlate the visible screenshot with the game state at that exact frame.",
    inputSchema: {
      type: "object",
      required: ["frames"],
      properties: {
        frames: {
          type: "array",
          description:
            "Array of input entries. Each element describes `hold` consecutive emulated frames (default 1): " +
            "`{\"buttons\": {\"Right\": true, ...}, \"player\": 1, \"hold\": 30}` holds Right for 30 frames. " +
            "Empty `buttons` (or empty object) = no input for that entry's frames. `player` defaults to 1 if omitted. " +
            "Array order = playback order. Prefer `hold` over repeating identical entries — it keeps the JSON small. " +
            "The RPC timeout scales with total frame count; chunk very long sequences (>~1000 frames) mainly to keep the bridge responsive to other calls.",
          minItems: 1,
          items: {
            type: "object",
            additionalProperties: false,
            properties: {
              buttons: {
                type: "object",
                description: "Map of button name → pressed (boolean). Same semantics as bizhawk_press_buttons.buttons. Omit or empty = no input on this frame.",
                additionalProperties: { type: "boolean" },
              },
              player: {
                type: "integer",
                minimum: 1,
                default: 1,
                description: "Player number (1-based). Default 1.",
              },
              hold: {
                type: "integer",
                minimum: 1,
                default: 1,
                description: "Number of consecutive frames to repeat this input (run-length encoding). Default 1. The input is re-asserted every frame of the hold, so it behaves exactly like N identical entries.",
              },
            },
          },
        },
        screenshot_every: {
          type: "integer",
          minimum: 1,
          description:
            "Optional. If set, capture a PNG screenshot every N frames during playback (and one extra at the final frame regardless of remainder). Each screenshot costs ~1 wall-clock frame for client.screenshot, so 60 (≈1 sec of game time) is a good default — captures meaningful state changes without doubling batch latency. Omit to skip screenshots. If `observe_memory` is also set, screenshots and memory reads happen at the same observation points.",
        },
        screenshot_dir: {
          type: "string",
          description:
            "Optional. Directory to write screenshot PNGs into when `screenshot_every` is set. Default: C:/temp. Must exist and be writable. Files are named `<prefix>-NNNN.png` where NNNN is the frame offset within the batch (zero-padded to 4 digits).",
        },
        screenshot_prefix: {
          type: "string",
          description:
            "Optional. Filename prefix for screenshots when `screenshot_every` is set. Default: 'obs'.",
        },
        observe_memory: {
          type: "array",
          description:
            "Optional. List of memory reads to perform at each observation point (alongside screenshots if `screenshot_every` is also set). Each result lands in the observation's `memory` field keyed by `name`. " +
            "Use this to track game-state values per observation — e.g. on Super Metroid, track HP/X/Y/room-ID at each screenshot so you see how state changes across the play batch.",
          items: {
            type: "object",
            required: ["name", "address", "width"],
            additionalProperties: false,
            properties: {
              name: {
                type: "string",
                description: "Label for this reading in the output observation. Choose something semantic (e.g. 'hp', 'samus_x', 'room').",
              },
              domain: {
                type: "string",
                description: "Optional case-sensitive memory domain. Omit to use BizHawk's currently selected domain. Same semantics as the standalone read tools.",
              },
              address: {
                type: "integer",
                minimum: 0,
                description: "Byte offset within the chosen memory domain (0-based per-domain).",
              },
              width: {
                type: "string",
                enum: WIDTH_ENUM,
                description: WIDTH_PARAM_DESC,
              },
            },
          },
        },
        stop_on_memory_change: {
          type: "object",
          description:
            "Optional. If set, the bridge reads the specified memory value before the first frame, re-reads it after every frame, and ABORTS the play sequence the moment it changes. The result will have `stopped_early: true` and `stop_reason: 'memory_changed'`. A final observation is captured at the stop frame even if it's not on the normal cadence. " +
            "Killer use case: watch the room ID — Samus walks through a door, room ID changes, play stops at the exact frame of the transition.",
          required: ["address", "width"],
          additionalProperties: false,
          properties: {
            domain: {
              type: "string",
              description: "Optional case-sensitive memory domain. Same semantics as observe_memory[].domain.",
            },
            address: {
              type: "integer",
              minimum: 0,
              description: "Byte offset within the chosen memory domain to monitor.",
            },
            width: {
              type: "string",
              enum: WIDTH_ENUM,
              description: WIDTH_PARAM_DESC,
            },
          },
        },
        turbo: {
          type: "boolean",
          default: false,
          description: "Run at maximum emulation speed with rendering disabled (rendering stays ON if screenshots are requested). Restores 100% speed + visible rendering afterwards — note this resets any custom speed the user had set. Wall-clock speedup is typically 10-50×.",
        },
      },
      additionalProperties: false,
    },
  },

  // ── Emulator control ───────────────────────────────────────────────────

  {
    name: "bizhawk_pause",
    description:
      "PURPOSE: Pause emulation — freeze game-logic clocks and hold the current frame on screen. " +
      "USAGE: Use before a sequence of memory-inspect / write / screenshot calls when you need a stable game state across calls (so the game doesn't advance between your reads). Use bizhawk_unpause to resume; use bizhawk_frame_advance to step single frames without leaving pause. " +
      "BEHAVIOR: Modifies emulator run state. The Lua bridge keeps polling the socket while paused, so all other tool calls (memory r/w, screenshot, save_state, etc.) still work. Returns an error if the loaded core doesn't expose emu.pause — check `capabilities.pause` in bizhawk_get_info first to handle that case gracefully. Calling pause when already paused is a no-op. " +
      "RETURNS: Single line 'Emulation paused'.",
    inputSchema: { type: "object", properties: {} },
  },
  {
    name: "bizhawk_unpause",
    description:
      "PURPOSE: Resume emulation after a pause, returning to normal real-time playback. " +
      "USAGE: Counterpart to bizhawk_pause. Use after a paused inspection sequence is complete. To advance only a few frames without resuming full speed, use bizhawk_frame_advance instead. " +
      "BEHAVIOR: Modifies emulator run state. Returns an error if the loaded core doesn't expose emu.unpause — check `capabilities.unpause` in bizhawk_get_info first. Calling unpause when not paused is a no-op. " +
      "RETURNS: Single line 'Emulation resumed'.",
    inputSchema: { type: "object", properties: {} },
  },
  {
    name: "bizhawk_frame_advance",
    description:
      "PURPOSE: Step emulation by exactly N frames (default 1) and return the new framecount. " +
      "USAGE: Use for frame-precise input automation (combine with bizhawk_press_buttons), animation inspection, or letting the system initialize after a hard reset (RAM is mostly zero in the first ~30 frames after bizhawk_reset). For long jumps (thousands of frames) prefer bizhawk_save_state / bizhawk_load_state of a pre-prepared state — frame_advance scales linearly. Works whether emulation is currently paused or running and does NOT change the pause state. " +
      "BEHAVIOR: Advances the game-logic clock by N frames. Each step costs roughly one real frame (~16ms at 60Hz) plus one bridge round-trip — so advancing 600 frames takes ~10 seconds wall-clock. Returns an error if the loaded core doesn't expose emu.frameadvance. " +
      "RETURNS: Single line 'Advanced N frame(s). Framecount: NEW_COUNT'.",
    inputSchema: {
      type: "object",
      properties: {
        count: { type: "integer", minimum: 1, default: 1, description: "Number of frames to advance (≥1, default 1). Latency scales linearly: ~16ms per frame at 60Hz. New framecount = previous framecount + count." },
        turbo: {
          type: "boolean",
          default: false,
          description: "Run at maximum emulation speed with rendering disabled (rendering stays ON if screenshots are requested). Restores 100% speed + visible rendering afterwards — note this resets any custom speed the user had set. Wall-clock speedup is typically 10-50×.",
        },
      },
      additionalProperties: false,
    },
  },
  {
    name: "bizhawk_reset",
    description:
      "PURPOSE: Reset the loaded core — equivalent to a hard reset (power cycle) of the emulated console. " +
      "USAGE: Use to start fresh from boot. To return to a specific known-good point instead of boot, use bizhawk_load_state with a previously saved state file. " +
      "BEHAVIOR: DESTRUCTIVE: RAM contents become indeterminate (typically zeroed), CPU returns to the reset vector, framecount resets to 0, joypad state clears, and any in-progress audio/video state is discarded. The loaded ROM stays loaded — only volatile state is cleared. Unsaved game progress is lost. Returns an error if the loaded core doesn't expose client.reboot_core — check `capabilities.reboot_core` in bizhawk_get_info first. " +
      "RETURNS: Single line 'Core reset'.",
    inputSchema: { type: "object", properties: {} },
  },
  {
    name: "bizhawk_screenshot",
    description:
      "PURPOSE: Capture a PNG screenshot of the current emulator display and return it INLINE as an image content block (also saved to disk). " +
      "USAGE: The primary 'look at the screen' tool — call it whenever you need visual confirmation of game state. To capture a specific state, pause / advance frames / load state first. Pass `path` only if you want the PNG at a specific location; otherwise a temp file is used. For screenshots DURING an input sequence use bizhawk_play_input_sequence's screenshot_every instead. " +
      "BEHAVIOR: DESTRUCTIVE TO TARGET FILE: overwrites the file at `path` if it exists. The image is read back from disk and inlined; if the file can't be read (e.g. BizHawk runs on a different filesystem than this server), the tool still succeeds and returns the path with a note instead of the image. Returns an error if the parent directory doesn't exist or the core doesn't expose client.screenshot — check `capabilities.screenshot` in bizhawk_get_info. " +
      "RETURNS: A text block 'Screenshot saved: PATH' followed by an inline PNG image content block.",
    inputSchema: {
      type: "object",
      properties: {
        path: { type: "string", description: "Optional absolute filesystem path for the PNG (e.g. /tmp/snap.png). Omit to use an auto-generated temp file. Parent directory must exist. Overwritten without prompt if present." },
      },
      additionalProperties: false,
    },
  },
  {
    name: "bizhawk_osd_message",
    description:
      "PURPOSE: Draw a short message in BizHawk's on-screen OSD message area. " +
      "USAGE: Annotate what the agent is doing during a recorded GIF/demo, or mark progress during a live session. Fire-and-forget — BizHawk renders and auto-fades the message, so it appears on screenshots taken shortly after. " +
      "BEHAVIOR: Calls gui.addmessage(message). Position and fade duration are fixed by BizHawk (not configurable). Errors if gui.addmessage is unavailable. " +
      "RETURNS: Confirmation echoing the message.",
    inputSchema: {
      type: "object",
      properties: {
        message: { type: "string", minLength: 1, description: "Text to display in the OSD message area." },
      },
      required: ["message"],
      additionalProperties: false,
    },
  },

  // ── Save state ─────────────────────────────────────────────────────────

  {
    name: "bizhawk_save_state",
    description:
      "PURPOSE: Save the entire emulator state (RAM, CPU/PPU/APU registers, mapper state, sound chip state, timing) to a file at the given path. " +
      "USAGE: Use as a rollback point before risky writes, to bookmark interesting game states, or to share repro states. The companion bizhawk_load_state can perfectly restore from this file. BizHawk's savestate API is path-based (NOT slot-based like mGBA's). " +
      "BEHAVIOR: DESTRUCTIVE TO TARGET FILE: overwrites the file at `path` if it exists, with no prompt or backup. The state file is bound to the EXACT ROM and BizHawk core version that produced it — loading it on a different ROM or core version usually crashes the core. Returns an error if the parent directory doesn't exist, the path isn't writable, or the core doesn't expose savestate.save. " +
      "RETURNS: Single line 'Saved state to PATH'.",
    inputSchema: {
      type: "object",
      required: ["path"],
      properties: {
        path: { type: "string", description: "Absolute filesystem path to write the .State file to (extension is convention, not required). Parent directory must exist. File is overwritten without prompt if present." },
      },
      additionalProperties: false,
    },
  },
  {
    name: "bizhawk_load_state",
    description:
      "PURPOSE: Restore the emulator from a previously saved .State file at the given path. " +
      "USAGE: Counterpart to bizhawk_save_state. Use to undo a sequence of writes/inputs (the snapshot/experiment/restore workflow), to jump to a bookmarked game state, or to start each tool-call sequence from a known baseline. To start fresh from console boot instead, use bizhawk_reset. " +
      "BEHAVIOR: DESTRUCTIVE TO LIVE STATE: replaces ALL current emulator state (RAM, registers, mapper, audio, framecount) with the file's contents. Anything not previously snapshotted is lost. The state file MUST come from the same ROM and same BizHawk core version that produced it — loading an incompatible state typically crashes the core. The bridge preserves the pause state across the load: if the emulator was paused before loading, it is re-paused in the same callback (ZERO frames run in between); pass pause=true to force a paused state after load regardless. Returns an error if the file doesn't exist, isn't a valid BizHawk state, or the core doesn't expose savestate.load. " +
      "RETURNS: Single line 'Loaded state from PATH (paused/running)'.",
    inputSchema: {
      type: "object",
      required: ["path"],
      properties: {
        path:  { type: "string", description: "Absolute filesystem path to an existing .State file produced by bizhawk_save_state on this same ROM and BizHawk core version. Loading mismatched files typically crashes the core." },
        pause: { type: "boolean", default: false, description: "If true, the emulator is left PAUSED after the load even if it was running before. If false/omitted, the pre-load pause state is preserved. Either way, no frames run between the load and the pause taking effect." },
      },
      additionalProperties: false,
    },
  },
  {
    name: "bizhawk_wait_for_memory",
    description:
      "PURPOSE: Advance emulation frame-by-frame until a memory value satisfies a condition (or a frame budget runs out), then return how long it took and the final value. " +
      "USAGE: Use to synchronize with game state instead of guessing frame counts — wait for RAM to initialize after boot (many systems, including the Genesis, have garbage/zero RAM until gameplay starts), wait for a room/level transition to complete, wait for a cutscene flag to clear. Combine with bizhawk_play_input_sequence: play the menu inputs, then wait_for_memory on a known game-state flag before reading RAM. For monitoring DURING an input sequence, use play_input_sequence's stop_on_memory_change instead. " +
      "BEHAVIOR: Steps frames server-side in a single bridge round-trip (pause state is preserved — a paused emulator is unpaused for the wait and re-paused after). No input is asserted during the wait. If the condition already holds at call time, returns immediately with frames_waited=0. If timeout_frames elapses without a match, returns matched=false (NOT an error) with the last observed value. Returns an error if the domain is unknown, the width is invalid, or emu.frameadvance is unavailable. " +
      "RETURNS: Single line 'Condition met/NOT met after N frames. Value: VAL. Framecount: M'.",
    inputSchema: {
      type: "object",
      required: ["address"],
      properties: {
        address: { type: "integer", minimum: 0, description: "Byte offset within the chosen memory domain to watch (0-based per-domain)." },
        domain:  { type: "string", description: DOMAIN_PARAM_DESC },
        width: {
          type: "string",
          enum: WIDTH_ENUM,
          default: "u8",
          description: WIDTH_PARAM_DESC,
        },
        condition: {
          type: "string",
          enum: ["eq", "ne", "gt", "lt", "change"],
          default: "ne",
          description: "Predicate to wait for: 'eq' value == `value`, 'ne' value != `value`, 'gt' value > `value`, 'lt' value < `value`, 'change' value differs from what it was at call time (no `value` needed). Default 'ne'.",
        },
        value: {
          type: "integer",
          description: "Comparison operand for eq/ne/gt/lt. Required unless condition is 'change'.",
        },
        timeout_frames: {
          type: "integer",
          minimum: 1,
          default: 600,
          description: "Maximum frames to wait (default 600 ≈ 10 seconds of game time at 60Hz). On expiry the call returns matched=false rather than erroring. The RPC timeout scales with this value automatically.",
        },
        turbo: {
          type: "boolean",
          default: false,
          description: "Run at maximum emulation speed with rendering disabled (rendering stays ON if screenshots are requested). Restores 100% speed + visible rendering afterwards — note this resets any custom speed the user had set. Wall-clock speedup is typically 10-50×.",
        },
      },
      additionalProperties: false,
    },
  },
  {
    name: "bizhawk_read_many",
    description:
      "PURPOSE: Read a labeled set of memory values in ONE bridge round-trip and return them as 'name = value' lines. " +
      "USAGE: The default way to poll game state (HP, coordinates, timers, flags) between actions — one call instead of N sequential read8/read16 calls, and the labels keep the output self-documenting. For values laid out as fixed-stride records use bizhawk_read_struct_array; for observation DURING an input sequence use play_input_sequence's observe_memory. " +
      "BEHAVIOR: No side effects — pure reads, all performed within the same emulated frame. Returns an error if any entry names an unknown domain, an invalid width, or an out-of-range address (the whole call fails — no partial results). " +
      "RETURNS: One line per read, in request order: 'NAME = VAL_DEC (0xVAL_HEX)' (hex omitted for negative signed values).",
    inputSchema: {
      type: "object",
      required: ["reads"],
      properties: {
        reads: {
          type: "array",
          minItems: 1,
          maxItems: 128,
          description: "Reads to perform. Each: {name, address, width?, domain?}.",
          items: {
            type: "object",
            required: ["name", "address"],
            additionalProperties: false,
            properties: {
              name:    { type: "string", description: "Label for this value in the output. Choose something semantic (e.g. 'hp', 'puck_x')." },
              address: { type: "integer", minimum: 0, description: "Byte offset within the chosen memory domain (0-based per-domain)." },
              width:   { type: "string", enum: WIDTH_ENUM, default: "u8", description: WIDTH_PARAM_DESC },
              domain:  { type: "string", description: DOMAIN_PARAM_DESC },
            },
          },
        },
      },
      additionalProperties: false,
    },
  },
  {
    name: "bizhawk_read_struct_array",
    description:
      "PURPOSE: Decode an array of fixed-stride records (entity tables, object lists) from emulator memory into labeled per-record values, in ONE round-trip. " +
      "USAGE: For game entity tables laid out as N consecutive structs — e.g. 12 player structs of 0x80 bytes each starting at a base address. Define each field once ({name, offset, width}) and get every record decoded. For scattered unrelated addresses use bizhawk_read_many instead. " +
      "BEHAVIOR: No side effects — pure reads within one emulated frame. Hard cap: count × fields ≤ 4096 values per call (chunk larger tables). Returns an error on unknown domain, invalid width, or any out-of-range read. " +
      "RETURNS: Header 'N records @ base ADDR_HEX stride S:' then one line per record: '[i] name=value name=value ...' with fields in request order.",
    inputSchema: {
      type: "object",
      required: ["base", "stride", "count", "fields"],
      properties: {
        base:   { type: "integer", minimum: 0, description: "Byte offset of record 0 within the chosen memory domain." },
        stride: { type: "integer", minimum: 1, description: "Bytes between consecutive records (record i starts at base + i*stride)." },
        count:  { type: "integer", minimum: 1, description: "Number of records to decode. count × fields must be ≤ 4096." },
        fields: {
          type: "array",
          minItems: 1,
          description: "Fields to decode from each record.",
          items: {
            type: "object",
            required: ["name", "offset"],
            additionalProperties: false,
            properties: {
              name:   { type: "string", description: "Label for this field in the output." },
              offset: { type: "integer", minimum: 0, description: "Byte offset of the field within each record." },
              width:  { type: "string", enum: WIDTH_ENUM, default: "u8", description: WIDTH_PARAM_DESC },
            },
          },
        },
        domain: { type: "string", description: DOMAIN_PARAM_DESC },
      },
      additionalProperties: false,
    },
  },
  {
    name: "bizhawk_freeze",
    description:
      "PURPOSE: Pin one or MANY memory addresses to fixed values — the bridge re-writes them after EVERY emulated frame until unfrozen (classic cheat freezing). " +
      "USAGE: Infinite health/time cheats, and pinning state during experiments (freeze the game clock while testing collision). Single address: pass address+value. Batch: pass entries=[{address,value,...},...] — one call instead of N; top-level width/domain act as defaults for every entry. Freezing the same address+domain again just updates the value. Use bizhawk_unfreeze to release, bizhawk_list_frozen to inspect. For a one-shot write use bizhawk_write8/16/32; to MIX writes/freezes/unfreezes in one call use bizhawk_memory_ops. " +
      "BEHAVIOR: DESTRUCTIVE: overwrites the address(es) every frame with no undo; the game's own writes are overridden one frame later at the latest. The first write happens immediately and validates domain/width/address (errors now, not silently later). Batch entries are applied in order; if one entry errors, earlier entries in the batch STAY frozen. Freezes live in the bridge — reloading the Lua script or restarting BizHawk clears them. Frozen values are re-asserted after each frame stepped by the bridge's own commands (frame_advance, play_input_sequence, wait_for_memory), but NOT for frames advanced inside a bizhawk_eval_lua chunk. " +
      "RETURNS: One 'Froze ADDR_HEX (DOMAIN) = VAL' line per address, then 'N address(es) frozen.'",
    inputSchema: {
      type: "object",
      properties: {
        address: { type: "integer", minimum: 0, description: "Byte offset within the chosen memory domain (0-based per-domain). Required unless entries is given." },
        value:   { type: "integer", minimum: 0, description: "Unsigned value to pin. For negative values pass the two's-complement unsigned form. Required unless entries is given." },
        width:   { type: "string", enum: WRITE_WIDTH_ENUM, default: "u8", description: "Write width. '_be' variants are big-endian (use on Genesis/Mega Drive). Default 'u8'. In batch mode this is the default width for entries that don't set their own." },
        domain:  { type: "string", description: DOMAIN_PARAM_DESC + " In batch mode this is the default domain for entries that don't set their own." },
        entries: {
          type: "array",
          minItems: 1,
          description: "Batch mode: freeze all of these in one call. Mutually exclusive with address/value.",
          items: {
            type: "object",
            required: ["address", "value"],
            properties: {
              address: { type: "integer", minimum: 0, description: "Byte offset within the entry's memory domain." },
              value:   { type: "integer", minimum: 0, description: "Unsigned value to pin." },
              width:   { type: "string", enum: WRITE_WIDTH_ENUM, description: "Overrides the top-level width for this entry." },
              domain:  { type: "string", description: "Overrides the top-level domain for this entry." },
            },
            additionalProperties: false,
          },
        },
      },
      additionalProperties: false,
    },
  },
  {
    name: "bizhawk_unfreeze",
    description:
      "PURPOSE: Release one, several, or all frozen memory addresses so the game can write them again. " +
      "USAGE: Counterpart to bizhawk_freeze. Pass the same address+domain used when freezing, addresses=[...] to release a batch in one call (all sharing the top-level domain), or all=true to clear everything. Unfreezing an address that isn't frozen is a no-op. To mix unfreezes with writes/freezes in one call use bizhawk_memory_ops. " +
      "BEHAVIOR: Stops the per-frame re-writes; does NOT restore any previous value — memory keeps whatever the freeze last wrote until the game overwrites it. " +
      "RETURNS: 'N address(es) frozen.' (the count remaining).",
    inputSchema: {
      type: "object",
      properties: {
        address:   { type: "integer", minimum: 0, description: "Address to release (required unless addresses or all=true). Must match the frozen entry's address." },
        addresses: { type: "array", minItems: 1, items: { type: "integer", minimum: 0 }, description: "Batch mode: release all of these (each matched against the top-level domain). Mutually exclusive with address/all." },
        domain:    { type: "string", description: "Domain of the frozen entry/entries (must match what was passed to bizhawk_freeze, including omission)." },
        all:       { type: "boolean", default: false, description: "Release every frozen address." },
      },
      additionalProperties: false,
    },
  },
  {
    name: "bizhawk_list_frozen",
    description:
      "PURPOSE: List the addresses currently being re-written every frame by bizhawk_freeze. " +
      "USAGE: Inspect freeze state before/after experiments, or to find the exact address+domain pair needed to unfreeze. " +
      "BEHAVIOR: No side effects — pure read of bridge state. " +
      "RETURNS: One line per entry: 'ADDR_HEX WIDTH = VALUE (DOMAIN)', or '(no frozen addresses)'.",
    inputSchema: { type: "object", properties: {}, additionalProperties: false },
  },
  {
    name: "bizhawk_memory_ops",
    description:
      "PURPOSE: Apply a MIXED batch of memory operations — one-shot writes, freezes, and unfreezes — in ONE bridge round-trip, all landing within the same emulated frame. " +
      "USAGE: Reconfigure a whole experiment in one call instead of one call per address: e.g. unfreeze two old cheat addresses, freeze four new ones, and poke a state variable, atomically from the game's point of view (the game never runs on a half-applied set). Top-level width/domain are per-op defaults. For a homogeneous batch, bizhawk_freeze entries / bizhawk_unfreeze addresses work too; for contiguous bytes use bizhawk_write_range. " +
      "BEHAVIOR: DESTRUCTIVE: writes and freezes overwrite memory with no undo (freeze semantics are exactly bizhawk_freeze's: re-written every frame until unfrozen, validated on first write). Ops apply in order; if one op errors, earlier ops in the batch STAY applied. Unfreezing an address that isn't frozen is a no-op. " +
      "RETURNS: One 'Wrote/Froze ADDR_HEX (DOMAIN) = VAL' or 'Unfroze ADDR_HEX (DOMAIN)' line per op, then 'N op(s) applied in one frame. M address(es) frozen.'",
    inputSchema: {
      type: "object",
      required: ["ops"],
      properties: {
        ops: {
          type: "array",
          minItems: 1,
          description: "Operations, applied in order within one frame.",
          items: {
            type: "object",
            required: ["op", "address"],
            properties: {
              op:      { type: "string", enum: ["write", "freeze", "unfreeze"], description: "write = one-shot write; freeze = pin every frame until unfrozen; unfreeze = release a pinned address." },
              address: { type: "integer", minimum: 0, description: "Byte offset within the op's memory domain (0-based per-domain)." },
              value:   { type: "integer", minimum: 0, description: "Unsigned value to write/pin (required for write and freeze; ignored for unfreeze). For negative values pass the two's-complement unsigned form." },
              width:   { type: "string", enum: WRITE_WIDTH_ENUM, description: "Overrides the top-level width for this op." },
              domain:  { type: "string", description: "Overrides the top-level domain for this op." },
            },
            additionalProperties: false,
          },
        },
        width:  { type: "string", enum: WRITE_WIDTH_ENUM, default: "u8", description: "Default width for ops that don't set their own. '_be' variants are big-endian (use on Genesis/Mega Drive)." },
        domain: { type: "string", description: DOMAIN_PARAM_DESC + " Default domain for ops that don't set their own." },
      },
      additionalProperties: false,
    },
  },
  {
    name: "bizhawk_eval_lua",
    description:
      "PURPOSE: Execute an arbitrary Lua chunk inside the BizHawk bridge and return its result — the escape hatch for anything the other tools don't cover. " +
      "USAGE: Prototype new capabilities (custom loops, gui drawing, APIs like tastudio/genesis-specific calls) before promoting them to real tools. The chunk sees BizHawk's Lua globals: memory, emu, client, joypad, savestate, movie, gui, event, comm. Return a value with `return ...` — it comes back JSON-encoded. If the chunk steps frames itself, pass timeout_ms scaled to the work. " +
      "BEHAVIOR: DESTRUCTIVE (potentially): the chunk can write memory, load states, reboot the core — anything the Lua API allows, with no sandbox. Runs synchronously inside the bridge's poll loop; a chunk that never returns wedges the bridge until the RPC times out (and possibly beyond — avoid unbounded loops; use emu.frameadvance-bounded loops). Errors in the chunk (parse or runtime) return as tool errors without harming the bridge. The return value must be JSON-encodable: nil/boolean/number/string, array-like or string-keyed tables. Frames advanced INSIDE the chunk (e.g. calling emu.frameadvance) do NOT run the bridge's per-frame hooks: frozen addresses are not re-asserted and no trace rows are written for those frames. If the chunk steps frames (emu.frameadvance) while the emulator is paused it will block until unpaused — pass unpause:true to run the chunk via the bridge's pause-safe path (or use bizhawk_frame_advance instead). " +
      "RETURNS: The chunk's return value as pretty-printed JSON, '(nil)' if it returned nothing, or a JSON array when the chunk returns multiple values. Multiple return values with an embedded nil (e.g. return 1, nil, 3) produce a hole in the JSON array and may be truncated — return a table instead if you need to preserve nils.",
    inputSchema: {
      type: "object",
      required: ["code"],
      properties: {
        code: { type: "string", description: "Lua 5.4 chunk to execute, e.g. \"return emu.framecount()\" or \"memory.write_u16_be(0xC468, 0x0300, '68K RAM') return true\"." },
        timeout_ms: { type: "integer", minimum: 10000, description: "RPC timeout override in milliseconds. Only EXTENDS the timeout — values at or below the server's 10s default have no effect. Set this when the chunk advances many frames (~20ms per frame)." },
        unpause: { type: "boolean", description: "If true, run the chunk with the emulator temporarily unpaused (restoring the prior pause state afterward). Set this when the chunk calls emu.frameadvance — otherwise frame-stepping inside the chunk BLOCKS until something unpauses the emulator. Default false." },
      },
      additionalProperties: false,
    },
  },
  {
    name: "bizhawk_search_begin",
    description:
      "PURPOSE: Start a Cheat-Engine-style RAM search: snapshot a memory window bridge-side so subsequent bizhawk_search_filter calls can narrow candidate addresses by how their values change. " +
      "USAGE: THE way to find an unknown address holding a visible quantity (HP, missiles, timer). Workflow: search_begin → cause a change in-game → search_filter(condition) → repeat until few candidates remain → search_results. Replaces reading 4KiB hex dumps into context and diffing manually. One session at a time; calling again discards the previous session. " +
      "BEHAVIOR: No game-state side effects — reads a snapshot into bridge memory (window capped at 2 MiB; the snapshot lives in the Lua VM until search_end or script reload). Omitting length uses the whole domain from `start`. Returns an error on unknown domain, invalid width, or an oversize window. " +
      "RETURNS: 'Search started: N bytes @ START_HEX (WIDTH, DOMAIN) — M potential candidates.'",
    inputSchema: {
      type: "object",
      properties: {
        domain: { type: "string", description: DOMAIN_PARAM_DESC },
        start:  { type: "integer", minimum: 0, default: 0, description: "Byte offset where the search window begins. Default 0." },
        length: { type: "integer", minimum: 1, description: "Window size in bytes (max 2097152). Omit to search the whole domain from `start`." },
        width:  { type: "string", enum: WRITE_WIDTH_ENUM, default: "u8", description: "Value width candidates are compared at. '_be' variants big-endian (Genesis). Every byte offset is considered (unaligned values are found)." },
      },
      additionalProperties: false,
    },
  },
  {
    name: "bizhawk_search_filter",
    description:
      "PURPOSE: Narrow the active RAM search: keep only candidate addresses whose CURRENT value satisfies the condition versus either a literal value (eq/ne/gt/lt) or the previous snapshot (changed/unchanged/increased/decreased), then re-snapshot. " +
      "USAGE: After search_begin, alternate game actions with filters: fire a missile → filter 'decreased'; stand still → filter 'unchanged'; know the exact value → filter 'eq' with value. Each filter compares against the state at the PREVIOUS filter (or begin), then the current state becomes the new baseline. " +
      "BEHAVIOR: No game-state side effects. The candidate list only ever shrinks. Returns an error if no search is active or a comparison value is missing. " +
      "RETURNS: 'N candidate(s) remain.' plus up to 20 sample lines 'ADDR_HEX = VALUE'.",
    inputSchema: {
      type: "object",
      required: ["condition"],
      properties: {
        condition: {
          type: "string",
          enum: ["eq", "ne", "gt", "lt", "changed", "unchanged", "increased", "decreased"],
          description: "eq/ne/gt/lt compare against `value`; changed/unchanged/increased/decreased compare against each address's value at the previous filter (or search_begin).",
        },
        value: { type: "integer", description: "Comparison operand — required for eq/ne/gt/lt, ignored otherwise." },
      },
      additionalProperties: false,
    },
  },
  {
    name: "bizhawk_search_results",
    description:
      "PURPOSE: List the surviving candidate addresses of the active RAM search with their CURRENT values. " +
      "USAGE: Call once filtering has narrowed the field (≲100 candidates) to get the full list; verify a candidate by writing to it (bizhawk_write8/16) and observing the game. " +
      "BEHAVIOR: No side effects. Values are re-read fresh (they may differ from the last filter's sample). Returns an error if no search is active or no filter has run yet. " +
      "RETURNS: 'N candidate(s):' plus up to `limit` lines 'ADDR_HEX = VALUE'.",
    inputSchema: {
      type: "object",
      properties: {
        limit: { type: "integer", minimum: 1, maximum: 500, default: 100, description: "Maximum candidates to list. Default 100." },
      },
      additionalProperties: false,
    },
  },
  {
    name: "bizhawk_search_end",
    description:
      "PURPOSE: End the active RAM search and free the bridge-side snapshot memory. " +
      "USAGE: After the target address is found, or to abandon a search. Optional but polite — search_begin also discards any previous session. " +
      "BEHAVIOR: No game-state side effects. Never errors, even with no active search. " +
      "RETURNS: 'Search ended.'",
    inputSchema: { type: "object", properties: {}, additionalProperties: false },
  },
  {
    name: "bizhawk_get_registers",
    description:
      "PURPOSE: Read every CPU register of the emulated system (PC, data/address registers, flags — names vary per core; 68K cores expose PC/D0-D7/A0-A7 etc.). " +
      "USAGE: Reverse-engineering entry point — read PC to see where execution is, correlate with a disassembly, inspect state at a trap hit (bizhawk_trap_memory embeds registers automatically). Pair with bizhawk_pause for a stable readout. " +
      "BEHAVIOR: No side effects — pure read. Register support varies by core; returns an error if emu.getregisters is unavailable on the loaded core. " +
      "RETURNS: One line per register, sorted by name: 'NAME = VAL_DEC (0xVAL_HEX)'.",
    inputSchema: { type: "object", properties: {}, additionalProperties: false },
  },
  {
    name: "bizhawk_set_register",
    description:
      "PURPOSE: Write a value into a CPU register of the emulated system. " +
      "USAGE: Advanced RE surgery — redirect PC, patch a data register mid-experiment. Get valid register names from bizhawk_get_registers first (they're core-specific and case-sensitive). " +
      "BEHAVIOR: DESTRUCTIVE: alters live CPU state with no undo (snapshot via bizhawk_save_state first); wrong values typically crash the emulated program. Returns an error if emu.setregister is unavailable on the loaded core; unknown register names are silently ignored by some cores. " +
      "RETURNS: 'Set register NAME = VALUE'.",
    inputSchema: {
      type: "object",
      required: ["name", "value"],
      properties: {
        name:  { type: "string", description: "Register name exactly as reported by bizhawk_get_registers (core-specific, case-sensitive), e.g. 'PC', 'D0', 'A7'." },
        value: { type: "integer", description: "Value to write (unsigned; width per register)." },
      },
      additionalProperties: false,
    },
  },
  {
    name: "bizhawk_disassemble",
    description:
      "PURPOSE: Disassemble one or more machine instructions at an address (or at the current PC). " +
      "USAGE: Pair with bizhawk_trap_memory (which reports the PC of a trapped access) and bizhawk_get_registers to inspect the code the CPU is about to run — the core loop for reverse-engineering a game routine. " +
      "BEHAVIOR: Calls emu.disassemble(address[, domain]) and walks forward by each instruction's byte length to decode `count` instructions. Defaults to the current PC (from emu.getregisters) when `address` is omitted. Reads from the System Bus domain unless `domain` is given. Core-dependent: errors if the loaded core exposes no disassembler. " +
      "RETURNS: One line per instruction — `0xADDR: <mnemonic>  (<len> bytes)`.",
    inputSchema: {
      type: "object",
      properties: {
        address: { type: "integer", minimum: 0, description: "Start address. Omit to disassemble from the current PC." },
        count: { type: "integer", minimum: 1, maximum: 128, description: "Number of instructions to decode (default 1, max 128)." },
        domain: { type: "string", description: "Memory domain to read code from (default: System Bus)." },
      },
      additionalProperties: false,
    },
  },
  {
    name: "bizhawk_trap_memory",
    description:
      "PURPOSE: Run emulation until the CPU writes / reads / executes a specific address, then report the access — including the CPU registers (PC!) at that instant — or time out after a frame budget. " +
      "USAGE: THE 'who writes this address?' tool for reverse engineering: trap kind='write' on a game-state variable, poke the game (or just let it run), and the returned PC points at the writing instruction in the disassembly. kind='exec' answers 'does this routine run?'. Registers hooks only for the duration of the call. " +
      "BEHAVIOR: Advances emulation (game time passes) until the first matching access or timeout_frames elapses; a timeout returns normally (NOT an error). Event hooks are CORE-DEPENDENT — returns an error naming the missing capability on cores without event.on_bus_*. The trap monitors the exact address only (not a range) on the system bus. Pause state is preserved; turbo is supported. " +
      "RETURNS: On hit: 'TRAPPED KIND @ ADDR_HEX after N frame(s). value: V' plus one 'NAME = DEC (HEX)' line per CPU register at the moment of access. On timeout: 'No KIND to ADDR_HEX within N frame(s).'",
    inputSchema: {
      type: "object",
      required: ["address"],
      properties: {
        address: { type: "integer", minimum: 0, description: "SYSTEM BUS address to monitor (event hooks address the bus, not per-domain offsets — on Genesis use the 0xFFxxxx form of a RAM address)." },
        kind: { type: "string", enum: ["write", "read", "exec"], default: "write", description: "Access type to trap. Default 'write'." },
        timeout_frames: { type: "integer", minimum: 1, default: 600, description: "Maximum frames to run (default 600 ≈ 10s game time). Timeout returns a result, not an error. RPC timeout scales automatically." },
        turbo: { type: "boolean", default: false, description: "Run at maximum emulation speed with rendering disabled while waiting; restores 100% + visible afterwards." },
      },
      additionalProperties: false,
    },
  },
  {
    name: "bizhawk_record_input",
    description:
      "PURPOSE: Record the HUMAN player's controller input frame-by-frame for up to max_frames (or until a memory value changes), returning a run-length-encoded frame list that can be replayed verbatim via bizhawk_play_input_sequence. " +
      "USAGE: 'Show me the move' workflow — ask the user to perform the maneuver while this records, then replay/modify it programmatically. Set stop_on_memory_change to a room/level/state address to end the recording exactly at a transition. Emulation runs at normal speed during recording (the human must be able to play!). " +
      "BEHAVIOR: Advances emulation for the duration (game time passes; the bridge is blocked, like play_input_sequence). No input is injected — it purely samples joypad.get each frame. Buttons come back with the active core's names. A timeout (max_frames reached) is a normal result. " +
      "RETURNS: 'Recorded N frame(s) in K entr(y/ies)[, stopped early (memory changed)].' followed by the frames as a JSON array of {buttons, hold} — paste directly into bizhawk_play_input_sequence.frames. Entries capture buttons only; on playback player defaults to 1, so for a non-player-1 recording add `player` to each entry before replay.",
    inputSchema: {
      type: "object",
      properties: {
        max_frames: { type: "integer", minimum: 1, default: 600, description: "Maximum frames to record (default 600 ≈ 10 seconds at 60Hz). RPC timeout scales automatically." },
        player: { type: "integer", minimum: 1, default: 1, description: "Player/controller number to sample. Default 1." },
        stop_on_memory_change: {
          type: "object",
          required: ["address"],
          additionalProperties: false,
          description: "Optional. End the recording the moment this memory value changes from its value at call time (e.g. a room ID at a door transition).",
          properties: {
            address: { type: "integer", minimum: 0, description: "Byte offset within the chosen memory domain to monitor." },
            domain:  { type: "string", description: DOMAIN_PARAM_DESC },
            width:   { type: "string", enum: WIDTH_ENUM, default: "u8", description: WIDTH_PARAM_DESC },
          },
        },
      },
      additionalProperties: false,
    },
  },
  {
    name: "bizhawk_get_input",
    description:
      "PURPOSE: Read the CURRENT joypad state for a player — which buttons are held this instant, plus any analog axis values. " +
      "USAGE: Confirm that buttons you sent via bizhawk_press_buttons / bizhawk_play_input_sequence actually landed, or observe live human input. Complements bizhawk_record_input (which samples across frames). " +
      "BEHAVIOR: Calls joypad.get(player) and splits the result into held buttons (booleans that are true) and analog axes (numbers). Does NOT advance frames. Returns an error if joypad.get is unavailable — check capabilities.joypad_get in bizhawk_get_info. " +
      "RETURNS: A text summary of held buttons (or '(none)') and any axes.",
    inputSchema: {
      type: "object",
      properties: {
        player: { type: "integer", minimum: 1, description: "Controller port to read (default 1)." },
      },
      additionalProperties: false,
    },
  },
  {
    name: "bizhawk_movie_play",
    description:
      "PURPOSE: Load and play a BizHawk .bk2 movie from frame 0 (power-on), using BizHawk's native movie engine. " +
      "USAGE: Deterministic replay of TAS movies / recorded runs without the bridge shipping inputs (native playback is frame-perfect and fast). Omit `path` to restart the currently loaded movie. Check progress with bizhawk_movie_status; detach with bizhawk_movie_stop. " +
      "BEHAVIOR: DESTRUCTIVE TO LIVE STATE: resets the core to power-on before playback — current game state is lost (savestate first if needed). The .bk2 must match the loaded ROM and the authoring CORE (header records it; mismatches fail to load or desync). Returns an error if movie.play_from_start is unavailable or the file fails to load. " +
      "RETURNS: 'Movie: PATH (loaded, mode: MODE, length: N)'.",
    inputSchema: {
      type: "object",
      properties: {
        path: { type: "string", description: "Absolute path to a .bk2 movie file. Omit to restart the currently loaded movie from frame 0." },
      },
      additionalProperties: false,
    },
  },
  {
    name: "bizhawk_movie_stop",
    description:
      "PURPOSE: Stop the active movie (playback or recording) and return to normal emulation. " +
      "USAGE: Detach from a movie started with bizhawk_movie_play, e.g. to take manual/bridge control at an interesting frame. " +
      "BEHAVIOR: Emulation continues from the current frame; the movie file is not modified by stopping playback. Returns an error if movie.stop is unavailable. " +
      "RETURNS: 'Movie stopped.'",
    inputSchema: { type: "object", properties: {}, additionalProperties: false },
  },
  {
    name: "bizhawk_movie_status",
    description:
      "PURPOSE: Report the movie engine's state: whether a movie is loaded, its mode (PLAY/RECORD/FINISHED/INACTIVE), filename, and length in frames. " +
      "USAGE: Poll during bizhawk_movie_play to see progress (compare bizhawk_get_info framecount to length); confirm mode before issuing inputs (inputs are ignored during PLAY). " +
      "BEHAVIOR: No side effects — pure read. " +
      "RETURNS: 'Movie: FILE (loaded, mode: MODE, length: N)' or 'No movie loaded.'",
    inputSchema: { type: "object", properties: {}, additionalProperties: false },
  },
  {
    name: "bizhawk_save_slot",
    description:
      "PURPOSE: Save the full emulator state under a NAME (no filesystem paths needed) — the server stores it in a managed directory, namespaced by ROM hash. " +
      "USAGE: The convenient form of bizhawk_save_state for bookmarks and experiment rollback points ('before-boss', 'baseline'). Use bizhawk_load_slot to restore and bizhawk_list_slots to browse. Use bizhawk_save_state instead when you need the file at a specific path. " +
      "BEHAVIOR: DESTRUCTIVE TO SLOT: overwrites an existing slot of the same name for this ROM. Requires the MCP server and BizHawk to share a filesystem (true for local setups; the state directory is $MCP_BIZHAWK_STATE_DIR or ~/.mcp-bizhawk/states). State files are core-version-bound like all BizHawk states. " +
      "RETURNS: 'Saved slot 'NAME' → PATH'.",
    inputSchema: {
      type: "object",
      required: ["name"],
      properties: {
        name: { type: "string", description: "Slot name: 1-64 chars of letters, digits, dot, underscore, hyphen. Namespaced per ROM hash automatically." },
      },
      additionalProperties: false,
    },
  },
  {
    name: "bizhawk_load_slot",
    description:
      "PURPOSE: Restore the emulator from a named slot previously saved with bizhawk_save_slot for the currently loaded ROM. " +
      "USAGE: Counterpart to bizhawk_save_slot — the snapshot/experiment/rollback loop without path bookkeeping. Pass pause=true to freeze immediately after restoring. " +
      "BEHAVIOR: DESTRUCTIVE TO LIVE STATE: replaces all current emulator state. Slots are looked up by the CURRENT ROM's hash — a slot saved under a different ROM won't be found (this is a safety feature: cross-ROM state loads crash cores). A missing name returns an error listing available slots. " +
      "RETURNS: 'Loaded slot 'NAME' (paused|running)'.",
    inputSchema: {
      type: "object",
      required: ["name"],
      properties: {
        name:  { type: "string", description: "Slot name as given to bizhawk_save_slot." },
        pause: { type: "boolean", default: false, description: "Leave the emulator paused after the load (zero frames run in between)." },
      },
      additionalProperties: false,
    },
  },
  {
    name: "bizhawk_list_slots",
    description:
      "PURPOSE: List the named savestate slots stored for the currently loaded ROM. " +
      "USAGE: Browse rollback points before choosing what to load; check what a previous session left behind. " +
      "BEHAVIOR: No side effects. Slots are per-ROM (matched by hash); slots of other ROMs are not shown. " +
      "RETURNS: One line per slot: 'NAME  (SIZE bytes, MTIME_ISO)', or '(no slots saved for this ROM)'.",
    inputSchema: { type: "object", properties: {}, additionalProperties: false },
  },
  {
    name: "bizhawk_trace_start",
    description:
      "PURPOSE: Start (or rotate) the bridge's per-frame trace CSV — a game-specific dump of entity/game state written after every emulated frame (as configured in the bridge script; the stock bridge_JD.lua traces NHL94 player structs, puck, RNG, and pad state). " +
      "USAGE: Rotate to a fresh file before an experiment so the CSV covers exactly that run; re-enable after bizhawk_trace_stop. The osd flag also toggles the on-screen overlay. NOTE: the trace layout is defined in the bridge script for a specific game — on other ROMs it records garbage; stop it or ignore it there. " +
      "BEHAVIOR: DESTRUCTIVE TO TARGET FILE: opens `path` in write mode (truncates). Closes any previously open trace file first. Tracing costs a few hundred memory reads per frame. " +
      "RETURNS: 'Trace started → PATH (osd: on|off)'.",
    inputSchema: {
      type: "object",
      properties: {
        path: { type: "string", description: "File path for the CSV. Omit to reuse the bridge's default (per-port /tmp/nhl94_trace_<port>.csv)." },
        osd:  { type: "boolean", description: "Also enable/disable the on-screen animation overlay. Omit to leave unchanged." },
      },
      additionalProperties: false,
    },
  },
  {
    name: "bizhawk_trace_stop",
    description:
      "PURPOSE: Stop the per-frame trace CSV and flush/close the file. " +
      "USAGE: End-of-experiment bookend for bizhawk_trace_start; also use to eliminate tracing overhead or stop garbage traces on non-supported ROMs. " +
      "BEHAVIOR: Flushes buffered rows and closes the file; the CSV remains on disk for analysis. Calling with no active trace is a no-op. " +
      "RETURNS: 'Trace stopped after N rows (PATH)'.",
    inputSchema: { type: "object", properties: {}, additionalProperties: false },
  },
  {
    name: "bizhawk_trace_status",
    description:
      "PURPOSE: Report whether the per-frame trace is active, its file path, row count, and OSD state. " +
      "USAGE: Find the CSV path before reading it (bizhawk_trace_tail or direct file access); sanity-check that a trace is running before an experiment. " +
      "BEHAVIOR: No side effects. " +
      "RETURNS: 'Trace active|inactive: PATH, N rows, osd: on|off'.",
    inputSchema: { type: "object", properties: {}, additionalProperties: false },
  },
  {
    name: "bizhawk_trace_tail",
    description:
      "PURPOSE: Return the trace CSV's header line plus its last N rows — a quick look at recent frame-by-frame game state without leaving the tool interface. " +
      "USAGE: Spot-check what the game did during the last action (animation frames, positions, RNG) right after a play_input_sequence. For bulk analysis read the CSV file directly instead — rows are wide (~250 columns on NHL94). " +
      "BEHAVIOR: No side effects. Reads the file from the server's filesystem (requires server and BizHawk to share one — true locally). Buffered rows are flushed every 60 frames, so the very newest rows may lag slightly. Returns an error if the trace file has never been started or the file is unreadable. " +
      "RETURNS: 'PATH (N rows, active: yes|no)' + the CSV header + the last N data rows.",
    inputSchema: {
      type: "object",
      properties: {
        rows: { type: "integer", minimum: 1, maximum: 200, default: 10, description: "How many trailing data rows to return. Default 10 (rows are ~800 chars wide on NHL94)." },
      },
      additionalProperties: false,
    },
  },
  {
    name: "bizhawk_phys_trace_start",
    description:
      "PURPOSE: Start the bridge's physics-sync trace — one CSV row per NHL94 `updateplayers` physics tick (NOT per video frame), each carrying the per-pass D7 step multiplier latched inside the retail Gameloop. " +
      "USAGE: The right trace when you need physics-tick resolution and the actual D7 sub-step count per tick (e.g. speed/acceleration work), which the per-frame bizhawk_trace_* dump cannot expose. Start → drive input (bizhawk_play_input_sequence) → bizhawk_phys_trace_stop. " +
      "BEHAVIOR: RETAIL nhl94.gen ONLY — hash-guarded (MD5 8356B3F0…), so it errors on any other ROM, and errors on cores without event.on_bus_exec. Registers two bus-exec hooks in the Gameloop. While active it SUPPRESSES the per-video-frame bizhawk_trace_* writer. DESTRUCTIVE TO TARGET FILE: opens `path` in write mode (truncates). " +
      "RETURNS: 'Physics-sync trace started → PATH (latch ADDR, emit ADDR)'.",
    inputSchema: {
      type: "object",
      properties: {
        path: { type: "string", description: "File path for the CSV. Omit to reuse the bridge default /tmp/nhl94_phys_<port>.csv." },
      },
      additionalProperties: false,
    },
  },
  {
    name: "bizhawk_phys_trace_stop",
    description:
      "PURPOSE: Stop the physics-sync trace and flush/close the file. " +
      "USAGE: End-of-experiment bookend for bizhawk_phys_trace_start; also re-enables the per-video-frame bizhawk_trace_* writer. " +
      "BEHAVIOR: Removes the bus-exec hooks, flushes buffered rows, closes the file (the CSV remains on disk). Calling with no active phys trace is a no-op. " +
      "RETURNS: 'Physics-sync trace stopped after N ticks (PATH)'.",
    inputSchema: { type: "object", properties: {}, additionalProperties: false },
  },
  {
    name: "bizhawk_phys_trace_status",
    description:
      "PURPOSE: Report whether the physics-sync trace is active, its file path, tick count, and last latched D7. " +
      "USAGE: Find the CSV path before reading it (bizhawk_phys_trace_tail or direct file access); sanity-check that the trace is running and that D7 is being latched before an experiment. " +
      "BEHAVIOR: No side effects. " +
      "RETURNS: 'Physics-sync trace active|inactive: PATH, N ticks, last D7: N'.",
    inputSchema: { type: "object", properties: {}, additionalProperties: false },
  },
  {
    name: "bizhawk_phys_trace_tail",
    description:
      "PURPOSE: Return the physics-sync CSV's header line plus its last N rows — a quick look at recent physics ticks without leaving the tool interface. " +
      "USAGE: Spot-check per-tick D7 and slot-2 state right after a play_input_sequence. The phys CSV is narrow (11 columns: tick,frame,d7,pad,x,xsub,y,ysub,xv,yv,fdir), so a tail reads cleanly here. " +
      "BEHAVIOR: No side effects. Reads the file from the server's filesystem (requires server and BizHawk to share one — true locally). Rows are buffered, so the very newest may lag slightly. Returns an error if the phys trace has never been started or the file is unreadable. " +
      "RETURNS: 'PATH (N ticks, active: yes|no)' + the CSV header + the last N data rows.",
    inputSchema: {
      type: "object",
      properties: {
        rows: { type: "integer", minimum: 1, maximum: 200, default: 10, description: "How many trailing data rows to return. Default 10." },
      },
      additionalProperties: false,
    },
  },
];

function ok(text: string) {
  return { content: [{ type: "text" as const, text }] };
}
function fmtHex(n: unknown): string {
  if (typeof n !== "number") return String(n);
  return `${n} (0x${n.toString(16).toUpperCase()})`;
}
function addrHex(n: number): string {
  return `0x${n.toString(16).toUpperCase().padStart(4, "0")}`;
}
function fmtMovieStatus(r: { loaded: boolean; mode?: string; filename?: string; length?: number }): string {
  if (!r.loaded && !r.filename) return "No movie loaded.";
  return `Movie: ${r.filename ?? "(unnamed)"} (${r.loaded ? "loaded" : "not loaded"}, mode: ${r.mode ?? "?"}, length: ${r.length ?? "?"})`;
}

// Named savestate slots, managed server-side under
// $MCP_BIZHAWK_STATE_DIR or ~/.mcp-bizhawk/states, namespaced per ROM hash.
// Read at call time so the env var can change (and tests can override it).
function stateDir(): string {
  return process.env.MCP_BIZHAWK_STATE_DIR ?? path.join(os.homedir(), ".mcp-bizhawk", "states");
}
function slotPath(hash: string, name: string): string {
  if (typeof name !== "string") throw new Error("slot name must be a string");
  if (!/^[A-Za-z0-9._-]{1,64}$/.test(name)) {
    throw new Error("slot name must be 1-64 chars of letters, digits, dot, underscore, hyphen");
  }
  return path.join(stateDir(), hash, `${name}.State`);
}
async function currentRomHash(bh: BizhawkServer): Promise<string> {
  const info = await bh.call<{ rom_hash?: string }>("get_info");
  return info.rom_hash && info.rom_hash !== "unavailable" ? info.rom_hash : "unknown-rom";
}

export function registerTools(server: Server, bh: BizhawkServer): void {
  server.setRequestHandler(ListToolsRequestSchema, async () => ({ tools: TOOLS }));

  server.setRequestHandler(CallToolRequestSchema, async (req) => {
    const { name, arguments: args = {} } = req.params;
    const p = args as Record<string, unknown>;
    const a = () => p.address as number;
    const dom = () => p.domain ? { domain: p.domain } : {};
    const bo  = () => p.byteorder ? { byteorder: p.byteorder } : {};

    switch (name) {
      case "bizhawk_ping": {
        // Always answer with the server identity, even with no BizHawk
        // attached — so ping doubles as a "which build am I running?" check
        // without needing the emulator up.
        if (!bh.isConnected()) {
          return ok(`mcp-bizhawk v${VERSION} — server up, BizHawk NOT connected (${bh.describeTarget()})`);
        }
        if (!bh.isBridgeReady()) {
          return ok(`mcp-bizhawk v${VERSION} — BizHawk connected, but bridge_JD.lua is not polling yet (load it via Tools > Lua Console)`);
        }
        try {
          const r = await bh.call<string>("ping");
          return ok(`${r} (mcp-bizhawk v${VERSION}, bridge polling)`);
        } catch (err) {
          return ok(`mcp-bizhawk v${VERSION} — server up, but the bridge did not answer: ${(err as Error).message}`);
        }
      }

      case "bizhawk_get_info": {
        const r = await bh.call<{
          bridge?: { name?: string; version?: string; pause_safe?: boolean };
          rom_name?: string;
          rom_hash?: string;
          framecount?: number;
          system_id?: string;
          lag_count?: number;
          is_lagged?: boolean;
          paused?: boolean;
          movie_loaded?: boolean;
          movie_mode?: string;
          memory_domains?: string[];
          current_memory_domain?: string;
          capabilities?: Record<string, boolean>;
        }>("get_info");
        const lines = [
          `Server:     mcp-bizhawk v${VERSION}`,
          `Bridge:     ${r.bridge
            ? `${r.bridge.name ?? "?"} v${r.bridge.version ?? "?"}${r.bridge.pause_safe ? " (pause-safe)" : ""}`
            : "(legacy — no identity block; pause support unverified)"}`,
          `ROM:        ${r.rom_name ?? "(unavailable)"}`,
          `ROM hash:   ${r.rom_hash ?? "(unavailable)"}`,
          `Framecount: ${r.framecount ?? "(unavailable)"}`,
          `System:     ${r.system_id ?? "(unavailable)"}`,
        ];
        if (r.paused !== undefined) lines.push(`Paused:     ${r.paused ? "yes" : "no"}`);
        if (r.lag_count !== undefined) {
          lines.push(`Lag frames: ${r.lag_count}${r.is_lagged ? " (current frame IS a lag frame)" : ""}`);
        }
        if (r.movie_mode) {
          lines.push(`Movie:      ${r.movie_loaded ? "loaded" : "not loaded"} (${r.movie_mode})`);
        }
        if (r.memory_domains?.length) {
          lines.push("");
          lines.push(`Memory domains: ${r.memory_domains.join(", ")}`);
          if (r.current_memory_domain) {
            lines.push(`Active domain (used when 'domain' is omitted): ${r.current_memory_domain}`);
          }
        }
        if (r.capabilities) {
          const missing = Object.entries(r.capabilities).filter(([, v]) => !v).map(([k]) => k);
          if (missing.length) {
            lines.push("");
            lines.push(`Missing capabilities on this BizHawk build: ${missing.join(", ")}`);
          }
        }
        return ok(lines.join("\n"));
      }

      case "bizhawk_list_memory_domains": {
        const r = await bh.call<string[]>("list_memory_domains");
        return ok("Memory domains:\n  " + r.join("\n  "));
      }

      case "bizhawk_read8":  return ok(`${addrHex(a())}: ${fmtHex(await bh.call<number>("read8", { address: a(), ...dom() }))}`);
      case "bizhawk_read16": return ok(`${addrHex(a())}: ${fmtHex(await bh.call<number>("read16", { address: a(), ...dom(), ...bo() }))}`);
      case "bizhawk_read32": return ok(`${addrHex(a())}: ${fmtHex(await bh.call<number>("read32", { address: a(), ...dom(), ...bo() }))}`);

      case "bizhawk_read_range": {
        const bytes = await bh.call<number[]>("read_range", { address: a(), length: p.length, ...dom() });
        const hex = bytes.map((b) => b.toString(16).padStart(2, "0").toUpperCase()).join(" ");
        return ok(`${addrHex(a())} [${bytes.length} bytes${p.domain ? `, ${p.domain}` : ""}]:\n${hex}`);
      }

      case "bizhawk_write8": {
        await bh.call("write8", { address: a(), value: p.value, ...dom() });
        return ok(`Wrote ${fmtHex(p.value)} → ${addrHex(a())}${p.domain ? ` (${p.domain})` : ""}`);
      }
      case "bizhawk_write16": {
        await bh.call("write16", { address: a(), value: p.value, ...dom(), ...bo() });
        return ok(`Wrote ${fmtHex(p.value)} → ${addrHex(a())}${p.domain ? ` (${p.domain})` : ""}`);
      }
      case "bizhawk_write32": {
        await bh.call("write32", { address: a(), value: p.value, ...dom(), ...bo() });
        return ok(`Wrote ${fmtHex(p.value)} → ${addrHex(a())}${p.domain ? ` (${p.domain})` : ""}`);
      }
      case "bizhawk_write_range": {
        const r = await bh.call<{ written: number }>("write_range", { address: a(), bytes: p.bytes, ...dom() });
        return ok(`Wrote ${r.written} bytes → ${addrHex(a())}${p.domain ? ` (${p.domain})` : ""}`);
      }

      case "bizhawk_press_buttons": {
        await bh.call("press_buttons", { buttons: p.buttons, player: p.player ?? 1 });
        const pressed = Object.entries(p.buttons as Record<string, boolean>)
          .filter(([, v]) => v).map(([k]) => k);
        return ok(`Set joypad ${p.player ?? 1}: ${pressed.length ? pressed.join("+") : "(all released)"}`);
      }

      case "bizhawk_play_input_sequence": {
        const params: Record<string, unknown> = { frames: p.frames };
        if (p.screenshot_every       !== undefined) params.screenshot_every       = p.screenshot_every;
        if (p.screenshot_dir         !== undefined) params.screenshot_dir         = p.screenshot_dir;
        if (p.screenshot_prefix      !== undefined) params.screenshot_prefix      = p.screenshot_prefix;
        if (p.observe_memory         !== undefined) params.observe_memory         = p.observe_memory;
        if (p.stop_on_memory_change  !== undefined) params.stop_on_memory_change  = p.stop_on_memory_change;
        if (p.turbo                  !== undefined) params.turbo                  = p.turbo;
        // Total EMULATED frames (each entry's `hold` counts N) drives the timeout.
        const totalFrames = (p.frames as { hold?: number }[]).reduce(
          (sum, f) => sum + (f.hold ?? 1), 0,
        );
        const r = await bh.call<{
          played: number;
          final_framecount?: number;
          stopped_early?: boolean;
          stop_reason?: string;
          observations?: {
            frame_offset: number;
            path?: string;
            memory?: Record<string, number>;
          }[];
        }>("play_input_sequence", params, { timeoutMs: frameTimeout(totalFrames) });

        // Array.isArray guard: a bridge that captured zero observations may
        // send JSON {} (Lua's empty-table ambiguity) instead of [] / omitted.
        const obs = Array.isArray(r.observations) ? r.observations : [];
        const lines = [
          `Played ${r.played} frames. Final framecount: ${r.final_framecount ?? "(unavailable)"}.`,
        ];
        if (r.stopped_early) {
          lines.push(`Stopped early — reason: ${r.stop_reason ?? "(unspecified)"}.`);
        }
        lines.push(`Captured ${obs.length} observation${obs.length === 1 ? "" : "s"}.`);
        // Per-observation lines so the agent can correlate inline images with state
        for (let i = 0; i < obs.length; i++) {
          const o = obs[i];
          const memStr = o.memory
            ? ` memory={${Object.entries(o.memory).map(([k, v]) => `${k}=${v}`).join(", ")}}`
            : "";
          const imgStr = o.path ? ` (image ${i + 1})` : "";
          lines.push(`  obs[${i}] frame_offset=${o.frame_offset}${memStr}${imgStr}`);
        }

        // Build the multi-content response: text summary + per-observation
        // inline image blocks. We read each PNG from disk (Lua wrote it),
        // base64-encode for MCP transport.
        const content: ({ type: "text"; text: string } | { type: "image"; data: string; mimeType: string })[] = [
          { type: "text", text: lines.join("\n") },
        ];
        for (const o of obs) {
          if (!o.path) continue;
          try {
            const bytes = fs.readFileSync(o.path);
            content.push({
              type: "image",
              data: bytes.toString("base64"),
              mimeType: "image/png",
            });
          } catch (err) {
            content.push({
              type: "text",
              text: `(failed to read observation at frame ${o.frame_offset} from ${o.path}: ${(err as Error).message})`,
            });
          }
        }
        return { content };
      }

      case "bizhawk_pause":         await bh.call("pause");          return ok("Emulation paused");
      case "bizhawk_unpause":       await bh.call("unpause");        return ok("Emulation resumed");
      case "bizhawk_reset":         await bh.call("reset");          return ok("Core reset");
      case "bizhawk_frame_advance": {
        const count = (p.count as number) ?? 1;
        const faParams: Record<string, unknown> = { count };
        if (p.turbo !== undefined) faParams.turbo = p.turbo;
        const f = await bh.call<number>("frame_advance", faParams, { timeoutMs: frameTimeout(count) });
        return ok(`Advanced ${count} frame(s). Framecount: ${f}`);
      }

      case "bizhawk_wait_for_memory": {
        const timeoutFrames = (p.timeout_frames as number) ?? 600;
        const params: Record<string, unknown> = { address: a(), ...dom() };
        if (p.width          !== undefined) params.width          = p.width;
        if (p.condition      !== undefined) params.condition      = p.condition;
        if (p.value          !== undefined) params.value          = p.value;
        if (p.timeout_frames !== undefined) params.timeout_frames = p.timeout_frames;
        if (p.turbo          !== undefined) params.turbo          = p.turbo;
        const r = await bh.call<{
          matched: boolean;
          frames_waited: number;
          value: number;
          final_framecount?: number;
        }>("wait_for_memory", params, { timeoutMs: frameTimeout(timeoutFrames) });
        return ok(
          `Condition ${r.matched ? "met" : "NOT met (timeout)"} after ${r.frames_waited} frame(s). ` +
          `Value: ${fmtHex(r.value)}. Framecount: ${r.final_framecount ?? "(unavailable)"}`,
        );
      }

      case "bizhawk_read_many": {
        const reads = p.reads as { name: string }[];
        const r = await bh.call<Record<string, number>>("read_many", { reads });
        const lines = reads.map((s) => {
          const v = r[s.name];
          return `${s.name} = ${typeof v === "number" && v < 0 ? v : fmtHex(v)}`;
        });
        return ok(lines.join("\n"));
      }

      case "bizhawk_read_struct_array": {
        const fields = p.fields as { name: string }[];
        const r = await bh.call<Record<string, number>[]>("read_struct_array", {
          base: p.base, stride: p.stride, count: p.count, fields, ...dom(),
        });
        const lines = r.map(
          (rec) => `[${rec._index}] ` + fields.map((f) => `${f.name}=${rec[f.name]}`).join(" "),
        );
        return ok(
          `${r.length} records @ base ${addrHex(p.base as number)} stride ${p.stride}:\n${lines.join("\n")}`,
        );
      }

      case "bizhawk_freeze": {
        if (p.entries !== undefined) {
          if (p.address !== undefined || p.value !== undefined) {
            throw new Error("pass either address+value or entries, not both");
          }
          const entries = p.entries as { address: number; value: number; width?: string; domain?: string }[];
          const params: Record<string, unknown> = { entries, ...dom() };
          if (p.width !== undefined) params.width = p.width;
          const r = await bh.call<{ frozen_count: number }>("freeze", params);
          const lines = entries.map((e) => {
            const d = e.domain ?? p.domain;
            return `Froze ${addrHex(e.address)}${d ? ` (${d})` : ""} = ${fmtHex(e.value)}`;
          });
          return ok(`${lines.join("\n")}\n${r.frozen_count} address(es) frozen.`);
        }
        if (p.address === undefined || p.value === undefined) {
          throw new Error("address+value required (or pass entries for a batch)");
        }
        const params: Record<string, unknown> = { address: a(), value: p.value, ...dom() };
        if (p.width !== undefined) params.width = p.width;
        const r = await bh.call<{ frozen_count: number }>("freeze", params);
        return ok(
          `Froze ${addrHex(a())}${p.domain ? ` (${p.domain})` : ""} = ${fmtHex(p.value)}. ` +
          `${r.frozen_count} address(es) frozen.`,
        );
      }
      case "bizhawk_unfreeze": {
        const params: Record<string, unknown> = {};
        if (p.address   !== undefined) params.address   = p.address;
        if (p.addresses !== undefined) params.addresses = p.addresses;
        if (p.domain    !== undefined) params.domain    = p.domain;
        if (p.all       !== undefined) params.all       = p.all;
        const r = await bh.call<{ frozen_count: number }>("unfreeze", params);
        return ok(`${r.frozen_count} address(es) frozen.`);
      }
      case "bizhawk_list_frozen": {
        const r = await bh.call<{
          count: number;
          frozen?: { address: number; width: string; value: number; domain?: string }[];
        }>("list_frozen");
        const list = Array.isArray(r.frozen) ? r.frozen : [];
        if (list.length === 0) return ok("(no frozen addresses)");
        return ok(list
          .map((f) => `${addrHex(f.address)} ${f.width} = ${f.value}${f.domain ? ` (${f.domain})` : ""}`)
          .join("\n"));
      }
      case "bizhawk_memory_ops": {
        const ops = p.ops as { op: string; address: number; value?: number; width?: string; domain?: string }[];
        const params: Record<string, unknown> = { ops, ...dom() };
        if (p.width !== undefined) params.width = p.width;
        const r = await bh.call<{ applied: number; frozen_count: number }>("memory_ops", params);
        const lines = ops.map((o) => {
          const d = o.domain ?? p.domain;
          const loc = `${addrHex(o.address)}${d ? ` (${d})` : ""}`;
          if (o.op === "unfreeze") return `Unfroze ${loc}`;
          return `${o.op === "freeze" ? "Froze" : "Wrote"} ${loc} = ${fmtHex(o.value)}`;
        });
        return ok(`${lines.join("\n")}\n${r.applied} op(s) applied in one frame. ${r.frozen_count} address(es) frozen.`);
      }

      case "bizhawk_eval_lua": {
        const opts = p.timeout_ms !== undefined ? { timeoutMs: p.timeout_ms as number } : {};
        const params: Record<string, unknown> = { code: p.code };
        if (p.unpause !== undefined) params.unpause = p.unpause;
        const r = await bh.call<unknown>("eval_lua", params, opts);
        return ok(r === undefined || r === null ? "(nil)" : JSON.stringify(r, null, 2));
      }

      case "bizhawk_search_begin": {
        const params: Record<string, unknown> = { ...dom() };
        if (p.start  !== undefined) params.start  = p.start;
        if (p.length !== undefined) params.length = p.length;
        if (p.width  !== undefined) params.width  = p.width;
        const r = await bh.call<{
          start: number; length: number; width: string; potential_candidates: number;
        }>("search_begin", params);
        return ok(
          `Search started: ${r.length} bytes @ ${addrHex(r.start)} (${r.width}${p.domain ? `, ${p.domain}` : ""}) — ` +
          `${r.potential_candidates} potential candidates.`,
        );
      }
      case "bizhawk_search_filter": {
        const params: Record<string, unknown> = { condition: p.condition };
        if (p.value !== undefined) params.value = p.value;
        const r = await bh.call<{
          count: number; sample?: { address: number; value: number }[];
        }>("search_filter", params);
        const sample = Array.isArray(r.sample) ? r.sample : [];
        const lines = [`${r.count} candidate(s) remain.`];
        for (const s of sample) lines.push(`  ${addrHex(s.address)} = ${s.value}`);
        if (r.count > sample.length && sample.length > 0) {
          lines.push(`  ... (${r.count - sample.length} more — use bizhawk_search_results)`);
        }
        return ok(lines.join("\n"));
      }
      case "bizhawk_search_results": {
        const params: Record<string, unknown> = {};
        if (p.limit !== undefined) params.limit = p.limit;
        const r = await bh.call<{
          count: number; results?: { address: number; value: number }[];
        }>("search_results", params);
        const results = Array.isArray(r.results) ? r.results : [];
        const lines = [`${r.count} candidate(s):`];
        for (const s of results) lines.push(`  ${addrHex(s.address)} = ${s.value}`);
        return ok(lines.join("\n"));
      }
      case "bizhawk_search_end": {
        await bh.call("search_end");
        return ok("Search ended.");
      }
      case "bizhawk_get_registers": {
        const r = await bh.call<Record<string, number>>("get_registers");
        const lines = Object.keys(r).sort().map((k) => `${k} = ${fmtHex(r[k])}`);
        return ok(lines.join("\n"));
      }
      case "bizhawk_set_register": {
        await bh.call("set_register", { name: p.name, value: p.value });
        return ok(`Set register ${p.name} = ${p.value}`);
      }

      case "bizhawk_disassemble": {
        const params: Record<string, unknown> = {};
        if (p.address !== undefined) params.address = p.address;
        if (p.count !== undefined) params.count = p.count;
        if (p.domain !== undefined) params.domain = p.domain;
        const r = await bh.call<{ instructions: { address: number; disasm: string; length: number }[] }>(
          "disassemble",
          params,
        );
        const lines = r.instructions.map(
          (i) => `0x${i.address.toString(16).toUpperCase()}: ${i.disasm}  (${i.length} bytes)`,
        );
        return ok(lines.join("\n"));
      }

      case "bizhawk_trap_memory": {
        const timeoutFrames = (p.timeout_frames as number) ?? 600;
        const kind = (p.kind as string) ?? "write";
        const params: Record<string, unknown> = { address: a(), kind };
        if (p.timeout_frames !== undefined) params.timeout_frames = p.timeout_frames;
        if (p.turbo          !== undefined) params.turbo          = p.turbo;
        const r = await bh.call<{
          hit?: { address: number; value?: number; registers?: Record<string, number>; framecount?: number };
          frames_waited: number;
          final_framecount?: number;
        }>("trap_memory", params, { timeoutMs: frameTimeout(timeoutFrames) });
        if (!r.hit) {
          return ok(`No ${kind} to ${addrHex(a())} within ${r.frames_waited} frame(s). Framecount: ${r.final_framecount ?? "(unavailable)"}`);
        }
        const lines = [
          `TRAPPED ${kind} @ ${addrHex(r.hit.address)} after ${r.frames_waited} frame(s). ` +
          `value: ${r.hit.value ?? "(n/a)"}. Framecount: ${r.hit.framecount ?? "(unavailable)"}`,
        ];
        if (r.hit.registers) {
          for (const k of Object.keys(r.hit.registers).sort()) {
            lines.push(`  ${k} = ${fmtHex(r.hit.registers[k])}`);
          }
        }
        return ok(lines.join("\n"));
      }

      case "bizhawk_record_input": {
        const maxFrames = (p.max_frames as number) ?? 600;
        const params: Record<string, unknown> = {};
        if (p.max_frames            !== undefined) params.max_frames            = p.max_frames;
        if (p.player                !== undefined) params.player                = p.player;
        if (p.stop_on_memory_change !== undefined) params.stop_on_memory_change = p.stop_on_memory_change;
        const r = await bh.call<{
          recorded: number;
          stopped_early?: boolean;
          frames?: { buttons: Record<string, boolean>; hold: number }[];
        }>("record_input", params, { timeoutMs: frameTimeout(maxFrames) });
        const frames = Array.isArray(r.frames) ? r.frames : [];
        const header =
          `Recorded ${r.recorded} frame(s) in ${frames.length} ${frames.length === 1 ? "entry" : "entries"}` +
          `${r.stopped_early ? ", stopped early (memory changed)" : ""}.`;
        return ok(`${header}\n${JSON.stringify(frames)}`);
      }

      case "bizhawk_get_input": {
        const params: Record<string, unknown> = {};
        if (p.player !== undefined) params.player = p.player;
        const r = await bh.call<{
          player: number;
          buttons?: Record<string, boolean>;
          axes?: Record<string, number>;
        }>("get_input", params);
        const held = r.buttons ? Object.keys(r.buttons).sort() : [];
        const lines = [`Player ${r.player} held buttons: ${held.length ? held.join(", ") : "(none)"}`];
        if (r.axes && Object.keys(r.axes).length) {
          lines.push(
            "Axes: " +
              Object.entries(r.axes)
                .sort(([a], [b]) => a.localeCompare(b))
                .map(([k, v]) => `${k}=${v}`)
                .join(", "),
          );
        }
        return ok(lines.join("\n"));
      }

      case "bizhawk_movie_play": {
        const params: Record<string, unknown> = {};
        if (p.path !== undefined) params.path = p.path;
        const r = await bh.call<{ loaded: boolean; mode?: string; filename?: string; length?: number }>(
          "movie_play", params, { timeoutMs: 30000 });
        return ok(fmtMovieStatus(r));
      }
      case "bizhawk_movie_stop": {
        await bh.call("movie_stop");
        return ok("Movie stopped.");
      }
      case "bizhawk_movie_status": {
        const r = await bh.call<{ loaded: boolean; mode?: string; filename?: string; length?: number }>("movie_status");
        return ok(fmtMovieStatus(r));
      }

      case "bizhawk_save_slot": {
        const hash = await currentRomHash(bh);
        const file = slotPath(hash, p.name as string);
        fs.mkdirSync(path.dirname(file), { recursive: true });
        await bh.call("save_state", { path: file });
        return ok(`Saved slot '${p.name}' → ${file}`);
      }
      case "bizhawk_load_slot": {
        const hash = await currentRomHash(bh);
        const file = slotPath(hash, p.name as string);
        if (!fs.existsSync(file)) {
          const dir = path.join(stateDir(), hash);
          const have = fs.existsSync(dir)
            ? fs.readdirSync(dir).filter((f) => f.endsWith(".State")).map((f) => f.slice(0, -6))
            : [];
          throw new Error(
            `no slot '${p.name}' for this ROM. Available: ${have.length ? have.join(", ") : "(none)"}`,
          );
        }
        const params: Record<string, unknown> = { path: file };
        if (p.pause !== undefined) params.pause = p.pause;
        const r = await bh.call<{ paused?: boolean }>("load_state", params);
        return ok(`Loaded slot '${p.name}' (${r.paused ? "paused" : "running"})`);
      }
      case "bizhawk_list_slots": {
        const hash = await currentRomHash(bh);
        const dir = path.join(stateDir(), hash);
        if (!fs.existsSync(dir)) return ok("(no slots saved for this ROM)");
        const entries = fs.readdirSync(dir).filter((f) => f.endsWith(".State")).sort()
          .map((f) => {
            const st = fs.statSync(path.join(dir, f));
            return `${f.slice(0, -6)}  (${st.size} bytes, ${st.mtime.toISOString()})`;
          });
        return ok(entries.length ? entries.join("\n") : "(no slots saved for this ROM)");
      }

      case "bizhawk_trace_start": {
        const params: Record<string, unknown> = {};
        if (p.path !== undefined) params.path = p.path;
        if (p.osd  !== undefined) params.osd  = p.osd;
        const r = await bh.call<{ path: string; osd: boolean }>("trace_start", params);
        return ok(`Trace started → ${r.path} (osd: ${r.osd ? "on" : "off"})`);
      }
      case "bizhawk_trace_stop": {
        const r = await bh.call<{ path?: string; frames: number }>("trace_stop");
        return ok(`Trace stopped after ${r.frames} rows${r.path ? ` (${r.path})` : ""}`);
      }
      case "bizhawk_trace_status": {
        const r = await bh.call<{ active: boolean; path?: string; frames: number; osd: boolean }>("trace_status");
        return ok(
          `Trace ${r.active ? "active" : "inactive"}: ${r.path ?? "(no file)"}, ${r.frames} rows, ` +
          `osd: ${r.osd ? "on" : "off"}`,
        );
      }
      case "bizhawk_trace_tail": {
        const st = await bh.call<{ active: boolean; path?: string }>("trace_status");
        if (!st.path) throw new Error("no trace file — the trace has never been started on this bridge");
        const rows = (p.rows as number) ?? 10;
        const text = fs.readFileSync(st.path, "utf8");
        const lines = text.trimEnd().split("\n");
        const header = lines[0];
        const tail = lines.slice(Math.max(1, lines.length - rows));
        return ok([
          `${st.path} (${lines.length - 1} rows, active: ${st.active ? "yes" : "no"})`,
          header,
          ...tail,
        ].join("\n"));
      }

      case "bizhawk_phys_trace_start": {
        const params: Record<string, unknown> = {};
        if (p.path !== undefined) params.path = p.path;
        const r = await bh.call<{ path: string; latch_addr: string; emit_addr: string }>(
          "phys_trace_start", params);
        return ok(`Physics-sync trace started → ${r.path} (latch ${r.latch_addr}, emit ${r.emit_addr})`);
      }
      case "bizhawk_phys_trace_stop": {
        const r = await bh.call<{ path?: string; ticks: number }>("phys_trace_stop");
        return ok(`Physics-sync trace stopped after ${r.ticks} ticks${r.path ? ` (${r.path})` : ""}`);
      }
      case "bizhawk_phys_trace_status": {
        const r = await bh.call<{ active: boolean; path?: string; ticks: number; latched_d7: number }>(
          "phys_trace_status");
        return ok(
          `Physics-sync trace ${r.active ? "active" : "inactive"}: ${r.path ?? "(no file)"}, ` +
          `${r.ticks} ticks, last D7: ${r.latched_d7}`);
      }
      case "bizhawk_phys_trace_tail": {
        const st = await bh.call<{ active: boolean; path?: string }>("phys_trace_status");
        if (!st.path) throw new Error("no phys trace file — the physics-sync trace has never been started on this bridge");
        const rows = (p.rows as number) ?? 10;
        const text = fs.readFileSync(st.path, "utf8");
        const lines = text.trimEnd().split("\n");
        const header = lines[0];
        const tail = lines.slice(Math.max(1, lines.length - rows));
        return ok([
          `${st.path} (${lines.length - 1} ticks, active: ${st.active ? "yes" : "no"})`,
          header,
          ...tail,
        ].join("\n"));
      }

      case "bizhawk_screenshot": {
        const target = (p.path as string | undefined)
          ?? path.join(os.tmpdir(), `mcp-bizhawk-shot-${process.pid}-${Date.now()}.png`);
        const saved = await bh.call<string>("screenshot", { path: target });
        let bytes: Buffer;
        try {
          bytes = fs.readFileSync(saved);
        } catch (err) {
          return ok(`Screenshot saved: ${saved} (could not inline image: ${(err as Error).message})`);
        }
        return {
          content: [
            { type: "text" as const, text: `Screenshot saved: ${saved}` },
            { type: "image" as const, data: bytes.toString("base64"), mimeType: "image/png" },
          ],
        };
      }

      case "bizhawk_osd_message": {
        const r = await bh.call<{ message: string }>("osd_message", { message: p.message });
        return ok(`OSD message shown: ${r.message}`);
      }

      case "bizhawk_save_state": {
        const r = await bh.call<{ path: string }>("save_state", { path: p.path });
        return ok(`Saved state to ${r.path}`);
      }
      case "bizhawk_load_state": {
        const params: Record<string, unknown> = { path: p.path };
        if (p.pause !== undefined) params.pause = p.pause;
        const r = await bh.call<{ path: string; paused?: boolean }>("load_state", params);
        return ok(`Loaded state from ${r.path} (${r.paused ? "paused" : "running"})`);
      }

      default:
        throw new Error(`Unknown tool: ${name}`);
    }
  });
}
