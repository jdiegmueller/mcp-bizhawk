import {
  CallToolRequestSchema,
  ListToolsRequestSchema,
  Tool,
} from "@modelcontextprotocol/sdk/types.js";
import type { Server } from "@modelcontextprotocol/sdk/server/index.js";
import type { BizhawkServer } from "./bizhawk.js";
import type { BizhawkBackend } from "./backend.js";
import { errorCode } from "./errors.js";
import { VERSION } from "./version.js";
import { describeImage, requireVisionConfig, visionConfig, type VisionConfig } from "./vision.js";
import * as nhl94 from "./nhl94.js";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import crypto from "node:crypto";

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

const targetProp = {
  target: {
    type: "string" as const,
    minLength: 1,
    description: "BizHawk backend label. Use bizhawk_list_backends to see available targets.",
  },
};


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
    inputSchema: { type: "object", required: ["target"], properties: { ...targetProp } },
  },
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
  {
    name: "bizhawk_get_info",
    description:
      "PURPOSE: Get the loaded ROM's name and hash, current frame count, the list of available memory domains, the active default domain (the one used when 'domain' is omitted on read/write tool calls), and the bridge's capability map (which optional emu/client/savestate/joypad/memory methods this BizHawk build exposes). " +
      "USAGE: Call after bizhawk_ping to learn what system is loaded and which optional features are available; before any memory tool call to confirm the active domain and avoid silent reads from the wrong address space; before pause / unpause / reset / screenshot / save_state / load_state to check the corresponding `capabilities.*` flag. Do NOT call this just to re-check framecount/pause/domain after an action — press_buttons, frame_advance, pause / unpause / reset, load_state, load_slot, and play_input_sequence each ride a compact `State:` line (frame/paused/lag/domain) back inline. " +
      "BEHAVIOR: No side effects — pure read of emulator metadata. Returns 'unavailable' for fields the loaded core doesn't expose (rom_name when no ROM is loaded, framecount on cores without emu.framecount, etc.). " +
      "RETURNS: Multi-line text with ROM, ROM hash, framecount, memory_domains list, active domain, and a list of any missing capabilities for this build.",
    inputSchema: { type: "object", required: ["target"], properties: { ...targetProp } },
  },
  {
    name: "bizhawk_list_memory_domains",
    description:
      "PURPOSE: List the memory domains available on the loaded core (e.g. 'WRAM', 'CARTRAM', 'VRAM', 'System Bus' on SNES; 'RAM', 'PPU', 'OAM' on NES). " +
      "USAGE: Call before any memory r/w tool when you don't know the domain layout for the loaded system. The returned names are exactly what to pass as the `domain` parameter on bizhawk_read*/write* tools (case-sensitive). " +
      "BEHAVIOR: No side effects — pure read. Returns an error if the loaded BizHawk core doesn't implement memory.getmemorydomainlist (extremely rare). " +
      "RETURNS: Newline-formatted list of domain names, one per line.",
    inputSchema: { type: "object", required: ["target"], properties: { ...targetProp } },
  },

  // ── Memory reads ────────────────────────────────────────────────────────

  {
    name: "bizhawk_read8",
    description:
      "PURPOSE: Read an unsigned 8-bit byte from emulator memory at the given address. " +
      "USAGE: Use for single-byte status flags, counters, and 8-bit fields. For 16- or 32-bit values use bizhawk_read16/read32 (one call instead of multi-byte assembly); for spans of more than ~4 bytes use bizhawk_read_range (one round-trip instead of N frame-latency hops); for several scattered addresses at once use bizhawk_read_many (one labeled round-trip). " +
      "BEHAVIOR: No side effects — pure read. Reads work the same way whether emulation is paused or running. Returns an error if the named domain doesn't exist, the address is out of range for the domain, or the loaded core doesn't expose memory.read_u8. " +
      "RETURNS: Single line 'ADDR_HEX: VAL_DEC (0xVAL_HEX)', e.g. '0x09C6: 99 (0x63)'.",
    inputSchema: {
      type: "object",
      required: ["target", "address"],
      properties: { ...targetProp, 
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
      required: ["target", "address"],
      properties: { ...targetProp, 
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
      required: ["target", "address"],
      properties: { ...targetProp, 
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
      "USAGE: Use for >4 bytes (one round-trip vs N frame-latency hops). Max 4096 bytes/call (BizHawk serialization limit); chunk larger reads in 4 KiB. To hunt an unknown address, PREFER bizhawk_search_begin/filter (diffs bridge-side) over pulling hex dumps into context and diffing by hand. " +
      "BEHAVIOR: No side effects — pure read. Returns an error if domain is unknown, length is out of 1-4096, or address+length exceeds the domain. " +
      "RETURNS: 'ADDR_HEX [N bytes, DOMAIN]:' header + space-separated 2-digit uppercase hex bytes.",
    inputSchema: {
      type: "object",
      required: ["target", "address", "length"],
      properties: { ...targetProp, 
        address: { type: "integer", minimum: 0, description: "Starting byte offset within the chosen memory domain (0-based per-domain, NOT a system-bus address). Reads [address, address+length)." },
        length:  { type: "integer", minimum: 1, maximum: 4096, description: "Number of bytes to read (1-4096; hard cap is BizHawk's per-call serialization limit)." },
        domain:  { type: "string", description: DOMAIN_PARAM_DESC },
      },
      additionalProperties: false,
    },
  },

  {
    name: "bizhawk_ram_snapshot",
    description:
      "PURPOSE: Snapshot a contiguous memory range to a named binary file on the server side (with a sha256 digest) — the tool for reverse-engineering by RAM diffing across game states, instead of hand-rolling a memory-dump loop in bizhawk_eval_lua. " +
      "USAGE: Capture the same range in several states (e.g. gameplay vs menu vs title) then diff the named files to isolate the bytes that track a state/flag — exactly the workflow used to hunt game-phase globals. Defaults to the whole 64 KiB Genesis work RAM ('68K RAM', base 0, size 0x10000). The `digest` alone lets you cheaply tell whether two states differ without re-reading. Pair with bizhawk_search_begin/filter when you want the bridge to diff for you against a live-changing value instead. " +
      "BEHAVIOR: No side effects on the emulator — pure reads, chunked into ≤4096-byte read_range calls and assembled + written server-side. DESTRUCTIVE to the named snapshot file. Errors if the domain is unknown or the range exceeds it. Do not pass filesystem paths; omit `name` for an auto name. " +
      "RETURNS: 'SNAPSHOT NAME (N bytes, DOMAIN @0xBASE) sha256=…'. The server keeps the file path private; use the snapshot name for follow-up.",
    inputSchema: {
      type: "object",
      required: ["target"],
      properties: { ...targetProp, 
        base: { type: "integer", minimum: 0, default: 0, description: "Starting byte offset within the domain (0-based per-domain). Default 0." },
        size: { type: "integer", minimum: 1, maximum: 1048576, default: 65536, description: "Number of bytes to snapshot (default 65536 = full 64 KiB 68K RAM; max 1 MiB)." },
        domain: { type: "string", description: "Memory domain (default '68K RAM' — the Genesis work RAM)." },
        name: { type: "string", description: "Optional snapshot name: 1-64 chars of letters, digits, dot, underscore, hyphen. `.bin` is appended if omitted. Omit for an auto name." },
      },
      additionalProperties: false,
    },
  },

  {
    name: "bizhawk_trap_exec",
    description:
      "PURPOSE: Persistent, multi-address execution-site capture — arm exec hooks at ROM addresses that ACCUMULATE register/memory snapshots into per-trap buffers across normally-driven frames, then read them back. The built-in replacement for hand-rolling event.on_bus_exec capture loops in bizhawk_eval_lua (the dominant reverse-engineering use). " +
      "USAGE: Unlike bizhawk_trap_memory (one address, first hit only, self-advances then unregisters), this stays armed so you drive gameplay yourself (bizhawk_frame_advance / bizhawk_observe_frames / bizhawk_play_input_sequence / live play) and it records every hit up to a limit. Lifecycle: 'start', drive frames/input, verify the intended stimulus actually occurred, then 'read' or 'read_stop'. `read` and `status` do NOT stop hooks; always call `stop` when finished if you did not use read_stop. Use read_mode:'summary' for transcript-friendly output, or jsonl_file/csv_file for large captures. ZERO HITS alone does not prove a code path is unreachable: first verify frames advanced and, for NHL94 interaction experiments, use nhl94_state to confirm interaction_gate is OPEN plus actual movement/contact/animation. Each trap: {addr, name?, capture?, limit?}. `capture` tokens: registers 'D0'-'D7'/'A0'-'A7'/'PC'/'SR', or memory '@0xADDR:width' (absolute) / '@REG[+/-0xOFF]:width' (register-relative, e.g. '@A3+0x28:s16' reads the checker's x-velocity) — width u8/s8/u16/s16/u32/s32 (16/32 big-endian). Omit `capture` to snapshot all M68K registers. Every entry also carries `f` (framecount). " +
      "BEHAVIOR: 'start' registers event.on_bus_exec hooks (errors if the core lacks it) that persist until 'stop' or a bridge reload — REMEMBER to stop when done, as live hooks cost emulation speed. Clearing freezes, loading states, or applying NHL94 rigs does not stop these hooks. Buffers are bounded by `limit` (default 200/trap). Memory reads use the active domain (M68K BUS on Genesis); addresses masked to 24 bits. " +
      "RETURNS: 'start' the armed trap names; 'read' per-trap counts + the captured entries (JSON); 'status'/'stop' the counts.",
    inputSchema: {
      type: "object",
      properties: { ...targetProp, 
        action: { type: "string", enum: ["start", "read", "read_stop", "status", "stop"], description: "Lifecycle step. read_stop reads buffers and then stops hooks in one tool call." },
        traps: {
          type: "array",
          description: "For action=start: the exec sites to arm.",
          items: {
            type: "object",
            properties: {
              addr: { type: "integer", minimum: 0, description: "Instruction address to trap (system-bus address)." },
              name: { type: "string", description: "Buffer name for this trap (default t1, t2, …)." },
              capture: { type: "array", items: { type: "string" }, description: "Capture tokens (default: all M68K registers)." },
              limit: { type: "integer", minimum: 1, description: "Max entries to accumulate for this trap (default 200)." },
            },
            required: ["addr"],
            additionalProperties: false,
          },
        },
        name: { type: "string", description: "For action=read/read_stop: return only this trap's buffer (default: all). Also used in exported filenames." },
        limit: { type: "integer", minimum: 1, description: "Default per-trap entry cap for action=start (default 200)." },
        read_mode: {
          type: "string",
          enum: ["json", "summary", "jsonl_file", "csv_file"],
          default: "json",
          description: "For read/read_stop: json returns full inline JSON; summary returns head/tail only; jsonl_file/csv_file writes the capture server-side and returns the artifact name.",
        },
        head: { type: "integer", minimum: 0, default: 3, description: "For read_mode=summary: number of leading entries per trap to print." },
        tail: { type: "integer", minimum: 0, default: 3, description: "For read_mode=summary: number of trailing entries per trap to print." },
      },
      required: ["target", "action"],
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
      required: ["target", "address", "value"],
      properties: { ...targetProp, 
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
      required: ["target", "address", "value"],
      properties: { ...targetProp, 
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
      required: ["target", "address", "value"],
      properties: { ...targetProp, 
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
      required: ["target", "address", "bytes"],
      properties: { ...targetProp, 
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
      "For more than a few frames, PREFER bizhawk_play_input_sequence (batches N frames in ONE round-trip vs 2N here); to compare input variations from a savestate, use bizhawk_run_trials. Use this per-frame tool for single-frame or interactive stepping. " +
      "To HOLD a button across N consecutive frames, INTERLEAVE: call bizhawk_press_buttons + bizhawk_frame_advance(count=1) N times in a loop. " +
      "DO NOT call bizhawk_press_buttons once and then bizhawk_frame_advance(count=N) — only the first of those N frames sees the button; the rest are no-input. Verified empirically against SNES Super Metroid in May 2026: a 60-frame advance after a single press_buttons(Right) moved Samus the same +1 pixel as a 10-frame advance, because frames 2-60 had no input. " +
      "To release a button mid-hold, just stop calling press_buttons for it; the next frame_advance will see it released. " +
      "BEHAVIOR: Modifies emulator input state for the next frame poll only — no other side effects. Returns an error if the loaded core doesn't expose joypad.set. Button names that aren't valid for the active core are silently ignored by BizHawk (no error). " +
      "RETURNS: Single line 'Set joypad N: BUTTON+BUTTON+...' or '... (all released)' if nothing was pressed, plus a `State:` line (frame/paused/lag/domain) — no need to call bizhawk_get_info after. " +
      `\n\nButton names vary per system. Common names across cores: ${VALID_BUTTONS.join(", ")}. Use whatever names the active core understands — if unsure, try a name and check BizHawk's input display, or use bizhawk_get_info to confirm joypad_set is available.`,
    inputSchema: {
      type: "object",
      required: ["target", "buttons"],
      properties: { ...targetProp, 
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
      "USAGE: Use whenever you have ≥10 frames of inputs to play in order — TAS movie playback, scripted multi-frame sequences, AI-search of input patterns, agent-driven gameplay. ONE bridge round-trip ships N frames instead of the 2N round-trips you'd pay looping bizhawk_press_buttons + bizhawk_frame_advance(1). Use `hold` on each element to run-length-encode repeated input ({buttons:{}, hold:60} = 60 idle frames in one entry) — this keeps the JSON tiny for long sequences. The RPC timeout scales with the total frame count, so multi-thousand-frame batches are fine; the practical reason to chunk is responsiveness (the bridge can't service other calls mid-batch). To compare several input variations from ONE baseline savestate (reloaded per variation), use bizhawk_run_trials instead. Prefer `observe_every` over `screenshot_every` for a dense memory-only trajectory (no PNGs = far cheaper); set `describe`+`describe_prompt` to get vision-model TEXT back per screenshot instead of binary; pass `load_slot` to reload a named baseline and play in one round-trip. " +
      "EFFICIENCY: Do not recreate this with eval_lua frame loops, or with repeated press_buttons/frame_advance calls, unless you are prototyping bridge behavior that this tool cannot express. " +
      "FOR AGENT-DRIVEN PLAY: combine `screenshot_every`, `observe_memory`, and `stop_on_memory_change` for the killer pattern — 'walk right for up to 200 frames, observing screenshot+x+y+hp every second, but STOP the moment the room ID changes'. The agent sees: where Samus was at each second, AND whether the goal (room transition) was reached, AND screenshots for visual confirmation — all in one tool response. " +
      "BEHAVIOR: For each `frames` element, calls joypad.set with that frame's buttons then emu.frameadvance. The bridge's main poll loop is BLOCKED for the duration of the call (no other RPCs, no heartbeat) until the sequence finishes or fails. With `screenshot_every`, each captured screenshot adds ~1 frame of wall-clock. With `observe_memory`, each observation also reads the listed memory addresses at the same frame the screenshot was taken — values come back labeled by `name` in each observation's `memory` field. With `stop_on_memory_change`, the bridge records the listed address's value before the first frame, re-reads it after each frame, and aborts the sequence the moment it changes (a final observation is captured at the stop frame regardless of cadence). Returns an error if joypad.set / emu.frameadvance / client.screenshot is missing when needed, if any `observe_memory` entry references an unknown domain, if any `width` isn't 'u8' / 'u16' / 'u32', or if any address is out of range. " +
      "RETURNS: A text summary ('Played N frames. Final framecount: M. Stopped early: yes/no [reason]. Captured K observations with their memory values') followed by K inline image content blocks (one per observation, in frame order). Each observation in the text summary includes its frame_offset and labeled memory values so the agent can correlate the visible screenshot with the game state at that exact frame.",
    inputSchema: {
      type: "object",
      required: ["target", "frames"],
      properties: { ...targetProp, 
        load_slot: {
          type: "string",
          description:
            "Optional named slot to load IMMEDIATELY before playback begins, in the same round-trip. " +
            "Collapses the common 'load_state then play_input_sequence' trial loop into a single call: reset to a known baseline and run the sequence with no intermediate round-trip. This is intentionally NOT a paused inspection load: the bridge loads the state and immediately unpauses to play the sequence. The load happens before any stop_on_memory_change baseline is captured and before frame 0. Same ROM/core constraints as bizhawk_load_state. Omit to play from the current live state. Do not pass filesystem paths; the selected backend resolves the slot name.",
        },
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
        observe_every: {
          type: "integer",
          minimum: 1,
          description:
            "Optional. Capture an observation every N frames WITHOUT taking a screenshot — the token-cheap way to get a dense per-frame RAM trace. Pair with `observe_memory` to record labeled values every N frames (use 1 for every frame); the observations come back as text only, no inlined PNGs. Use this instead of `screenshot_every` whenever you want the memory trajectory but not the images. If both `observe_every` and `screenshot_every` are set, `screenshot_every` wins (its cadence points also carry screenshots).",
        },
        screenshot_every: {
          type: "integer",
          minimum: 1,
          description:
            "Optional. If set, capture a PNG screenshot every N frames during playback (and one extra at the final frame regardless of remainder). Each screenshot costs ~1 wall-clock frame for client.screenshot, so 60 (≈1 sec of game time) is a good default — captures meaningful state changes without doubling batch latency. Omit to skip screenshots. If `observe_memory` is also set, screenshots and memory reads happen at the same observation points. To capture memory WITHOUT screenshots (far fewer tokens), use `observe_every` instead. To get screenshots back as text descriptions rather than binary images, add `describe: true`.",
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
        describe: {
          type: "boolean",
          default: false,
          description: "If true, each captured screenshot is sent to the configured local vision model and returned as a TEXT caption instead of an inlined PNG — a large token saving on multi-screenshot plays. Only affects screenshot observations (those from `screenshot_every`); memory-only observations are unchanged. Requires VISION_BASE_URL + VISION_MODEL on the server.",
        },
        describe_prompt: {
          type: "string",
          description: "The question/instruction sent to the vision model with each screenshot when `describe` is true. Falls back to the server's VISION_DEFAULT_PROMPT.",
        },
      },
      additionalProperties: false,
    },
  },
  {
    name: "bizhawk_observe_frames",
    description:
      "PURPOSE: Passively advance N frames without injecting joypad input, capturing optional screenshots and/or labeled memory reads at a fixed cadence in one bridge round-trip. " +
      "USAGE: Use this when you need to watch the game evolve from its current input/human state, verify motion/contact after staging, or capture a memory trajectory without scripted inputs. For deliberate button playback use bizhawk_play_input_sequence; for a single blind step use bizhawk_frame_advance. Prefer observe_every with observe_memory for cheap RAM-only traces; use screenshot_every only when visual evidence matters. The RPC timeout scales with frame count, but the bridge cannot answer other calls until the observation batch finishes. " +
      "BEHAVIOR: Temporarily unpauses while advancing, re-applies bridge freezes/hooks each frame, and never calls joypad.set. With screenshot_every each captured image is returned inline unless describe:true requests text captions. Errors if emu.frameadvance is missing, if screenshot support is missing when requested, or if observe_memory references an invalid domain/address/width. Do not scrape screenshot files from disk; use the returned image/caption content. " +
      "RETURNS: A text summary ('Observed N frames. Final framecount: M. Captured K observations...') followed by image or caption content for screenshot observations.",
    inputSchema: {
      type: "object",
      required: ["target", "frames"],
      properties: { ...targetProp,
        frames: {
          type: "integer",
          minimum: 1,
          description: "Number of emulated frames to advance while passively observing.",
        },
        observe_every: {
          type: "integer",
          minimum: 1,
          description: "Capture a memory-only observation every N frames. If screenshot_every is also set, screenshot_every is the observation cadence.",
        },
        screenshot_every: {
          type: "integer",
          minimum: 1,
          description: "Capture a PNG screenshot every N frames, plus the final frame when it is off-cadence. Omit for memory-only observation.",
        },
        screenshot_prefix: {
          type: "string",
          description: "Filename prefix for server-managed screenshots. Do not pass filesystem paths.",
        },
        observe_memory: {
          type: "array",
          description: "Memory reads to perform at each observation point, keyed by name in the output.",
          items: {
            type: "object",
            required: ["name", "address", "width"],
            additionalProperties: false,
            properties: {
              name: { type: "string", description: "Semantic label for this reading." },
              domain: { type: "string", description: "Optional case-sensitive memory domain; omit for current domain." },
              address: { type: "integer", minimum: 0, description: "Byte offset within the chosen memory domain." },
              width: { type: "string", enum: WIDTH_ENUM, description: WIDTH_PARAM_DESC },
            },
          },
        },
        turbo: {
          type: "boolean",
          default: false,
          description: "Run at maximum speed with rendering disabled unless screenshots are requested. Restores normal speed/rendering afterwards.",
        },
        describe: {
          type: "boolean",
          default: false,
          description: "If true, screenshot observations are captioned by the configured vision model instead of returned as PNGs.",
        },
        describe_prompt: {
          type: "string",
          description: "Prompt sent to the vision model for screenshot observations.",
        },
      },
      additionalProperties: false,
    },
  },
  {
    name: "bizhawk_run_trials",
    description:
      "PURPOSE: Run a SWEEP of input experiments from one savestate — for each trial, reload the same baseline state, play that trial's input sequence, and read a shared set of memory values — all in ONE bridge round-trip, returning a per-trial table of outcomes. " +
      "USAGE: The tool for savestate-anchored parameter sweeps and input search: 'from this faceoff, try shot A, shot B, and a pass — where does the puck end up in each?'. Replaces the manual loop of (load_state → play_input_sequence → read) repeated once per candidate, which costs 3+ round-trips PER trial and floods the transcript with intermediate results. Here N trials cost one call and one compact table. Each trial reloads `state_slot` first, so trials are independent — trial K never sees trial K-1's mutations. For a single sequence with mid-play observation cadence or stop-on-change, use bizhawk_play_input_sequence with `load_slot`. " +
      "BEHAVIOR: For each trial in order: loads `state_slot`, intentionally unpauses to play the trial, plays the trial's `frames` (same hold/RLE semantics as play_input_sequence), then reads every `observe_memory` entry at the final frame and optionally captures one screenshot. This is a play/sweep tool, not a paused restore; use bizhawk_load_state for a paused inspection restore. The bridge's poll loop is BLOCKED for the whole sweep (no other RPCs) — the RPC timeout scales with the total frame count across all trials. Any pre-existing freezes are re-asserted each frame exactly as in play_input_sequence. Errors (unknown domain, invalid width, missing state file, missing joypad/frameadvance/screenshot capability) fail the whole call. " +
      "RETURNS: A text table — 'Ran N trials from slot NAME.' then one line per trial: '[name] played F, frame FC — label=value, ...' — followed by one inline PNG content block per trial that captured a screenshot, in trial order.",
    inputSchema: {
      type: "object",
      required: ["target", "state_slot", "trials"],
      properties: { ...targetProp, 
        state_slot: {
          type: "string",
          description: "Named slot reloaded before EVERY trial (the shared baseline). Same ROM/core constraints as bizhawk_load_state. Do not pass filesystem paths; the selected backend resolves the slot name.",
        },
        trials: {
          type: "array",
          minItems: 1,
          maxItems: 64,
          description: "The experiments to run, in order. Each reloads state_slot, plays its frames, then observes.",
          items: {
            type: "object",
            required: ["frames"],
            additionalProperties: false,
            properties: {
              name: { type: "string", description: "Label for this trial in the output table. Defaults to 'trial<N>' (1-based) if omitted." },
              frames: {
                type: "array",
                minItems: 1,
                description: "Per-frame inputs for this trial. Same shape as bizhawk_play_input_sequence.frames: [{buttons:{...}, player?, hold?}].",
                items: {
                  type: "object",
                  additionalProperties: false,
                  properties: {
                    buttons: { type: "object", additionalProperties: { type: "boolean" }, description: "Map of button name → pressed. Omit/empty = no input." },
                    player:  { type: "integer", minimum: 1, default: 1, description: "Player number (1-based). Default 1." },
                    hold:    { type: "integer", minimum: 1, default: 1, description: "Consecutive frames to repeat this input (RLE). Default 1." },
                  },
                },
              },
            },
          },
        },
        observe_memory: {
          type: "array",
          description: "Memory reads taken at the FINAL frame of each trial, shared across all trials. Each value lands in that trial's row keyed by `name`. Same entry shape as bizhawk_play_input_sequence.observe_memory.",
          items: {
            type: "object",
            required: ["name", "address", "width"],
            additionalProperties: false,
            properties: {
              name:    { type: "string", description: "Label for this reading in each trial's row." },
              domain:  { type: "string", description: "Optional memory domain. Omit for the currently selected domain." },
              address: { type: "integer", minimum: 0, description: "Byte offset within the chosen memory domain." },
              width:   { type: "string", enum: WIDTH_ENUM, description: WIDTH_PARAM_DESC },
            },
          },
        },
        screenshot: {
          type: "boolean",
          default: false,
          description: "If true, capture one PNG at the final frame of each trial and return them inline. Requires client.screenshot on the build.",
        },
        screenshot_prefix: {
          type: "string",
          description: "Filename prefix for per-trial screenshots. Default: 'trial'. Files are named `<prefix>-<NN>-<name>.png`.",
        },
        turbo: {
          type: "boolean",
          default: false,
          description: "Run the whole sweep at maximum emulation speed (rendering stays on if screenshots are requested). Restores 100% speed + visible rendering afterwards.",
        },
        describe: {
          type: "boolean",
          default: false,
          description: "If true (with `screenshot`), each trial's screenshot is sent to the configured local vision model and returned as a TEXT caption instead of an inlined PNG. Requires VISION_BASE_URL + VISION_MODEL on the server.",
        },
        describe_prompt: {
          type: "string",
          description: "The question/instruction sent to the vision model with each trial screenshot when `describe` is true. Falls back to the server's VISION_DEFAULT_PROMPT.",
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
      "RETURNS: 'Emulation paused' plus a `State:` line (frame/paused/lag/domain).",
    inputSchema: { type: "object", required: ["target"], properties: { ...targetProp } },
  },
  {
    name: "bizhawk_unpause",
    description:
      "PURPOSE: Resume emulation after a pause, returning to normal real-time playback. " +
      "USAGE: Counterpart to bizhawk_pause. Use after a paused inspection sequence is complete. To advance only a few frames without resuming full speed, use bizhawk_frame_advance instead. " +
      "BEHAVIOR: Modifies emulator run state. Returns an error if the loaded core doesn't expose emu.unpause — check `capabilities.unpause` in bizhawk_get_info first. Calling unpause when not paused is a no-op. " +
      "RETURNS: 'Emulation resumed' plus a `State:` line (frame/paused/lag/domain).",
    inputSchema: { type: "object", required: ["target"], properties: { ...targetProp } },
  },
  {
    name: "bizhawk_frame_advance",
    description:
      "PURPOSE: Step emulation by exactly N frames (default 1) and return the new framecount. " +
      "USAGE: Use for frame-precise input automation (combine with bizhawk_press_buttons), animation inspection, or letting the system initialize after a hard reset (RAM is mostly zero in the first ~30 frames after bizhawk_reset). For long jumps (thousands of frames) prefer bizhawk_save_state / bizhawk_load_state of a pre-prepared state — frame_advance scales linearly. Works whether emulation is currently paused or running and does NOT change the pause state. To advance until a memory condition holds (instead of guessing a frame count) use bizhawk_wait_for_memory; for multi-frame input use bizhawk_play_input_sequence. " +
      "BEHAVIOR: Advances the game-logic clock by N frames. Each step costs roughly one real frame (~16ms at 60Hz) plus one bridge round-trip — so advancing 600 frames takes ~10 seconds wall-clock. Returns an error if the loaded core doesn't expose emu.frameadvance. " +
      "RETURNS: Single line 'Advanced N frame(s). Framecount: NEW_COUNT', plus a `State:` line (lag/pause/domain) — no bizhawk_get_info needed.",
    inputSchema: {
      type: "object",
      required: ["target"],
      properties: { ...targetProp, 
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
      "RETURNS: 'Core reset' plus a `State:` line (frame resets toward 0).",
    inputSchema: { type: "object", required: ["target"], properties: { ...targetProp } },
  },
  {
    name: "bizhawk_screenshot",
    description:
      "PURPOSE: Capture a PNG screenshot of the current emulator display and return it INLINE as an image content block (also saved to disk). " +
      "USAGE: The primary 'look at the screen' tool — call it whenever you need visual confirmation of game state. To capture a specific state, pause / advance frames / load a named state first. Omit `name` for an auto-generated screenshot file, or pass a short name if you need to refer to this capture later. For screenshots DURING an input sequence use bizhawk_play_input_sequence's screenshot_every instead. Do not pass filesystem paths; the selected backend resolves where the PNG is written and read back. " +
      "BEHAVIOR: DESTRUCTIVE TO TARGET FILE: overwrites the named screenshot file if it exists. The image is read back from disk and inlined; if the file can't be read the tool still succeeds and returns the screenshot name with a note instead of the image. When BizHawk runs on a DIFFERENT filesystem than this server (e.g. a Windows BizHawk driven by a Linux daemon over a shared mount), the backend's path config maps the server-visible directory to the bridge-visible directory. Returns an error if the target directory doesn't exist or the core doesn't expose client.screenshot — check `capabilities.screenshot` in bizhawk_get_info first. " +
      "RETURNS: A text block 'Screenshot captured: NAME', an inline PNG image content block, and (unless describe:false) a vision-model caption of the screen. Filesystem paths are intentionally not exposed to MCP clients.",
    inputSchema: {
      type: "object",
      required: ["target"],
      properties: { ...targetProp, 
        name: { type: "string", description: "Optional screenshot name: 1-64 chars of letters, digits, dot, underscore, hyphen. `.png` is appended if omitted. Omit for an auto-generated name." },
        describe: {
          type: "boolean",
          default: true,
          description: "Default TRUE: in ADDITION to the inline PNG, send the image to the configured local vision model and append its text caption of the game state. Pass false to return the PNG only and skip the vision call. Best-effort: if vision is unconfigured or fails, the PNG is still returned with a short note instead of a caption. Requires the server to have VISION_BASE_URL and VISION_MODEL set for the caption.",
        },
        describe_prompt: {
          type: "string",
          description: "The question/instruction sent to the vision model with the image (unless describe:false), e.g. 'Is the puck in the net? Where are the goalies?'. Falls back to the server's built-in NHL94 system prompt / VISION_DEFAULT_PROMPT.",
        },
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
      properties: { ...targetProp, 
        message: { type: "string", minLength: 1, description: "Text to display in the OSD message area." },
      },
      required: ["target", "message"],
      additionalProperties: false,
    },
  },

  // ── Save state ─────────────────────────────────────────────────────────

  {
    name: "bizhawk_save_state",
    description:
      "PURPOSE: Save the entire emulator state (RAM, CPU/PPU/APU registers, mapper state, sound chip state, timing) under a named slot. " +
      "USAGE: Use as a rollback point before risky writes, to bookmark interesting game states, or to share repro states by name. The companion bizhawk_load_state can perfectly restore from the same name. Do not pass filesystem paths; the selected backend resolves where the file lives. " +
      "BEHAVIOR: DESTRUCTIVE TO NAMED STATE: overwrites an existing state with the same name for the current ROM, with no prompt or backup. The state file is bound to the EXACT ROM and BizHawk core version that produced it — loading it on a different ROM or core version usually crashes the core. Returns an error if the backend state directory isn't writable or the core doesn't expose savestate.save. " +
      "RETURNS: Single line 'Saved state NAME'.",
    inputSchema: {
      type: "object",
      required: ["target", "name"],
      properties: { ...targetProp, 
        name: { type: "string", description: "State name: 1-64 chars of letters, digits, dot, underscore, hyphen. Namespaced per ROM hash automatically." },
      },
      additionalProperties: false,
    },
  },
  {
    name: "bizhawk_load_state",
    description:
      "PURPOSE: Restore the emulator from a previously saved named state. " +
      "USAGE: Counterpart to bizhawk_save_state. Use to undo a sequence of writes/inputs (the snapshot/experiment/restore workflow), to jump to a bookmarked game state, or to start each tool-call sequence from a known baseline. Default is PAUSED after load; drive the restored state deliberately with bizhawk_frame_advance, bizhawk_play_input_sequence, or bizhawk_unpause. To start fresh from console boot instead, use bizhawk_reset. Do not pass filesystem paths; the selected backend resolves the named state. " +
      "BEHAVIOR: DESTRUCTIVE TO LIVE STATE: replaces ALL current emulator state (RAM, registers, mapper, audio, framecount) with the named state's contents. Anything not previously snapshotted is lost. The state MUST come from the same ROM and same BizHawk core version that produced it — loading an incompatible state typically crashes the core. The bridge leaves the emulator PAUSED by default after load so game time cannot drift between agent commands; pass pause=false only when you intentionally want real-time playback to resume. The pause is applied in the same callback after the load (ZERO frames run between load and pause). Returns an error if the named state doesn't exist, isn't a valid BizHawk state, or the core doesn't expose savestate.load. " +
      "RETURNS: 'Loaded state NAME (paused/running)' plus a `State:` line (frame/paused/lag/domain) — no bizhawk_get_info needed.",
    inputSchema: {
      type: "object",
      required: ["target", "name"],
      properties: { ...targetProp, 
        name:  { type: "string", description: "State name as given to bizhawk_save_state." },
        pause: { type: "boolean", default: true, description: "Default true: leave the emulator PAUSED after load so state cannot drift before the next command. Set false only when you intentionally want real-time playback to resume immediately." },
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
      required: ["target", "address"],
      properties: { ...targetProp, 
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
      required: ["target", "reads"],
      properties: { ...targetProp, 
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
      required: ["target", "base", "stride", "count", "fields"],
      properties: { ...targetProp, 
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
      "BEHAVIOR: DESTRUCTIVE: overwrites the address(es) every frame with no undo; the game's own writes are overridden one frame later at the latest. The first write happens immediately and validates domain/width/address (errors now, not silently later). FOOTGUN: a full 68K bus address (0xFFxxxx) overflows the 64 KB '68K RAM' domain and is rejected — mask with & 0xFFFF, or target the full-bus domain (M68K BUS on Genesis, System Bus on NES/SNES). Batch entries are applied in order; if one entry errors, earlier entries in the batch STAY frozen. Freezes live in the bridge — reloading the Lua script or restarting BizHawk clears them. Frozen values are re-asserted after each frame stepped by the bridge's own commands (frame_advance, play_input_sequence, wait_for_memory), but NOT for frames advanced inside a bizhawk_eval_lua chunk. " +
      "RETURNS: One 'Froze ADDR_HEX (DOMAIN) = VAL' line per address, then 'N address(es) frozen.'",
    inputSchema: {
      type: "object",
      properties: { ...targetProp, 
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
      required: ["target"],
      properties: { ...targetProp, 
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
    inputSchema: { type: "object", required: ["target"], properties: { ...targetProp }, additionalProperties: false },
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
      required: ["target", "ops"],
      properties: { ...targetProp, 
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
      "USAGE: Prefer typed tools first: nhl94_state/nhl94_stage/nhl94_read/nhl94_fields for NHL94 state, read_many/read_struct_array/search/trap tools for memory/reverse-engineering, and play_input_sequence/wait_for_memory/run_trials for frame-driving. Use eval_lua only after those tools cannot express the task, or to prototype a bridge feature before promoting it to a real tool. The chunk sees BizHawk's Lua globals: memory, emu, client, joypad, savestate, movie, gui, event, comm. Return a value with `return ...` — it comes back JSON-encoded. If the chunk steps frames itself, pass timeout_ms scaled to the work and unpause:true when needed. " +
      "BEHAVIOR: DESTRUCTIVE (potentially): the chunk can write memory, load states, reboot the core — anything the Lua API allows, with no sandbox. Runs synchronously inside the bridge's poll loop; a chunk that never returns wedges the bridge until the RPC times out (and possibly beyond — avoid unbounded loops; use emu.frameadvance-bounded loops). Errors in the chunk (parse or runtime) return as tool errors without harming the bridge. The return value must be JSON-encodable: nil/boolean/number/string, array-like or string-keyed tables. Frames advanced INSIDE the chunk (e.g. calling emu.frameadvance) do NOT run the bridge's per-frame hooks: frozen addresses are not re-asserted and no trace rows are written for those frames. If the chunk steps frames (emu.frameadvance) while the emulator is paused it will block until unpaused — pass unpause:true to run the chunk via the bridge's pause-safe path (or use bizhawk_frame_advance instead). " +
      "RETURNS: The chunk's return value as pretty-printed JSON, '(nil)' if it returned nothing, or a JSON array when the chunk returns multiple values. Multiple return values with an embedded nil (e.g. return 1, nil, 3) produce a hole in the JSON array and may be truncated — return a table instead if you need to preserve nils.",
    inputSchema: {
      type: "object",
      required: ["target", "code"],
      properties: { ...targetProp, 
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
      required: ["target"],
      properties: { ...targetProp, 
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
      required: ["target", "condition"],
      properties: { ...targetProp, 
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
      required: ["target"],
      properties: { ...targetProp, 
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
    inputSchema: { type: "object", required: ["target"], properties: { ...targetProp }, additionalProperties: false },
  },
  {
    name: "bizhawk_get_registers",
    description:
      "PURPOSE: Read every CPU register of the emulated system (PC, data/address registers, flags — names vary per core; 68K cores expose PC/D0-D7/A0-A7 etc.). " +
      "USAGE: Reverse-engineering entry point — read PC to see where execution is, correlate with a disassembly, inspect state at a trap hit (bizhawk_trap_memory embeds registers automatically). Pair with bizhawk_pause for a stable readout. " +
      "BEHAVIOR: No side effects — pure read. Register support varies by core; returns an error if emu.getregisters is unavailable on the loaded core. " +
      "RETURNS: One line per register, sorted by name: 'NAME = VAL_DEC (0xVAL_HEX)'.",
    inputSchema: { type: "object", required: ["target"], properties: { ...targetProp }, additionalProperties: false },
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
      required: ["target", "name", "value"],
      properties: { ...targetProp, 
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
      required: ["target"],
      properties: { ...targetProp, 
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
      required: ["target", "address"],
      properties: { ...targetProp, 
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
      required: ["target"],
      properties: { ...targetProp, 
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
      required: ["target"],
      properties: { ...targetProp, 
        player: { type: "integer", minimum: 1, description: "Controller port to read (default 1)." },
      },
      additionalProperties: false,
    },
  },
  {
    name: "bizhawk_movie_play",
    description:
      "PURPOSE: Load and play a BizHawk .bk2 movie from frame 0 (power-on), using BizHawk's native movie engine. " +
      "USAGE: Restart the currently loaded movie from frame 0. Check progress with bizhawk_movie_status; detach with bizhawk_movie_stop. Movie file selection is a BizHawk-side setup step, not an MCP path argument. " +
      "BEHAVIOR: DESTRUCTIVE TO LIVE STATE: resets the core to power-on before playback — current game state is lost (savestate first if needed). The .bk2 must match the loaded ROM and the authoring CORE (header records it; mismatches fail to load or desync). Returns an error if movie.play_from_start is unavailable or the file fails to load. " +
      "RETURNS: 'Movie: FILE (loaded, mode: MODE, length: N)'. Backend filesystem paths are kept private.",
    inputSchema: {
      type: "object",
      required: ["target"],
      properties: { ...targetProp },
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
    inputSchema: { type: "object", required: ["target"], properties: { ...targetProp }, additionalProperties: false },
  },
  {
    name: "bizhawk_movie_status",
    description:
      "PURPOSE: Report the movie engine's state: whether a movie is loaded, its mode (PLAY/RECORD/FINISHED/INACTIVE), filename, and length in frames. " +
      "USAGE: Poll during bizhawk_movie_play to see progress (compare bizhawk_get_info framecount to length); confirm mode before issuing inputs (inputs are ignored during PLAY). " +
      "BEHAVIOR: No side effects — pure read. " +
      "RETURNS: 'Movie: FILE (loaded, mode: MODE, length: N)' or 'No movie loaded.'",
    inputSchema: { type: "object", required: ["target"], properties: { ...targetProp }, additionalProperties: false },
  },
  {
    name: "bizhawk_save_slot",
    description:
      "PURPOSE: Save the full emulator state under a NAME (no filesystem paths needed) — the server stores it in a managed directory, namespaced by ROM hash. " +
      "USAGE: The convenient form of bizhawk_save_state for bookmarks and experiment rollback points ('before-boss', 'baseline'). Use bizhawk_load_slot to restore and bizhawk_list_slots to browse. " +
      "BEHAVIOR: DESTRUCTIVE TO SLOT: overwrites an existing slot of the same name for this ROM. Requires the MCP server and BizHawk to share a filesystem (true for local setups; the state directory is $MCP_BIZHAWK_STATE_DIR or ~/.mcp-bizhawk/states). State files are core-version-bound like all BizHawk states. " +
      "RETURNS: 'Saved slot 'NAME''.",
    inputSchema: {
      type: "object",
      required: ["target", "name"],
      properties: { ...targetProp, 
        name: { type: "string", description: "Slot name: 1-64 chars of letters, digits, dot, underscore, hyphen. Namespaced per ROM hash automatically." },
      },
      additionalProperties: false,
    },
  },
  {
    name: "bizhawk_load_slot",
    description:
      "PURPOSE: Restore the emulator from a named slot previously saved with bizhawk_save_slot for the currently loaded ROM. " +
      "USAGE: Counterpart to bizhawk_save_slot — the snapshot/experiment/rollback loop without path bookkeeping. Loads paused by default; drive the restored state deliberately with frame_advance/play_input_sequence/unpause. Pass pause=false only when you intentionally want real-time playback to resume immediately. " +
      "BEHAVIOR: DESTRUCTIVE TO LIVE STATE: replaces all current emulator state. Slots are looked up by the CURRENT ROM's hash — a slot saved under a different ROM won't be found (this is a safety feature: cross-ROM state loads crash cores). A missing name returns an error listing available slots. " +
      "RETURNS: 'Loaded slot 'NAME' (paused|running)' plus a `State:` line (frame/paused/lag/domain).",
    inputSchema: {
      type: "object",
      required: ["target", "name"],
      properties: { ...targetProp, 
        name:  { type: "string", description: "Slot name as given to bizhawk_save_slot." },
        pause: { type: "boolean", default: true, description: "Default true: leave the emulator paused after load (zero frames run between load and pause). Set false only for intentional real-time playback." },
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
    inputSchema: { type: "object", required: ["target"], properties: { ...targetProp }, additionalProperties: false },
  },
  {
    name: "bizhawk_trace_start",
    description:
      "PURPOSE: Start (or rotate) the bridge's per-frame trace CSV — a game-specific dump of entity/game state written after every emulated frame (as configured in the bridge script; the stock bridge_JD.lua traces NHL94 player structs, puck, RNG, and pad state). " +
      "USAGE: Rotate to a fresh file before an experiment so the CSV covers exactly that run; re-enable after bizhawk_trace_stop. The osd flag also toggles the on-screen overlay. NOTE: the trace layout is defined in the bridge script for a specific game — on other ROMs it records garbage; stop it or ignore it there. " +
      "BEHAVIOR: DESTRUCTIVE TO TRACE FILE: opens the bridge's per-backend trace file in write mode (truncates). Closes any previously open trace file first. Tracing costs a few hundred memory reads per frame. Do not pass filesystem paths; the bridge chooses the file for this backend. " +
      "RETURNS: 'Trace started (osd: on|off)'. Backend filesystem paths are kept private; use bizhawk_trace_tail for inline readback.",
    inputSchema: {
      type: "object",
      required: ["target"],
      properties: { ...targetProp, 
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
      "RETURNS: 'Trace stopped after N rows'.",
    inputSchema: { type: "object", required: ["target"], properties: { ...targetProp }, additionalProperties: false },
  },
  {
    name: "bizhawk_trace_status",
    description:
      "PURPOSE: Report whether the per-frame trace is active, its row count, and OSD state. " +
      "USAGE: Sanity-check that a trace is running before an experiment; use bizhawk_trace_tail for inline readback. " +
      "BEHAVIOR: No side effects. " +
      "RETURNS: 'Trace active|inactive: N rows, osd: on|off'.",
    inputSchema: { type: "object", required: ["target"], properties: { ...targetProp }, additionalProperties: false },
  },
  {
    name: "bizhawk_trace_tail",
    description:
      "PURPOSE: Return the trace CSV's header line plus its last N rows — a quick look at recent frame-by-frame game state without leaving the tool interface. " +
      "USAGE: Spot-check what the game did during the last action (animation frames, positions, RNG) right after a play_input_sequence. For bulk analysis, use server-side artifacts outside the MCP transcript; rows are wide (~250 columns on NHL94). " +
      "BEHAVIOR: No side effects. Reads the file from the server's filesystem (requires server and BizHawk to share one — true locally). Buffered rows are flushed every 60 frames, so the very newest rows may lag slightly. Returns an error if the trace file has never been started or the file is unreadable. " +
      "RETURNS: 'Trace tail (N rows, active: yes|no)' + the CSV header + the last N data rows. Backend filesystem paths are kept private.",
    inputSchema: {
      type: "object",
      required: ["target"],
      properties: { ...targetProp, 
        rows: { type: "integer", minimum: 1, maximum: 200, default: 10, description: "How many trailing data rows to return. Default 10 (rows are ~800 chars wide on NHL94)." },
      },
      additionalProperties: false,
    },
  },
  {
    name: "bizhawk_phys_trace_start",
    description:
      "PURPOSE: Start the bridge's physics-sync trace — one CSV row per NHL94 `updateplayers` physics tick (NOT per video frame), each carrying the per-pass D7 step multiplier latched inside the retail Gameloop. " +
      "USAGE: The right trace when you need physics-tick resolution and the actual D7 sub-step count per tick (e.g. speed/acceleration work), plus same-tick puck position/velocity context for puck-driven AI analysis. Start → drive input (bizhawk_play_input_sequence) → bizhawk_phys_trace_stop. " +
      "BEHAVIOR: RETAIL nhl94.gen ONLY — hash-guarded (MD5 8356B3F0…), so it errors on any other ROM, and errors on cores without event.on_bus_exec. Registers two bus-exec hooks in the Gameloop. While active it SUPPRESSES the per-video-frame bizhawk_trace_* writer. DESTRUCTIVE TO TRACE FILE: opens the bridge's per-backend trace file in write mode (truncates). Do not pass filesystem paths. " +
      "RETURNS: 'Physics-sync trace started (latch ADDR, emit ADDR)'. Backend filesystem paths are kept private; use bizhawk_phys_trace_tail for inline readback.",
    inputSchema: {
      type: "object",
      required: ["target"],
      properties: { ...targetProp },
      additionalProperties: false,
    },
  },
  {
    name: "bizhawk_phys_trace_stop",
    description:
      "PURPOSE: Stop the physics-sync trace and flush/close the file. " +
      "USAGE: End-of-experiment bookend for bizhawk_phys_trace_start; also re-enables the per-video-frame bizhawk_trace_* writer. " +
      "BEHAVIOR: Removes the bus-exec hooks, flushes buffered rows, closes the file (the CSV remains on disk). Calling with no active phys trace is a no-op. " +
      "RETURNS: 'Physics-sync trace stopped after N ticks'.",
    inputSchema: { type: "object", required: ["target"], properties: { ...targetProp }, additionalProperties: false },
  },
  {
    name: "bizhawk_phys_trace_status",
    description:
      "PURPOSE: Report whether the physics-sync trace is active, its tick count, and last latched D7. " +
      "USAGE: Sanity-check that the trace is running and that D7 is being latched before an experiment; use bizhawk_phys_trace_tail for inline readback. " +
      "BEHAVIOR: No side effects. " +
      "RETURNS: 'Physics-sync trace active|inactive: N ticks, last D7: N'.",
    inputSchema: { type: "object", required: ["target"], properties: { ...targetProp }, additionalProperties: false },
  },
  {
    name: "bizhawk_phys_trace_tail",
    description:
      "PURPOSE: Return the physics-sync CSV's header line plus its last N rows — a quick look at recent physics ticks without leaving the tool interface. " +
      "USAGE: Spot-check per-tick D7, slot-2 state, facing fraction, faceoff flag, and puck position/velocity/carrier right after a play_input_sequence. The phys CSV columns are tick,frame,d7,pad,x,xsub,y,ysub,xv,yv,fdir,frac,faceoff,puck_x,puck_y,puck_z,puck_xv,puck_yv,puck_zv,puckc. " +
      "BEHAVIOR: No side effects. Reads the file from the server's filesystem (requires server and BizHawk to share one — true locally). Rows are buffered, so the very newest may lag slightly. Returns an error if the phys trace has never been started or the file is unreadable. " +
      "RETURNS: 'Physics-sync trace tail (N ticks, active: yes|no)' + the CSV header + the last N data rows. Backend filesystem paths are kept private.",
    inputSchema: {
      type: "object",
      required: ["target"],
      properties: { ...targetProp, 
        rows: { type: "integer", minimum: 1, maximum: 200, default: 10, description: "How many trailing data rows to return. Default 10." },
      },
      additionalProperties: false,
    },
  },

  // ── NHL94 game-semantic tools ─────────────────────────────────────────────
  // These speak in NHL94 nouns (skaters s0-s11, puck pk) and whole-pixel
  // coordinates, and own ALL the 68K details internally (M68K BUS domain,
  // big-endian, 16.16 fixed-point positions, signed velocity words). Prefer
  // them over hand-built read_many/write/freeze calls against the slot grid.
  {
    name: "nhl94_recipes",
    description:
      "PURPOSE: One-time NHL94 primer covering the state model, tool routing, experiment lifecycle, copyable setup recipes, and evidence rules. " +
      "USAGE: Call once at the start of an NHL94 task or when changing to an unfamiliar workflow; do not repeat before every nhl94_* call. Read it before staging scenarios or reverse-engineering interactions so clean-baseline, verification, gate, and trap sequencing are established first. Escalation order: nhl94_* semantic tools first, generic memory/trap/frame tools second, bizhawk_eval_lua only for gaps or prototypes. No arguments. " +
      "BEHAVIOR: No side effects — returns static reference text, no bridge round-trip (works even when BizHawk isn't connected). " +
      "RETURNS: Core semantics; a router for every nhl94_* tool; baseline→clean→stage→verify→gate→trace→conclude workflow; copyable JSON-shaped calls; address and evidence safety rules.",
    inputSchema: { type: "object", properties: {}, additionalProperties: false },
  },
  {
    name: "nhl94_teleport",
    description:
      "PURPOSE: Move one or more NHL94 targets (skaters s0-s11, puck pk) to new x/y/z positions AND/OR set their x/y/z velocity — place a target, launch a moving one (e.g. fire the puck at the net with a chosen xv/yv/zv, or feed a one-timer), or both in one atomic write. " +
      "USAGE: The safe way to place players/puck — pass WHOLE pixel coordinates (the same numbers the OSD shows), one entry per target, only the axes you want to change. The tool converts positions and hides all address/domain/width/endian details. Velocity axes (xv/yv/zv) are game motion units; set them to give a target motion the game's physics then acts on, and the tool handles the storage encoding. This is the tool for an inbound/loose puck with a specific vector (nhl94_freeze/park only ZERO velocity, they can't set one). For pinning a target in place use nhl94_freeze; for a whole reproducible setup use nhl94_rig. If the next step is a screenshot/vision read and you need the render pass to catch up, request settle_frames explicitly; otherwise leave it omitted/0 for precise RAM staging. " +
      "BEHAVIOR: DESTRUCTIVE: overwrites x/y/z (no undo — snapshot with nhl94_rig/save_state if needed). All writes land atomically in one frame. Teleport is PLACEMENT, not a state reset — latched per-skater flags survive it. FOOTGUN handled for you: teleporting pk while a skater carries it is futile (carry logic snaps it back next frame), so a pk teleport AUTO-DETACHES the puck (writes 'nobody' to the carrier word first) — the result is a loose puck at the given spot. To move a carried puck with its carrier, teleport the skater instead. Errors if a target is unknown, an entry sets no axis, or a coordinate is outside -32768..32767. It does not advance frames unless settle_frames > 0 is requested. " +
      "RETURNS: One line per target naming the decoded coordinates written (and whether the puck was detached), plus a note when requested render-settle frames ran.",
    inputSchema: {
      type: "object",
      required: ["target", "targets"],
      properties: { ...targetProp,
        targets: {
          type: "array",
          minItems: 1,
          description: "Targets to move. Each entry needs `target` plus at least one of x/y/z (position) or xv/yv/zv (velocity).",
          items: {
            type: "object",
            properties: {
              target: { type: "string", description: "Target id: 's0'..'s11' (skaters) or 'pk' (puck)." },
              x: { type: "integer", minimum: -32768, maximum: 32767, description: "New X in whole pixels (as shown on the OSD). Omit to leave X unchanged." },
              y: { type: "integer", minimum: -32768, maximum: 32767, description: "New Y in whole pixels. Omit to leave Y unchanged." },
              z: { type: "integer", minimum: -32768, maximum: 32767, description: "New Z (height; 0 = on the ice) in whole pixels. Omit to leave Z unchanged." },
              xv: { type: "integer", minimum: -32768, maximum: 32767, description: "New X velocity as a raw signed 16-bit word (+ = right, − = left; NOT fixed-point). Omit to leave unchanged. Use to launch a moving puck/skater — e.g. fire the puck at the net." },
              yv: { type: "integer", minimum: -32768, maximum: 32767, description: "New Y velocity, raw signed 16-bit word (+ = down, − = up). Omit to leave unchanged." },
              zv: { type: "integer", minimum: -32768, maximum: 32767, description: "New Z velocity (vertical), raw signed 16-bit word. Omit to leave unchanged." },
            },
            required: ["target"],
            additionalProperties: false,
          },
        },
        settle_frames: { type: "integer", minimum: 0, maximum: 60, default: 0, description: "Optional post-write frame advance so rendered sprites catch up before a screenshot/describe. Default 0: no frame advance." },
      },
      additionalProperties: false,
    },
  },
  {
    name: "nhl94_freeze",
    description:
      "PURPOSE: Pin one or more NHL94 targets (s0-s11, pk) in place and stop all motion. " +
      "USAGE: Use to hold positions during an experiment (freeze everyone, then test one interaction). Freezes each target's x/y/z at its CURRENT position and zeroes+freezes its velocity (xv/yv/zv). Counterpart: nhl94_unfreeze. To place THEN pin, nhl94_teleport first, then nhl94_freeze. To park bench players off-ice in one call use nhl94_park; to persist a freeze set across restarts use nhl94_rig. " +
      "BEHAVIOR: DESTRUCTIVE: re-asserts the frozen values every frame until released; the game's own writes are overridden. Freezes live in the bridge and are cleared by reloading the Lua script or restarting BizHawk (use nhl94_rig to survive that). Positions are captured at call time (reads current x/y/z), so two round-trips total regardless of target count. Errors if a target is unknown or targets is empty. " +
      "RETURNS: One line per target with the pinned x/y/z and a note that velocity was zeroed.",
    inputSchema: {
      type: "object",
      properties: { ...targetProp, 
        targets: {
          type: "array",
          minItems: 1,
          items: { type: "string", description: "Target id: 's0'..'s11' or 'pk'." },
          description: "Targets to freeze in place.",
        },
      },
      required: ["target", "targets"],
      additionalProperties: false,
    },
  },
  {
    name: "nhl94_unfreeze",
    description:
      "PURPOSE: Release selected NHL94 target pins, or clear every freeze for a clean experiment baseline. " +
      "USAGE: Pass targets:['s0',...] to release only those entities' x/y/z + velocity pins created by nhl94_freeze/park. Pass all:true for 'drop all freezes' in one call — this is the preferred clean-slate operation before applying a new rig or experiment. " +
      "BEHAVIOR: Exactly one of targets or all:true is required. all:true clears the bridge's ENTIRE freeze table, including target fields, clock, carrier, camera, stale, non-NHL94, and unmapped addresses. Releasing a freeze stops future per-frame rewrites but does not restore an earlier value; memory keeps the last frozen value until the game overwrites it. " +
      "RETURNS: What scope was released and the number of addresses still frozen.",
    inputSchema: {
      type: "object",
      required: ["target"],
      properties: { ...targetProp, 
        targets: {
          type: "array",
          minItems: 1,
          items: { type: "string", description: "Target id: 's0'..'s11' or 'pk'." },
          description: "Targets whose position/velocity pins should be released. Mutually exclusive with all:true.",
        },
        all: { type: "boolean", description: "Set true to clear every bridge freeze, including globals and unmapped/non-NHL94 addresses. Mutually exclusive with targets." },
      },
      additionalProperties: false,
    },
  },
  {
    name: "nhl94_state",
    description:
      "PURPOSE: One-call decoded snapshot of the whole NHL94 game state — every skater + puck position/velocity/heading + animation record, the puck carrier, clock/period/play state, camera scroll, and which fields are currently frozen. " +
      "USAGE: Call before an experiment to establish the baseline and after driving frames/input to verify what actually happened. The default describe:true is recommended when placement, contact, or animation matters because it returns structured RAM plus a screenshot caption; use describe:false only for a faster RAM-only check such as reading interaction_gate. Structured fields are authoritative for RAM facts; the caption is observational evidence, not a replacement. Targets s0-s11 and pk are game entity slots, not render order. Prefer this tool over hand-built read_many/read_struct_array/eval_lua calls. For additional entity reads use nhl94_read; for selected field reads/writes/freezes use nhl94_fields. Never compute slot addresses yourself. Pass raw:true only when an absolute address is genuinely required for a trap. " +
      "BEHAVIOR: No side effects — pure read (≤3 bridge round-trips: the slot grid, the globals, and the freeze list). Coordinates are decoded to whole pixels; velocities are signed. A `frozen_summary` reports total/mapped/unmapped freezes — a nonzero `unmapped` or a surprisingly large total is your tripwire for stale freezes left by a previous rig. " +
      "RETURNS: A structured text block with every entity, then `phase`, `interaction_gate: OPEN|CLOSED`, carrier/clock/play/camera/context, a reference-only layout, and frozen summary. When the faceoff-window latch at $FFC304 is nonzero, phase is the stable token `faceoff_line_change` and a `faceoff_window` line reports latch + selected lines (Sc1/Sc2/Chk). CLOSED proves gmode.bit0 is blocking collision/check dispatch. OPEN proves only that this stoppage gate is clear; it does not prove contact occurred or that the resolver reached a trap. Never infer the RAM gate from a screenshot, apparent motion, or HUD clock. `phase` is heuristic UI context except for the RAM-backed faceoff_line_change token. A trailing `*` marks a frozen word.",
    inputSchema: {
      type: "object",
      required: ["target"],
      properties: { ...targetProp, 
        raw: { type: "boolean", default: false, description: "Include raw 16.16 hex and the sub-pixel fraction alongside decoded whole-pixel values." },
        verbose: { type: "boolean", default: false, description: "Add per-entity raw diagnostic fields: impact(+0x32)/impactp(+0x2E)/pos(+0x34)/nopuck(+0x5E)/pf2,pf3(+0x63-64)/wgt8(+0x67) plus raw assignment queue bytes. Normal output already decodes pf(+0x62), assidx(+0x36), and assq(+0x38..3F) into role/control context." },
        sections: {
          description: "Optional dense sections to include. Default is compact. Use a string or array: anim, control, ratings, camera, context, debug, freezes, or all. verbose:true implies all.",
          oneOf: [
            { type: "string", enum: ["all", "anim", "control", "ratings", "camera", "context", "debug", "freezes"] },
            { type: "array", items: { type: "string", enum: ["all", "anim", "control", "ratings", "camera", "context", "debug", "freezes"] } },
          ],
        },
        describe: { type: "boolean", default: true, description: "Default TRUE and recommended for staging/post-action verification: append a vision caption to the structured RAM state so placement, contact, and animation can be checked. Set false only for a fast RAM-only read (for example an interaction_gate preflight) or when vision is unnecessary. The structured result still returns if vision fails." },
        describe_prompt: { type: "string", description: "The question/instruction sent to the vision model with the screenshot (unless describe:false). Falls back to the server's built-in NHL94 system prompt / VISION_DEFAULT_PROMPT." },
      },
      additionalProperties: false,
    },
  },
  {
    name: "nhl94_rules",
    description:
      "PURPOSE: Read the NHL94 menu/rules/options state that agents need before interpreting play: game mode, player matchup mode, penalties, and offside setting. " +
      "USAGE: Use this instead of ad hoc reads when you need to know Exhibition vs menu mode, CPU/1P/2P control, or whether penalties/offside are enabled. It decodes the empirically pinned retail enum at $FFD056: 0=OFF, 1=ON, 2=ON except OFFSIDE; offside's runtime gate is gmode bit 13 ($FFC2EA & 0x2000). " +
      "BEHAVIOR: No side effects — one read_many round-trip. Player mode is inferred from active control globals and pad words, so it is a live-control inference rather than a separate menu enum. " +
      "RETURNS: Four decoded lines plus raw bytes/words for verification.",
    inputSchema: {
      type: "object",
      required: ["target"],
      properties: { ...targetProp },
      additionalProperties: false,
    },
  },
  {
    name: "nhl94_read",
    description:
      "PURPOSE: Read arbitrary decoded fields of NHL94 entities (skaters s0-s11, puck pk) by NAME or raw in-struct offset — the game-aware alternative to hand-computing 68K base+offset in bizhawk_read/eval_lua (the #1 source of base/stride/endian mistakes). " +
      "USAGE: Read-only per-entity inspection for fields nhl94_state's default block doesn't show — e.g. the body-check accumulator (impact, +0x32), assignment queue assidx/assq0..assq7 (+0x36/+0x38..3F), impactp (+0x2E), pos (+0x34), nopuck (+0x5E), player-flag bytes pf/pf2/pf3 (+0x62/63/64), weight wgt8 (+0x67) — or a raw entity-relative offset. `fields` entries are either a KNOWN name (x,y,z,xv,yv,zv,fdir,frame,attr,anim,spanum,spacnt,impact,impactp,pos,assidx,assq0..assq7,nopuck,pf,pf2,pf3,wgt8) or a raw '+0xNN[:width]' (width defaults u8). For common position/velocity/anim/carrier/clock snapshots use nhl94_state. For globals or writes/freezes use nhl94_fields. " +
      "BEHAVIOR: No side effects — one read_many round-trip. x/y/z decode to whole pixels; every other field is the raw integer at its width. Errors if targets×fields exceeds 128 reads, or on an unknown target/field. " +
      "RETURNS: One line per target: 'sN: field=val field=val …'.",
    inputSchema: {
      type: "object",
      required: ["target"],
      properties: { ...targetProp, 
        targets: {
          type: "array",
          items: { type: "string", description: "'s0'..'s11' or 'pk'." },
          description: "Entities to read (default: all skaters s0-s11 + pk).",
        },
        fields: {
          type: "array",
          items: { type: "string" },
          description: "Field names or raw '+0xNN[:width]' offsets (default: impact,impactp,pos,nopuck,pf,pf2,pf3,wgt8).",
        },
      },
      additionalProperties: false,
    },
  },
  {
    name: "nhl94_fields",
    description:
      "PURPOSE: Batch read/write/freeze/unfreeze selected NHL94 entity fields and globals by semantic name, with an explicit guarded escape hatch for raw offsets/addresses. " +
      "USAGE: Use this when nhl94_state is too broad and nhl94_read's curated snapshots are not specific enough — e.g. clear s6.lockout, hold s6.fdir, set s0.xv/yv, read global.clock/global.home_score plus s0.puck_control_rating, or temporarily touch a newly decoded raw offset. For fdir, prefer compass strings instead of memorizing values: north=0, northeast=1, east=2, southeast=3, south=4, southwest=5, west=6, northwest=7. Named fields hide address, domain, width, endian, signedness, and position encoding details. Prefer specialized tools for broad placement (nhl94_teleport/nhl94_stage), possession (nhl94_possession), and clock setup (nhl94_clock). Raw entity offsets and raw global addresses require allow_raw:true. " +
      "BEHAVIOR: Mixed per-op batch. Entity targets are s0-s11 or pk; global target is 'global'. Position fields x/y/z accept whole pixels and encode 16.16; velocity fields are raw signed words; fdir accepts either a raw integer or one of north/northeast/east/southeast/south/southwest/west/northwest. op:'freeze' with no value first reads the current RAM value and pins it; op:'write' with freeze:true writes and pins the supplied value. Write/freeze ops default to post-write readback so contested game rewrites are visible. `unfreeze` releases that field's bridge freeze only; it does not stop exec traps/hooks. This tool does not advance frames. " +
      "RETURNS: One line per op with decoded read/write/freeze/unfreeze result and post-write readback when applicable.",
    inputSchema: {
      type: "object",
      required: ["target", "ops"],
      properties: { ...targetProp,
        ops: {
          type: "array",
          minItems: 1,
          items: {
            type: "object",
            properties: {
              op: { type: "string", enum: ["read", "write", "freeze", "unfreeze"], description: "Per-field operation." },
              target: { type: "string", description: "'s0'..'s11', 'pk', or 'global'." },
              field: { type: "string", description: "Named field/global, e.g. fdir, lockout, carrier, clock, faceoff_window_latch." },
              offset: { type: "string", description: "Raw entity-relative offset such as '0x71'. Requires allow_raw:true." },
              address: { type: "string", description: "Raw absolute M68K bus address such as '0xFFC304'. Requires target:'global' and allow_raw:true." },
              width: { type: "string", enum: WIDTH_ENUM, description: "Width for raw offsets/addresses only. Do not provide width for named fields; the tool chooses the correct representation." },
              value: { description: "Value for write/freeze. Named fields accept semantic values; fdir accepts raw integers or compass strings: north=0, northeast=1, east=2, southeast=3, south=4, southwest=5, west=6, northwest=7. Raw fields use raw integer values. For op:'freeze', omit value to freeze the current RAM value." },
              freeze: { type: "boolean", description: "For op:'write', freeze this field at the written value instead of a one-time write." },
              allow_raw: { type: "boolean", description: "Required for raw offset/address operations." },
            },
            required: ["op", "target"],
            additionalProperties: false,
          },
        },
        readback: { type: "string", enum: ["post_write", "none"], default: "post_write", description: "Post-mutation RAM readback for write/freeze operations. Default post_write." },
      },
      additionalProperties: false,
    },
  },
  {
    name: "nhl94_stage",
    description:
      "PURPOSE: Stage a compact NHL94 experiment setup in one high-level call: clear freezes, apply a rig, park skaters, place targets, set possession, write/freeze selected fields, and optionally settle frames. " +
      "USAGE: Use when setting up RE experiments where ordering matters. Prefer this over a chatty sequence of unfreeze/rig/park/teleport/possession/field calls. `clear_freezes` runs before `rig` so a rig's saved freeze table is not destroyed. Do not combine puck placement with skater possession; possession snaps the puck to the carrier. After staging, call nhl94_state to verify RAM/vision stimulus before interpreting traps. " +
      "BEHAVIOR: DESTRUCTIVE: mutates live emulator RAM/state. Operations run in deterministic order: clear freezes, rig, park, place, possession, fields, settle. Default settle_frames is 0 for RE precision, so staging does not advance frames unless requested. clear_freezes clears only bridge freezes; it does not stop bizhawk_trap_exec hooks. " +
      "RETURNS: A concise ordered summary of what was staged.",
    inputSchema: {
      type: "object",
      required: ["target"],
      properties: { ...targetProp,
        rig: { type: "string", description: "Named nhl94_rig to apply." },
        clear_freezes: { type: "boolean", description: "Clear the bridge freeze table before other staging operations." },
        park: {
          type: "object",
          properties: {
            keep: { type: "array", items: { type: "string" }, description: "Skaters s0-s11 to leave alone." },
          },
          additionalProperties: false,
        },
        place: {
          type: "array",
          items: {
            type: "object",
            properties: {
              target: { type: "string" },
              x: { type: "integer" }, y: { type: "integer" }, z: { type: "integer" },
              xv: { type: "integer" }, yv: { type: "integer" }, zv: { type: "integer" },
              fdir: {
                description: "Facing direction as raw integer or compass string: north, northeast, east, southeast, south, southwest, west, northwest.",
                oneOf: [
                  { type: "integer" },
                  { type: "string", enum: [...nhl94.FDIR_DIRECTIONS] },
                ],
              },
            },
            required: ["target"],
            additionalProperties: false,
          },
        },
        possession: { type: "string", description: "'s0'..'s11' or 'none'." },
        fields: { type: "array", items: { type: "object" }, description: "nhl94_fields-style write/freeze ops without the op property; op defaults to write. Named fields use semantic values and hide widths; use this for fdir compass strings such as value:'south' or velocity fields such as xv/yv." },
        settle_frames: { type: "integer", minimum: 0, maximum: 60, default: 0, description: "Optional final frame advance after staging. Default 0: no frame advance." },
      },
      additionalProperties: false,
    },
  },
  {
    name: "nhl94_park",
    description:
      "PURPOSE: Get every skater except the one(s) under study off the ice and pinned, in one call — the standard 'clear the rink' experiment rig. " +
      "USAGE: Pass `keep` with the skaters to leave alone; all other skaters (s0-s11) are teleported far off-ice (fixed y=32000) and frozen there (position + zeroed velocity). The puck is never touched. Release with nhl94_unfreeze on the parked targets, or apply a clean nhl94_rig. Unlike nhl94_freeze (which pins at CURRENT position, incl. z), park commands off-ice positions and leaves z alone. If the next step is a screenshot/vision read and you need the render pass to catch up, request settle_frames explicitly; otherwise leave it omitted/0 for precise RAM staging. " +
      "BEHAVIOR: DESTRUCTIVE: freezes x/y and zeroes+freezes xv/yv/zv for each parked skater every frame until released (5 freezes each). One atomic memory_ops round-trip. Positions are commanded (no read needed) — parked skaters are spread evenly across x=-32000..+32000 by count (1 parked → x=0; 2 → ±32000; N → endpoints ±32000, spacing 64000/(N-1)) so they never overlap. Errors if every skater is in `keep` (nothing to park). It does not advance frames unless settle_frames > 0 is requested. " +
      "RETURNS: A summary (count, y latitude, X range, kept list) plus the per-skater X assignments, and a note when requested render-settle frames ran.",
    inputSchema: {
      type: "object",
      required: ["target"],
      properties: { ...targetProp, 
        keep: {
          type: "array",
          items: { type: "string", description: "Skater id 's0'..'s11' to leave alone." },
          description: "Skaters to leave in place (default none — parks all 12).",
        },
        settle_frames: { type: "integer", minimum: 0, maximum: 60, default: 0, description: "Optional post-write frame advance so rendered sprites catch up before a screenshot/describe. Default 0: no frame advance." },
      },
      additionalProperties: false,
    },
  },
  {
    name: "nhl94_rig",
    description:
      "PURPOSE: Save, apply, list, and delete named NHL94 'rigs' — a savestate plus the exact freeze set active when it was saved — so an experiment setup survives daemon/BizHawk restarts and can be re-applied atomically. " +
      "USAGE: `save {name}` after arranging a scenario (positions frozen, clock set, etc.); `apply {name}` to restore it later (even in a fresh session); `list` to see saved rigs; `delete {name}` to remove one. This is the durable alternative to hand re-applying freezes after loading a state, and the fix for stale-freeze contamination (apply clears all freezes first). Rigs are namespaced by ROM hash. " +
      "BEHAVIOR: `save` writes a savestate + JSON metadata to the server's rig store (DESTRUCTIVE to any same-named rig). `apply` is atomic: clears ALL freezes, loads the savestate paused, then re-asserts the saved freeze set in one batch; it errors before touching anything if the rig's ROM hash doesn't match the running ROM. `delete` removes the files. Errors on a missing name (apply/delete) or an invalid name. " +
      "RETURNS: `save`/`apply` a confirmation with freeze count; `list` the rigs with freeze counts, timestamps, and ROM-match flags; `delete` a confirmation.",
    inputSchema: {
      type: "object",
      properties: { ...targetProp, 
        action: { type: "string", enum: ["save", "apply", "list", "delete"], description: "Which rig operation to perform." },
        name: { type: "string", description: "Rig name (required for save/apply/delete; ignored for list). 1-64 chars: letters, digits, dot, underscore, hyphen." },
        note: { type: "string", description: "Optional free-text note stored with the rig (save only)." },
      },
      required: ["target", "action"],
      additionalProperties: false,
    },
  },
  {
    name: "nhl94_possession",
    description:
      "PURPOSE: Give the puck to a skater (or make it loose) without fighting the game's carry logic. " +
      "USAGE: `target:'sN'` assigns that slot as carrier and teleports the puck onto the skater in one batch. `target:'none'` writes 'nobody' for a loose puck. `hold:true` additionally freezes the carrier word so possession cannot change (EMPIRICAL — verify live). Every call first releases any prior carrier hold. Side benefit: the camera follows the puck/carrier, so `target:'sN'` also eases the camera onto sN. If the next step is a screenshot/vision read and you need the render pass to catch up, request settle_frames explicitly; otherwise leave it omitted/0 for precise RAM staging. " +
      "BEHAVIOR: DESTRUCTIVE: moves the puck and/or writes the carrier word (one atomic memory_ops). For `target:'sN'` reads sN's x/y first (one extra round-trip). Errors if target is not 's0'..'s11' or 'none'. It does not advance frames unless settle_frames > 0 is requested. " +
      "RETURNS: What was done — puck recipient and destination, whether the carrier is held, and a note when requested render-settle frames ran.",
    inputSchema: {
      type: "object",
      properties: { ...targetProp,
        entity: { type: "string", description: "'s0'..'s11' to give the puck to that skater, or 'none' for a loose puck." },
        hold: { type: "boolean", default: false, description: "Also freeze the carrier word so possession can't change (empirical — verify it holds)." },
        settle_frames: { type: "integer", minimum: 0, maximum: 60, default: 0, description: "Optional post-write frame advance so rendered sprites catch up before a screenshot/describe. Default 0: no frame advance." },
      },
      required: ["target", "entity"],
      additionalProperties: false,
    },
  },
  {
    name: "nhl94_clock",
    description:
      "PURPOSE: Set, freeze, or release the NHL94 game clock. " +
      "USAGE: `set` writes the clock (accepts 'MM:SS' or raw seconds); `freeze:true` stops time so nothing expires mid-experiment (freezes at the just-set value, or the current value if no `set`); `release:true` lets it run again. Combine `set` + `freeze` to set-and-hold in one call. This owns the correct clock address so you never guess it. " +
      "BEHAVIOR: DESTRUCTIVE: writes/freezes the clock word (one atomic memory_ops). At least one of set/freeze/release is required; freeze and release are mutually exclusive. `set`/clock values must be 0:00-59:59. " +
      "RETURNS: A confirmation of the clock value and freeze state.",
    inputSchema: {
      type: "object",
      required: ["target"],
      properties: { ...targetProp, 
        set: { type: ["string", "integer"], description: "New clock as 'MM:SS' (e.g. '19:59') or seconds (0-3599)." },
        freeze: { type: "boolean", description: "Freeze the clock at the set/current value." },
        release: { type: "boolean", description: "Release a frozen clock." },
      },
      additionalProperties: false,
    },
  },
  {
    name: "nhl94_camera",
    description:
      "PURPOSE: Control the NHL94 camera scroll — pin it at a chosen position or release it. " +
      "USAGE: The camera is a FOLLOWER that eases toward the puck/carrier each frame. The reliable way to center a skater is focus-steering: give them the puck (nhl94_possession target:'sN') and the camera eases to them. This tool's direct `pin` freezes Vpos and/or Hpos at chosen scroll values (EMPIRICAL — the game rewrites the scroll every frame, so a pin is a freeze-vs-game fight that may jitter; verify live). `release` unfreezes both camera words. Read the current camera with nhl94_state. " +
      "BEHAVIOR: DESTRUCTIVE: freezes/unfreezes the camera scroll words (one atomic memory_ops). Exactly one of pin/release. Pin values are validated against the rink-edge clamps: v ∈ [-199,256], h ∈ [-59,61]. " +
      "RETURNS: A confirmation of the pinned axes or the release.",
    inputSchema: {
      type: "object",
      required: ["target"],
      properties: { ...targetProp, 
        pin: {
          type: "object",
          properties: {
            v: { type: "integer", minimum: -199, maximum: 256, description: "Vertical scroll (Vpos) to pin. Omit to leave the Y camera live." },
            h: { type: "integer", minimum: -59, maximum: 61, description: "Horizontal scroll (Hpos) to pin. Omit to leave the X camera live." },
          },
          additionalProperties: false,
          description: "Freeze the camera at these scroll values (at least one of v/h).",
        },
        release: { type: "boolean", description: "Unfreeze both camera scroll words." },
      },
      additionalProperties: false,
    },
  },
];

function ok(text: string) {
  return { content: [{ type: "text" as const, text }] };
}
// A compact, uniform emulator-state line the bridge can ride along on any
// frame-changing command (load_state, frame_advance, play_input_sequence).
// Additive: a bridge that omits `state` yields null and callers print nothing,
// so older builds and existing behavior are unaffected. Kills the get_info
// call agents otherwise make just to re-check framecount/pause after acting.
interface StateSummary {
  framecount?: number;
  paused?: boolean;
  lag_count?: number;
  is_lagged?: boolean;
  current_memory_domain?: string;
  rom_hash?: string;
}
function fmtState(s?: StateSummary): string | null {
  if (!s || typeof s !== "object") return null;
  const parts: string[] = [];
  if (typeof s.framecount === "number") parts.push(`frame ${s.framecount}`);
  if (typeof s.paused === "boolean")    parts.push(s.paused ? "paused" : "running");
  // lag count, with a trailing "*" when the CURRENT frame is a lag frame
  // (matches the OSD's `lag N*` notation).
  if (typeof s.lag_count === "number")  parts.push(`lag ${s.lag_count}${s.is_lagged ? "*" : ""}`);
  // rom_hash is static; newer bridges omit it from the per-call block (kept
  // here so any bridge that still sends it renders unchanged).
  if (s.rom_hash)                       parts.push(`rom ${s.rom_hash}`);
  if (s.current_memory_domain)          parts.push(`domain ${s.current_memory_domain}`);
  return parts.length ? parts.join(", ") : null;
}
// Append the compact state line to a base message when the bridge rode one
// along. Additive: no `state` block → base message unchanged.
function withState(base: string, state?: StateSummary): string {
  const st = fmtState(state);
  return st ? `${base}\nState: ${st}` : base;
}
// Describe one screenshot without letting a single failure abort a whole run
// (a play/sweep with many screenshots keeps its memory data even if the vision
// model times out on one frame). Returns an inline error note instead.
async function safeDescribe(imgPath: string, prompt: string | undefined, cfg: VisionConfig): Promise<string> {
  try {
    return await describeImage(imgPath, prompt, cfg);
  } catch (err) {
    return `(vision error: ${publicVisionError(err)})`;
  }
}
interface FrameObservation {
  frame_offset: number;
  path?: string;
  memory?: Record<string, number>;
}
async function observationContent(
  header: string,
  obs: FrameObservation[],
  backend: BizhawkBackend,
  visCfg: VisionConfig | null,
  prompt: string | undefined,
): Promise<({ type: "text"; text: string } | { type: "image"; data: string; mimeType: string })[]> {
  const lines = [header];
  const captions = new Map<number, string>();
  if (visCfg) {
    for (let i = 0; i < obs.length; i++) {
      if (obs[i].path) {
        captions.set(i, await safeDescribe(bridgePathToHost(obs[i].path as string, backend), prompt, visCfg));
      }
    }
  }
  for (let i = 0; i < obs.length; i++) {
    const o = obs[i];
    const memStr = o.memory
      ? ` memory={${Object.entries(o.memory).map(([k, v]) => `${k}=${v}`).join(", ")}}`
      : "";
    const tag = !o.path ? "" : (visCfg ? " (described below)" : ` (image ${i + 1})`);
    lines.push(`  obs[${i}] frame_offset=${o.frame_offset}${memStr}${tag}`);
  }
  const content: ({ type: "text"; text: string } | { type: "image"; data: string; mimeType: string })[] = [
    { type: "text", text: lines.join("\n") },
  ];
  for (let i = 0; i < obs.length; i++) {
    const o = obs[i];
    if (!o.path) continue;
    if (visCfg) {
      content.push({ type: "text", text: `obs[${i}] frame_offset=${o.frame_offset}: ${captions.get(i) ?? "(no description)"}` });
      continue;
    }
    try {
      const bytes = fs.readFileSync(bridgePathToHost(o.path, backend));
      content.push({ type: "image", data: bytes.toString("base64"), mimeType: "image/png" });
    } catch (err) {
      content.push({
        type: "text",
        text: `(failed to read observation image at frame ${o.frame_offset}: ${pathlessFileReadError(err)})`,
      });
    }
  }
  return content;
}
const STATE_SECTIONS = new Set(["anim", "control", "ratings", "camera", "context", "debug", "freezes"]);
function parseStateSections(input: unknown, verbose: boolean): Set<string> {
  const out = new Set<string>();
  const addAll = () => { for (const s of STATE_SECTIONS) out.add(s); };
  if (verbose) addAll();
  if (input === undefined) return out;
  const vals = Array.isArray(input) ? input : [input];
  for (const val of vals) {
    if (typeof val !== "string") throw new Error("nhl94_state.sections must be a string or string array");
    if (val === "all") { addAll(); continue; }
    if (!STATE_SECTIONS.has(val)) throw new Error(`unknown nhl94_state section "${val}"`);
    out.add(val);
  }
  return out;
}
function rulesGameMode(flags: number): string {
  return (flags & 0x03) === 0 ? "Exhibition" : `unknown/menu flags=0x${(flags & 0xff).toString(16).toUpperCase().padStart(2, "0")}`;
}
function rulesPenalty(optPen: number): string {
  if (optPen === 0) return "OFF";
  if (optPen === 1) return "ON";
  if (optPen === 2) return "ON (except OFFSIDE)";
  return `unknown(${optPen})`;
}
function rulesPlayers(homeRaw: number, awayRaw: number, pad0: number, pad2: number): string {
  const homeHuman = homeRaw >= 0 && homeRaw <= 11;
  const awayHuman = awayRaw >= 0 && awayRaw <= 11;
  if (!homeHuman && !awayHuman) return "CPU-CPU";
  if (homeHuman && awayHuman) return "1P-2P";
  if (!homeHuman && awayHuman) return "CPU-1P";
  if (homeHuman) {
    const p2HasInput = (pad2 & 0xffff) !== 0 && (pad0 & 0xffff) === 0;
    return p2HasInput ? "2P-CPU" : "1P-CPU";
  }
  return "unknown";
}
function trapRows(traps: Record<string, Record<string, unknown>[]> | undefined): Record<string, unknown>[] {
  const rows: Record<string, unknown>[] = [];
  for (const [trap, entries] of Object.entries(traps ?? {})) {
    if (!Array.isArray(entries)) continue;
    for (const entry of entries) rows.push({ trap, ...entry });
  }
  return rows;
}
function trapCaptureBase(name?: unknown): string {
  const raw = typeof name === "string" && name.trim() ? name.trim() : "traps";
  return raw.replace(/[^A-Za-z0-9._-]/g, "_").slice(0, 64) || "traps";
}
function trapCapturePath(base: string, ext: "jsonl" | "csv"): string {
  const dir = path.join(os.tmpdir(), "mcp-bizhawk-trap-exec");
  fs.mkdirSync(dir, { recursive: true });
  return path.join(dir, `${base}.${ext}`);
}
function csvCell(v: unknown): string {
  if (v === undefined || v === null) return "";
  const s = typeof v === "object" ? JSON.stringify(v) : String(v);
  return /[",\n\r]/.test(s) ? `"${s.replace(/"/g, '""')}"` : s;
}
function formatTrapRead(
  r: { counts?: Record<string, number>; traps?: Record<string, Record<string, unknown>[]> },
  mode: string,
  name?: unknown,
  head = 3,
  tail = 3,
): string {
  const counts = JSON.stringify(r.counts ?? {});
  const traps = r.traps ?? {};
  if (mode === "summary") {
    const lines = [`trap_exec counts=${counts}`];
    for (const [trap, entries] of Object.entries(traps)) {
      const arr = Array.isArray(entries) ? entries : [];
      lines.push(`${trap}: ${arr.length} hit(s)`);
      arr.slice(0, head).forEach((entry, i) => lines.push(`  head[${i}] ${JSON.stringify(entry)}`));
      const tailStart = Math.max(head, arr.length - tail);
      arr.slice(tailStart).forEach((entry, i) => lines.push(`  tail[${i}] ${JSON.stringify(entry)}`));
    }
    return lines.join("\n");
  }
  if (mode === "jsonl_file") {
    const base = trapCaptureBase(name);
    const out = trapCapturePath(base, "jsonl");
    fs.writeFileSync(out, trapRows(traps).map((row) => JSON.stringify(row)).join("\n") + "\n");
    return `trap_exec counts=${counts}\nSaved trap_exec JSONL: ${base}.jsonl`;
  }
  if (mode === "csv_file") {
    const rows = trapRows(traps);
    const cols = Array.from(new Set(rows.flatMap((row) => Object.keys(row))));
    const base = trapCaptureBase(name);
    const out = trapCapturePath(base, "csv");
    const body = [cols.join(",")].concat(rows.map((row) => cols.map((c) => csvCell(row[c])).join(","))).join("\n");
    fs.writeFileSync(out, `${body}\n`);
    return `trap_exec counts=${counts}\nSaved trap_exec CSV: ${base}.csv`;
  }
  return `trap_exec counts=${counts}\n${JSON.stringify(traps, null, 1)}`;
}
function fmtHex(n: unknown): string {
  if (typeof n !== "number") return String(n);
  return `${n} (0x${n.toString(16).toUpperCase()})`;
}
function addrHex(n: number): string {
  return `0x${n.toString(16).toUpperCase().padStart(4, "0")}`;
}
function publicFilename(name: string | undefined): string {
  if (!name) return "(unnamed)";
  const parts = name.split(/[\\/]/).filter(Boolean);
  return parts.at(-1) ?? "(unnamed)";
}
function fmtMovieStatus(r: { loaded: boolean; mode?: string; filename?: string; length?: number }): string {
  if (!r.loaded && !r.filename) return "No movie loaded.";
  return `Movie: ${publicFilename(r.filename)} (${r.loaded ? "loaded" : "not loaded"}, mode: ${r.mode ?? "?"}, length: ${r.length ?? "?"})`;
}

// Named savestate slots, managed server-side under
// $MCP_BIZHAWK_STATE_DIR or ~/.mcp-bizhawk/states, namespaced per ROM hash.
// Read at call time so the env var can change (and tests can override it).
function stateDir(backend?: BizhawkBackend): string {
  return backend?.stateDirHost() || process.env.MCP_BIZHAWK_STATE_DIR || path.join(os.homedir(), ".mcp-bizhawk", "states");
}
// ── Usage logging ────────────────────────────────────────────────────────────
// Append one JSONL row per tool call so we can see, after the fact, which tools
// are actually exercised, which fail, and how they're parameterized — the raw
// material for shaping where this tool surface grows next. On by default;
// MCP_BIZHAWK_USAGE_LOG=off disables it, MCP_BIZHAWK_USAGE_LOG=<path> redirects.
// Per-daemon file (keyed by MCP_HTTP_PORT) so multiple emulators don't interleave.
const USAGE_LINE_CAP = 16 * 1024; // guard against a pathological megabyte arg
let usageWarned = false;
function usageLogPath(): string | null {
  const v = process.env.MCP_BIZHAWK_USAGE_LOG;
  if (v === "off" || v === "0" || v === "false") return null;
  if (v) return v;
  const port = process.env.MCP_HTTP_PORT ?? "8765";
  return path.join(os.homedir(), ".mcp-bizhawk", "usage", `usage-${port}.jsonl`);
}
function recordUsage(
  tool: string,
  target: string | undefined,
  args: Record<string, unknown>,
  ok: boolean,
  ms: number,
  error?: string,
): void {
  const file = usageLogPath();
  if (!file) return;
  try {
    const base = { ts: new Date().toISOString(), tool, ...(target ? { target } : {}), ok, ms, ...(error ? { error } : {}) };
    let line = JSON.stringify({ ...base, args });
    // Keep the line valid JSONL even if a single call carries a huge payload.
    if (line.length > USAGE_LINE_CAP) {
      line = JSON.stringify({ ...base, args: `<args too large: ${line.length} bytes>` });
    }
    fs.mkdirSync(path.dirname(file), { recursive: true });
    fs.appendFileSync(file, line + "\n");
  } catch (e) {
    if (!usageWarned) { // warn once, never spam, never throw into the request path
      usageWarned = true;
      process.stderr.write(`[mcp-bizhawk] usage log disabled (write failed: ${(e as Error).message})\n`);
    }
  }
}

function joinConfiguredPath(dir: string, ...parts: string[]): string {
  const isWin = /\\/.test(dir) || /^[A-Za-z]:/.test(dir);
  const sep = isWin ? "\\" : "/";
  const trimmed = dir.replace(/[\\/]+$/, "");
  return [trimmed, ...parts].join(sep);
}
function namedFile(name: unknown, kind: "slot" | "screenshot" | "snapshot"): string {
  if (typeof name !== "string") throw new Error(`${kind} name must be a string`);
  if (!/^[A-Za-z0-9._-]{1,64}$/.test(name)) {
    throw new Error(`${kind} name must be 1-64 chars of letters, digits, dot, underscore, hyphen`);
  }
  return name;
}
function screenshotFilename(name: unknown): string {
  const n = namedFile(name, "screenshot");
  return n.toLowerCase().endsWith(".png") ? n : `${n}.png`;
}
function rejectPathArg(tool: string, arg: string): never {
  throw new Error(
    `${tool}.${arg}: filesystem paths are not accepted by MCP clients; ` +
    "use target plus artifact names and let the backend resolve Windows/Linux paths.",
  );
}
function pathlessFileReadError(err: unknown): string {
  const code = typeof err === "object" && err !== null && "code" in err
    ? String((err as { code?: unknown }).code)
    : "";
  return code ? `${code}: file is not readable from the MCP server` : "file is not readable from the MCP server";
}
function publicVisionError(err: unknown): string {
  const code = typeof err === "object" && err !== null && "code" in err
    ? String((err as { code?: unknown }).code)
    : "";
  if (code) return pathlessFileReadError(err);
  return (err as Error).message
    .replace(/[A-Za-z]:\\[^\s'"`<>()]+/g, "[path]")
    .replace(/(^|[\s('"`])\/[^\s'"`<>()]+/g, "$1[path]");
}
function slotPath(hash: string, name: string, backend?: BizhawkBackend): string {
  namedFile(name, "slot");
  return path.join(stateDir(backend), hash, `${name}.State`);
}
function slotBridgePath(hash: string, name: string, backend?: BizhawkBackend): string {
  const bridgeDir = backend?.stateDirBridge() || process.env.MCP_BIZHAWK_STATE_DIR_BRIDGE;
  return bridgeDir ? joinConfiguredPath(bridgeDir, hash, `${name}.State`) : slotPath(hash, name, backend);
}
async function namedStatePaths(target: string, bh: BizhawkServer, name: unknown): Promise<{
  name: string;
  local: string;
  bridge: string;
}> {
  const backend = bh.getBackend(target);
  const hash = await currentRomHash(target, bh);
  const slot = namedFile(name, "slot");
  return { name: slot, local: slotPath(hash, slot, backend), bridge: slotBridgePath(hash, slot, backend) };
}
async function existingNamedStatePaths(target: string, bh: BizhawkServer, name: unknown): Promise<{
  name: string;
  local: string;
  bridge: string;
}> {
  const resolved = await namedStatePaths(target, bh, name);
  if (!fs.existsSync(resolved.local)) {
    const dir = path.dirname(resolved.local);
    const have = fs.existsSync(dir)
      ? fs.readdirSync(dir).filter((f) => f.endsWith(".State")).map((f) => f.slice(0, -6))
      : [];
    throw new Error(
      `no slot '${resolved.name}' for this ROM. Available: ${have.length ? have.join(", ") : "(none)"}`,
    );
  }
  return resolved;
}
async function currentRomHash(target: string, bh: BizhawkServer): Promise<string> {
  const info = await bh.call<{ rom_hash?: string }>(target, "get_info");
  return info.rom_hash && info.rom_hash !== "unavailable" ? info.rom_hash : "unknown-rom";
}

// Named NHL94 rigs (savestate + captured freeze set), namespaced per ROM hash
// under $MCP_BIZHAWK_RIG_DIR or ~/.mcp-bizhawk/rigs. Read at call time so tests
// can override the dir.
interface RigFreeze { address: number; width: string; value: number; domain?: string }
interface Rig {
  name: string;
  rom_md5: string;
  created_at: string;
  savestate_path: string;
  bridge_savestate_path?: string;
  freezes: RigFreeze[];
  freeze_count: number;
  note?: string;
}
function rigFreezeOp(f: RigFreeze): nhl94.MemOp & { domain?: string } {
  return {
    op: "freeze" as const,
    address: f.address,
    value: f.value,
    width: memoryOpsWriteWidth(f.width),
    ...(f.domain ? { domain: f.domain } : {}),
  };
}
function rigRoot(backend?: BizhawkBackend): string {
  return backend?.rigDirHost() || process.env.MCP_BIZHAWK_RIG_DIR || path.join(os.homedir(), ".mcp-bizhawk", "rigs");
}
function rigName(name: unknown): string {
  if (typeof name !== "string") throw new Error("rig name must be a string");
  if (!/^[A-Za-z0-9._-]{1,64}$/.test(name)) {
    throw new Error("rig name must be 1-64 chars of letters, digits, dot, underscore, hyphen");
  }
  return name;
}
function rigJsonPath(hash: string, name: string, backend?: BizhawkBackend): string {
  return path.join(rigRoot(backend), hash, `${name}.json`);
}
function rigStatePath(hash: string, name: string, backend?: BizhawkBackend): string {
  return path.join(rigRoot(backend), hash, `${name}.State`);
}
function rigBridgeStatePath(hash: string, name: string, backend?: BizhawkBackend): string {
  const bridgeDir = backend?.rigDirBridge() || process.env.MCP_BIZHAWK_RIG_DIR_BRIDGE;
  return bridgeDir ? joinConfiguredPath(bridgeDir, hash, `${name}.State`) : rigStatePath(hash, name, backend);
}
function availableRigs(hash: string, backend?: BizhawkBackend): string {
  const dir = path.join(rigRoot(backend), hash);
  if (!fs.existsSync(dir)) return "No rigs saved for this ROM.";
  const names = fs.readdirSync(dir).filter((f) => f.endsWith(".json")).map((f) => f.slice(0, -5));
  return names.length ? `Available: ${names.join(", ")}.` : "No rigs saved for this ROM.";
}

const RAW_ADDR_RE = /^(0x[0-9a-fA-F]+|\d+)$/;

function parseRawNumber(label: string, v: unknown): number {
  if (typeof v === "number") {
    if (!Number.isInteger(v) || v < 0) throw new Error(`${label} must be a non-negative integer`);
    return v;
  }
  if (typeof v !== "string" || !RAW_ADDR_RE.test(v)) {
    throw new Error(`${label} must be decimal or 0x-prefixed hex`);
  }
  return v.startsWith("0x") || v.startsWith("0X") ? parseInt(v, 16) : parseInt(v, 10);
}

interface NhlFieldRef {
  label: string;
  address: number;
  width: string;
  fixed: boolean;
  field: string;
  target: string;
  global: boolean;
}

function globalWidth(field: string): string {
  if (field === "gmode" || field === "session_byte" || field === "home_line" || field === "away_line") return "u8";
  if (field === "vpos" || field === "hpos" || field === "yleader" || field === "shotplayer" || field === "lastplayer" || field === "passdir" || field === "passspeed") return "s16_be";
  return "u16_be";
}

function resolveNhlFieldOp(op: Record<string, unknown>): NhlFieldRef {
  const target = String(op.target ?? "");
  const field = typeof op.field === "string" ? op.field : "";
  const allowRaw = op.allow_raw === true;
  const width = typeof op.width === "string" ? op.width : "u8";

  if (target === "global") {
    if (typeof op.address === "string" || typeof op.address === "number") {
      if (!allowRaw) throw new Error(`raw global address ${String(op.address)} requires allow_raw:true`);
      return { label: `global.${String(op.address)}`, address: parseRawNumber("address", op.address), width, fixed: false, field: String(op.address), target, global: true };
    }
    if (!field || !(field in nhl94.G)) {
      throw new Error(`unknown global field "${field}" (use carrier, clock, gameclock, period, gsp, gmode, faceoff_window_latch, home_line, away_line; raw address requires allow_raw:true)`);
    }
    return { label: `global.${field}`, address: nhl94.G[field], width: globalWidth(field), fixed: false, field, target, global: true };
  }

  const { base } = nhl94.resolveTarget(target);
  if (typeof op.offset === "string" || typeof op.offset === "number") {
    if (!allowRaw) throw new Error(`raw entity offset ${String(op.offset)} requires allow_raw:true`);
    const offset = parseRawNumber("offset", op.offset);
    if (offset < 0 || offset >= nhl94.SCSIZE) throw new Error(`raw entity offset ${String(op.offset)} out of struct range 0..0x${(nhl94.SCSIZE - 1).toString(16)}`);
    return { label: `${target}.${String(op.offset)}`, address: base + offset, width, fixed: false, field: String(op.offset), target, global: false };
  }
  if (!field || !(field in nhl94.OFF)) {
    throw new Error(`unknown field "${field}" (use a named NHL94 field, or raw offset with allow_raw:true)`);
  }
  return {
    label: `${target}.${field}`,
    address: base + nhl94.OFF[field],
    width: nhl94.FIELD_WIDTH[field] ?? "u16_be",
    fixed: nhl94.FIXED_FIELDS.has(field),
    field,
    target,
    global: false,
  };
}

function lineValue(v: unknown): number {
  if (typeof v === "string") {
    const key = v.toLowerCase();
    if (key === "sc1") return 0;
    if (key === "sc2") return 1;
    if (key === "chk") return 2;
  }
  if (typeof v === "number" && Number.isInteger(v)) return v;
  throw new Error("line value must be Sc1, Sc2, Chk, or an integer");
}

function encodeNhlValue(ref: NhlFieldRef, value: unknown): number {
  if (ref.global && ref.field === "carrier") {
    if (value === "none") return 0xffff;
    if (typeof value === "string") return nhl94.resolveTarget(value).slot;
  }
  if (ref.global && (ref.field === "clock" || ref.field === "gameclock")) {
    return nhl94.parseClock(value as string | number);
  }
  if (ref.global && (ref.field === "home_line" || ref.field === "away_line")) {
    return lineValue(value);
  }
  if (!ref.global && ref.field === "fdir") {
    return nhl94.fdirValue(value) & 0xffff;
  }
  if (typeof value !== "number" || !Number.isInteger(value)) {
    throw new Error(`${ref.label} value must be an integer`);
  }
  if (ref.fixed) return nhl94.toFixed(value);
  if (ref.width === "s16_be" || ref.width === "u16_be" || ref.width === "s16" || ref.width === "u16") return value & 0xffff;
  if (ref.width === "s32_be" || ref.width === "u32_be" || ref.width === "s32" || ref.width === "u32") return value >>> 0;
  return value & 0xff;
}

function memoryOpsWriteWidth(width: string): string {
  if (width === "s8") return "u8";
  if (width === "s16") return "u16";
  if (width === "s16_be") return "u16_be";
  if (width === "s32") return "u32";
  if (width === "s32_be") return "u32_be";
  return width;
}

function decodeNhlValue(ref: NhlFieldRef, raw: number): string {
  if (ref.fixed) return String(nhl94.fromFixed(raw >>> 0).whole);
  if (!ref.global && ref.field === "fdir") return nhl94.fdirLabel(raw);
  if (ref.global && (ref.field === "clock" || ref.field === "gameclock")) return `${nhl94.formatClock(raw)} (${raw}s)`;
  if (ref.global && (ref.field === "home_line" || ref.field === "away_line")) return `${nhl94.lineLabel(raw)} (${raw})`;
  if (ref.global && ref.field === "carrier") return raw >= 0 && raw <= 11 ? `s${raw}` : `none (0x${(raw >>> 0).toString(16).toUpperCase()})`;
  return String(raw);
}

// Optional frame step after sprite-moving writes so BizHawk re-renders the new
// positions. Default callers pass 0 for frame-precise RAM edits.
// Returns whether the step actually ran, for an honest note in the output.
async function nhlSettle(target: string, bh: BizhawkServer, frames: number): Promise<boolean> {
  if (frames <= 0) return false;
  try {
    await bh.call(target, "frame_advance", { count: frames }, { timeoutMs: frameTimeout(frames) });
    return true;
  } catch {
    return false;
  }
}

function ramSnapshotFilename(name: unknown): string {
  const n = namedFile(name, "snapshot");
  return n.toLowerCase().endsWith(".bin") ? n : `${n}.bin`;
}

// Screenshot path handling for cross-filesystem setups. When BizHawk runs on a
// DIFFERENT host/OS than this server (e.g. a Windows BizHawk driven by a Linux
// daemon over a shared mount), the two spell the SAME shared directory
// differently, so the path we tell BizHawk to WRITE is not the path this server
// can READ back to inline/describe the PNG. Two env vars resolve it, per daemon:
//   MCP_BIZHAWK_SHOT_DIR         — the shared dir as THIS SERVER sees it (read-back path)
//   MCP_BIZHAWK_SHOT_DIR_BRIDGE  — the same dir as the BRIDGE/BizHawk sees it (write path)
// e.g. on the Windows daemon: MCP_BIZHAWK_SHOT_DIR=/mnt/8tb/jason/tmp and
// MCP_BIZHAWK_SHOT_DIR_BRIDGE='X:\tmp' (X:\ == /mnt/8tb/jason). Defaults: both =
// the OS temp dir — co-located BizHawk, no translation (the historical behavior).
// Returns `local` (fs read/describe) and `remote` (sent to the bridge screenshot
// command); they are the same file via the shared mount, spelled per side.
export function shotPaths(name: string, backend?: BizhawkBackend): { local: string; remote: string } {
  const localDir = backend?.shotDirHost() || process.env.MCP_BIZHAWK_SHOT_DIR || os.tmpdir();
  const local = path.join(localDir, name);
  if (backend?.shotDirHost() || process.env.MCP_BIZHAWK_SHOT_DIR) {
    try { fs.mkdirSync(localDir, { recursive: true }); } catch { /* best-effort */ }
  }
  const bridgeDir = backend?.shotDirBridge() || process.env.MCP_BIZHAWK_SHOT_DIR_BRIDGE;
  if (!bridgeDir) return { local, remote: local };
  // Join with the separator the bridge's path implies (Windows drive/backslash
  // → "\", otherwise "/"), trimming any trailing separator on the configured dir.
  const isWin = /\\/.test(bridgeDir) || /^[A-Za-z]:/.test(bridgeDir);
  const sep = isWin ? "\\" : "/";
  const trimmed = bridgeDir.replace(/[\\/]+$/, "");
  return { local, remote: `${trimmed}${sep}${name}` };
}

function pathStartsWithFileDir(filePath: string, dir: string): boolean {
  const f = filePath.replace(/\\/g, "/").replace(/\/+$/, "").toLowerCase();
  const d = dir.replace(/\\/g, "/").replace(/\/+$/, "").toLowerCase();
  return f === d || f.startsWith(`${d}/`);
}

function bridgePathToHost(filePath: string, backend?: BizhawkBackend): string {
  const pairs: { host?: string; bridge?: string }[] = [
    { host: backend?.shotDirHost() || process.env.MCP_BIZHAWK_SHOT_DIR, bridge: backend?.shotDirBridge() || process.env.MCP_BIZHAWK_SHOT_DIR_BRIDGE },
    { host: backend?.stateDirHost() || process.env.MCP_BIZHAWK_STATE_DIR, bridge: backend?.stateDirBridge() || process.env.MCP_BIZHAWK_STATE_DIR_BRIDGE },
    { host: backend?.rigDirHost() || process.env.MCP_BIZHAWK_RIG_DIR, bridge: backend?.rigDirBridge() || process.env.MCP_BIZHAWK_RIG_DIR_BRIDGE },
  ];
  for (const pair of pairs) {
    if (!pair.host || !pair.bridge || !pathStartsWithFileDir(filePath, pair.bridge)) continue;
    const rel = filePath.replace(/\\/g, "/").slice(pair.bridge.replace(/\\/g, "/").replace(/\/+$/, "").length).replace(/^\/+/, "");
    return path.join(pair.host, ...rel.split("/").filter(Boolean));
  }
  if (/^X:[\\/]/i.test(filePath)) {
    const rel = filePath.slice(3).replace(/[\\/]/g, "/");
    return path.join("/mnt/8tb/jason", ...rel.split("/").filter(Boolean));
  }
  return filePath;
}

// The JD build is NHL94-focused: expose all nhl94_* tools plus a curated core
// of bizhawk_* tools, and hide the rest to keep the surface small (the hidden
// raw-memory/freeze tools are the endian/width footguns nhl94_* replaces). All
// tools still DISPATCH — this only filters what tools/list advertises — so
// nhl94_* internals and the BIZHAWK_ALL_TOOLS=1 override keep working.
const EXPOSED_BIZHAWK = new Set([
  "bizhawk_list_backends",
  "bizhawk_ping",
  "bizhawk_get_info",
  "bizhawk_pause",
  "bizhawk_unpause",
  "bizhawk_frame_advance",
  "bizhawk_reset",
  "bizhawk_press_buttons",
  "bizhawk_play_input_sequence",
  "bizhawk_observe_frames",
  "bizhawk_screenshot",
  "bizhawk_save_state",
  "bizhawk_load_state",
  "bizhawk_read_many",
  "bizhawk_ram_snapshot",
  "bizhawk_disassemble",
  "bizhawk_trap_exec",
  "bizhawk_eval_lua",
  "bizhawk_trace_start",
  "bizhawk_trace_stop",
  "bizhawk_trace_status",
  "bizhawk_trace_tail",
  "bizhawk_phys_trace_start",
  "bizhawk_phys_trace_stop",
  "bizhawk_phys_trace_status",
  "bizhawk_phys_trace_tail",
]);
const DROPPED_TOOL_NAMES = new Set([
  "bizhawk_save_slot",
  "bizhawk_load_slot",
  "bizhawk_list_slots",
]);
function exposedTools(): Tool[] {
  const available = TOOLS.filter((t) => !DROPPED_TOOL_NAMES.has(t.name));
  if (process.env.BIZHAWK_ALL_TOOLS) return available;
  return available.filter((t) => t.name.startsWith("nhl94_") || EXPOSED_BIZHAWK.has(t.name));
}

export function registerTools(server: Server, bh: import("./bizhawk.js").BizhawkServer): void {
  server.setRequestHandler(ListToolsRequestSchema, async () => ({ tools: exposedTools() }));

  const dispatchTool = async (req: { params: { name: string; arguments?: unknown } }) => {
    const { name, arguments: args = {} } = req.params;
    const p = args as Record<string, unknown>;
    const a = () => p.address as number;
    const dom = () => p.domain ? { domain: p.domain } : {};
    const bo  = () => p.byteorder ? { byteorder: p.byteorder } : {};

    switch (name) {
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
          return ok(`${r} (mcp-bizhawk v${VERSION}, backend "${target}" polling)`);
        } catch (err) {
          return ok(`Backend "${target}" — bridge did not answer: ${(err as Error).message}`);
        }
      }

      case "bizhawk_get_info": {
        const target = p.target as string;
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
        }>(target, "get_info");
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
        const target = p.target as string;
        const r = await bh.call<string[]>(target, "list_memory_domains");
        return ok("Memory domains:\n  " + r.join("\n  "));
      }

      case "bizhawk_read8":  { const target = p.target as string; return ok(`${addrHex(a())}: ${fmtHex(await bh.call<number>(target, "read8", { address: a(), ...dom() }))}`); }
      case "bizhawk_read16": { const target = p.target as string; return ok(`${addrHex(a())}: ${fmtHex(await bh.call<number>(target, "read16", { address: a(), ...dom(), ...bo() }))}`); }
      case "bizhawk_read32": { const target = p.target as string; return ok(`${addrHex(a())}: ${fmtHex(await bh.call<number>(target, "read32", { address: a(), ...dom(), ...bo() }))}`); }

      case "bizhawk_read_range": {
        const target = p.target as string;
        const bytes = await bh.call<number[]>(target, "read_range", { address: a(), length: p.length, ...dom() });
        const hex = bytes.map((b) => b.toString(16).padStart(2, "0").toUpperCase()).join(" ");
        return ok(`${addrHex(a())} [${bytes.length} bytes${p.domain ? `, ${p.domain}` : ""}]:\n${hex}`);
      }

      case "bizhawk_ram_snapshot": {
        const target = p.target as string;
        if (p.path !== undefined) rejectPathArg(name, "path");
        const base = (p.base as number | undefined) ?? 0;
        const size = (p.size as number | undefined) ?? 0x10000;
        const domain = (p.domain as string | undefined) ?? "68K RAM";
        const snapshotName = p.name !== undefined
          ? ramSnapshotFilename(p.name)
          : `bizhawk-ram-${domain.replace(/[^a-z0-9]/gi, "_")}-${base.toString(16)}-${size.toString(16)}.bin`;
        const outPath = (p.path as string | undefined)
          ?? path.join(os.homedir(), ".mcp-bizhawk", "ram-snapshots", snapshotName);
        // Chunk into <=4096-byte read_range calls (the bridge's per-call cap) and
        // assemble server-side, so the file lands on the server host regardless of
        // which BizHawk filesystem the emulator runs on.
        const buf = Buffer.allocUnsafe(size);
        for (let off = 0; off < size; off += 4096) {
          const len = Math.min(4096, size - off);
          const chunk = await bh.call<number[]>(target, "read_range", { address: base + off, length: len, domain });
          for (let i = 0; i < len; i++) buf[off + i] = chunk[i] & 0xff;
        }
        fs.mkdirSync(path.dirname(outPath), { recursive: true });
        fs.writeFileSync(outPath, buf);
        const digest = crypto.createHash("sha256").update(buf).digest("hex");
        return ok(`${snapshotName} (${size} bytes, ${domain} @0x${base.toString(16).toUpperCase()}) sha256=${digest}`);
      }

      case "bizhawk_trap_exec": {
        const target = p.target as string;
        const action = p.action as string;
        const args: Record<string, unknown> = { action: action === "read_stop" ? "read" : action };
        if (action === "start") {
          if (!Array.isArray(p.traps) || p.traps.length === 0) throw new Error("action:start requires a non-empty `traps` array");
          args.traps = p.traps;
          if (p.limit !== undefined) args.limit = p.limit;
        }
        if ((action === "read" || action === "read_stop") && p.name !== undefined) args.name = p.name;
        const r = await bh.call<{
          started?: number;
          traps?: unknown;
          counts?: Record<string, number>;
          active?: boolean;
        }>(target, "trap_exec", args);
        if (action === "start") {
          const names = Array.isArray(r.traps) ? r.traps.join(", ") : "";
          return ok(`Armed ${r.started} trap(s): ${names}. Now drive frames (bizhawk_frame_advance / bizhawk_observe_frames / play_input_sequence), then action:"read" or action:"read_stop". Call action:"stop" when done — live hooks cost emulation speed.`);
        }
        if (action === "status") return ok(`trap_exec active=${r.active} counts=${JSON.stringify(r.counts ?? {})}`);
        if (action === "stop") return ok(`Stopped trap_exec. Final counts: ${JSON.stringify(r.counts ?? {})}`);
        const readText = formatTrapRead(
          r as { counts?: Record<string, number>; traps?: Record<string, Record<string, unknown>[]> },
          (p.read_mode as string | undefined) ?? "json",
          p.name,
          (p.head as number | undefined) ?? 3,
          (p.tail as number | undefined) ?? 3,
        );
        if (action !== "read_stop") return ok(readText);
        const stopped = await bh.call<{ counts?: Record<string, number> }>(target, "trap_exec", { action: "stop" });
        return ok(`${readText}\nStopped trap_exec. Final counts: ${JSON.stringify(stopped.counts ?? {})}`);
      }

      case "bizhawk_write8": {
        const target = p.target as string;
        await bh.call(target, "write8", { address: a(), value: p.value, ...dom() });
        return ok(`Wrote ${fmtHex(p.value)} → ${addrHex(a())}${p.domain ? ` (${p.domain})` : ""}`);
      }
      case "bizhawk_write16": {
        const target = p.target as string;
        await bh.call(target, "write16", { address: a(), value: p.value, ...dom(), ...bo() });
        return ok(`Wrote ${fmtHex(p.value)} → ${addrHex(a())}${p.domain ? ` (${p.domain})` : ""}`);
      }
      case "bizhawk_write32": {
        const target = p.target as string;
        await bh.call(target, "write32", { address: a(), value: p.value, ...dom(), ...bo() });
        return ok(`Wrote ${fmtHex(p.value)} → ${addrHex(a())}${p.domain ? ` (${p.domain})` : ""}`);
      }
      case "bizhawk_write_range": {
        const target = p.target as string;
        const r = await bh.call<{ written: number }>(target, "write_range", { address: a(), bytes: p.bytes, ...dom() });
        return ok(`Wrote ${r.written} bytes → ${addrHex(a())}${p.domain ? ` (${p.domain})` : ""}`);
      }

      case "bizhawk_press_buttons": {
        const target = p.target as string;
        const r = await bh.call<true | { state?: StateSummary }>(target, 
          "press_buttons", { buttons: p.buttons, player: p.player ?? 1 },
        );
        const pressed = Object.entries(p.buttons as Record<string, boolean>)
          .filter(([, v]) => v).map(([k]) => k);
        const base = `Set joypad ${p.player ?? 1}: ${pressed.length ? pressed.join("+") : "(all released)"}`;
        return ok(withState(base, typeof r === "object" ? r.state : undefined));
      }

      case "bizhawk_play_input_sequence": {
        // `describe` is server-side only (vision runs after the bridge replies);
        // validate config up front so we don't play frames then fail.
        const target = p.target as string;
        const backend = bh.getBackend(target);
        const visCfg = p.describe ? requireVisionConfig() : null;
        const params: Record<string, unknown> = { frames: p.frames };
        if (p.load_state_path !== undefined) rejectPathArg(name, "load_state_path");
        if (p.screenshot_dir !== undefined) rejectPathArg(name, "screenshot_dir");
        if (p.load_slot             !== undefined) {
          const slot = await existingNamedStatePaths(target, bh, p.load_slot);
          params.load_state_path = slot.bridge;
        }
        if (p.observe_every          !== undefined) params.observe_every          = p.observe_every;
        if (p.screenshot_every       !== undefined) params.screenshot_every       = p.screenshot_every;
        if (p.screenshot_every !== undefined && backend.shotDirBridge()) params.screenshot_dir = backend.shotDirBridge();
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
          state?: StateSummary;
          observations?: {
            frame_offset: number;
            path?: string;
            memory?: Record<string, number>;
          }[];
        }>(target, "play_input_sequence", params, { timeoutMs: frameTimeout(totalFrames) });

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
        const playState = fmtState(r.state);
        if (playState) lines.push(`State: ${playState}`);

        // When describing, caption each screenshot via the vision model instead
        // of inlining it (sequential — gentle on a single local model).
        const captions = new Map<number, string>();
        if (visCfg) {
          for (let i = 0; i < obs.length; i++) {
            if (obs[i].path) {
              captions.set(i, await safeDescribe(bridgePathToHost(obs[i].path as string, backend), p.describe_prompt as string | undefined, visCfg));
            }
          }
        }

        // Per-observation lines so the agent can correlate state with images/captions.
        for (let i = 0; i < obs.length; i++) {
          const o = obs[i];
          const memStr = o.memory
            ? ` memory={${Object.entries(o.memory).map(([k, v]) => `${k}=${v}`).join(", ")}}`
            : "";
          const tag = !o.path ? "" : (visCfg ? " (described below)" : ` (image ${i + 1})`);
          lines.push(`  obs[${i}] frame_offset=${o.frame_offset}${memStr}${tag}`);
        }

        // Build the multi-content response: text summary, then either a text
        // caption per screenshot (describe mode) or the inlined PNG. Memory-only
        // observations (no path — e.g. observe_every) add nothing here.
        const content: ({ type: "text"; text: string } | { type: "image"; data: string; mimeType: string })[] = [
          { type: "text", text: lines.join("\n") },
        ];
        for (let i = 0; i < obs.length; i++) {
          const o = obs[i];
          if (!o.path) continue;
          if (visCfg) {
            content.push({ type: "text", text: `obs[${i}] frame_offset=${o.frame_offset}: ${captions.get(i) ?? "(no description)"}` });
            continue;
          }
          try {
            const bytes = fs.readFileSync(bridgePathToHost(o.path, backend));
            content.push({ type: "image", data: bytes.toString("base64"), mimeType: "image/png" });
          } catch (err) {
            content.push({
              type: "text",
              text: `(failed to read observation image at frame ${o.frame_offset}: ${pathlessFileReadError(err)})`,
            });
          }
        }
        return { content };
      }

      case "bizhawk_observe_frames": {
        const target = p.target as string;
        const backend = bh.getBackend(target);
        const visCfg = p.describe ? requireVisionConfig() : null;
        const params: Record<string, unknown> = { count: p.frames };
        if (p.screenshot_dir !== undefined) rejectPathArg(name, "screenshot_dir");
        if (p.observe_every          !== undefined) params.observe_every          = p.observe_every;
        if (p.screenshot_every       !== undefined) params.screenshot_every       = p.screenshot_every;
        if (p.screenshot_every !== undefined && backend.shotDirBridge()) params.screenshot_dir = backend.shotDirBridge();
        if (p.screenshot_prefix      !== undefined) params.screenshot_prefix      = p.screenshot_prefix;
        if (p.observe_memory         !== undefined) params.observe_memory         = p.observe_memory;
        if (p.turbo                  !== undefined) params.turbo                  = p.turbo;
        const frames = p.frames as number;
        const r = await bh.call<{
          played: number;
          final_framecount?: number;
          state?: StateSummary;
          observations?: FrameObservation[];
        }>(target, "observe_frames", params, { timeoutMs: frameTimeout(frames) });

        const obs = Array.isArray(r.observations) ? r.observations : [];
        const lines = [
          `Observed ${r.played} frames. Final framecount: ${r.final_framecount ?? "(unavailable)"}.`,
          `Captured ${obs.length} observation${obs.length === 1 ? "" : "s"}.`,
        ];
        const st = fmtState(r.state);
        if (st) lines.push(`State: ${st}`);
        return {
          content: await observationContent(
            lines.join("\n"),
            obs,
            backend,
            visCfg,
            p.describe_prompt as string | undefined,
          ),
        };
      }

      case "bizhawk_run_trials": {
        const target = p.target as string;
        const backend = bh.getBackend(target);
        const trialsVisCfg = p.describe ? requireVisionConfig() : null;
        const trials = p.trials as { frames?: { hold?: number }[] }[];
        if (p.state_path !== undefined) rejectPathArg(name, "state_path");
        if (p.screenshot_dir !== undefined) rejectPathArg(name, "screenshot_dir");
        if (p.state_slot === undefined) throw new Error("bizhawk_run_trials.state_slot is required");
        const slot = await existingNamedStatePaths(target, bh, p.state_slot);
        const statePath = slot.bridge;
        const stateLabel = `slot '${slot.name}'`;
        const params: Record<string, unknown> = { state_path: statePath, trials: p.trials };
        if (p.observe_memory    !== undefined) params.observe_memory    = p.observe_memory;
        if (p.screenshot        !== undefined) params.screenshot        = p.screenshot;
        if (p.screenshot === true && backend.shotDirBridge()) params.screenshot_dir = backend.shotDirBridge();
        if (p.screenshot_prefix !== undefined) params.screenshot_prefix = p.screenshot_prefix;
        if (p.turbo             !== undefined) params.turbo             = p.turbo;
        // Timeout scales with every emulated frame across all trials, plus a
        // per-trial slice for the savestate load + optional screenshot.
        const totalFrames = trials.reduce(
          (sum, t) => sum + (t.frames ?? []).reduce((s, f) => s + (f.hold ?? 1), 0), 0,
        );
        const r = await bh.call<{
          trials?: {
            name: string;
            played: number;
            final_framecount?: number;
            memory?: Record<string, number>;
            screenshot_path?: string;
          }[];
        }>(target, "run_trials", params, { timeoutMs: frameTimeout(totalFrames + trials.length * 10) });

        const rows = Array.isArray(r.trials) ? r.trials : [];

        // Caption each trial's screenshot via the vision model when describing.
        const trialCaptions = new Map<number, string>();
        if (trialsVisCfg) {
          for (let i = 0; i < rows.length; i++) {
            if (rows[i].screenshot_path) {
              trialCaptions.set(i, await safeDescribe(bridgePathToHost(rows[i].screenshot_path as string, backend), p.describe_prompt as string | undefined, trialsVisCfg));
            }
          }
        }

        const lines = [`Ran ${rows.length} trial${rows.length === 1 ? "" : "s"} from ${stateLabel}.`];
        for (let i = 0; i < rows.length; i++) {
          const t = rows[i];
          const memStr = t.memory && Object.keys(t.memory).length
            ? " — " + Object.entries(t.memory).map(([k, v]) => `${k}=${v}`).join(", ")
            : "";
          const tag = !t.screenshot_path ? "" : (trialsVisCfg ? " (described below)" : " (image)");
          lines.push(`[${t.name}] played ${t.played}, frame ${t.final_framecount ?? "?"}${memStr}${tag}`);
        }

        const content: ({ type: "text"; text: string } | { type: "image"; data: string; mimeType: string })[] = [
          { type: "text", text: lines.join("\n") },
        ];
        for (let i = 0; i < rows.length; i++) {
          const t = rows[i];
          if (!t.screenshot_path) continue;
          if (trialsVisCfg) {
            content.push({ type: "text", text: `[${t.name}]: ${trialCaptions.get(i) ?? "(no description)"}` });
            continue;
          }
          try {
            const bytes = fs.readFileSync(bridgePathToHost(t.screenshot_path, backend));
            content.push({ type: "image", data: bytes.toString("base64"), mimeType: "image/png" });
          } catch (err) {
            content.push({ type: "text", text: `(failed to read trial '${t.name}' screenshot: ${pathlessFileReadError(err)})` });
          }
        }
        return { content };
      }

      case "bizhawk_pause": {
        const target = p.target as string;
        const r = await bh.call<true | { state?: StateSummary }>(target, "pause");
        return ok(withState("Emulation paused", typeof r === "object" ? r.state : undefined));
      }
      case "bizhawk_unpause": {
        const target = p.target as string;
        const r = await bh.call<true | { state?: StateSummary }>(target, "unpause");
        return ok(withState("Emulation resumed", typeof r === "object" ? r.state : undefined));
      }
      case "bizhawk_reset": {
        const target = p.target as string;
        const r = await bh.call<true | { state?: StateSummary }>(target, "reset");
        return ok(withState("Core reset", typeof r === "object" ? r.state : undefined));
      }
      case "bizhawk_frame_advance": {
        const target = p.target as string;
        const count = (p.count as number) ?? 1;
        const faParams: Record<string, unknown> = { count };
        if (p.turbo !== undefined) faParams.turbo = p.turbo;
        const f = await bh.call<number | { framecount?: number; state?: StateSummary }>(target, 
          "frame_advance", faParams, { timeoutMs: frameTimeout(count) });
        // Bridge may return a bare framecount (legacy) or {framecount, state}.
        const fc = typeof f === "number" ? f : (f.framecount ?? f.state?.framecount);
        const st = typeof f === "number" ? null : fmtState(f.state);
        const base = `Advanced ${count} frame(s). Framecount: ${fc}`;
        return ok(st ? `${base}\nState: ${st}` : base);
      }

      case "bizhawk_wait_for_memory": {
        const target = p.target as string;
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
        }>(target, "wait_for_memory", params, { timeoutMs: frameTimeout(timeoutFrames) });
        return ok(
          `Condition ${r.matched ? "met" : "NOT met (timeout)"} after ${r.frames_waited} frame(s). ` +
          `Value: ${fmtHex(r.value)}. Framecount: ${r.final_framecount ?? "(unavailable)"}`,
        );
      }

      case "bizhawk_read_many": {
        const target = p.target as string;
        const reads = p.reads as { name: string }[];
        const r = await bh.call<Record<string, number>>(target, "read_many", { reads });
        const lines = reads.map((s) => {
          const v = r[s.name];
          return `${s.name} = ${typeof v === "number" && v < 0 ? v : fmtHex(v)}`;
        });
        return ok(lines.join("\n"));
      }

      case "bizhawk_read_struct_array": {
        const target = p.target as string;
        const fields = p.fields as { name: string }[];
        const r = await bh.call<Record<string, number>[]>(target, "read_struct_array", {
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
        const target = p.target as string;
        if (p.entries !== undefined) {
          if (p.address !== undefined || p.value !== undefined) {
            throw new Error("pass either address+value or entries, not both");
          }
          const entries = p.entries as { address: number; value: number; width?: string; domain?: string }[];
          const params: Record<string, unknown> = { entries, ...dom() };
          if (p.width !== undefined) params.width = p.width;
          const r = await bh.call<{ frozen_count: number }>(target, "freeze", params);
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
        const r = await bh.call<{ frozen_count: number }>(target, "freeze", params);
        return ok(
          `Froze ${addrHex(a())}${p.domain ? ` (${p.domain})` : ""} = ${fmtHex(p.value)}. ` +
          `${r.frozen_count} address(es) frozen.`,
        );
      }
      case "bizhawk_unfreeze": {
        const target = p.target as string;
        const params: Record<string, unknown> = {};
        if (p.address   !== undefined) params.address   = p.address;
        if (p.addresses !== undefined) params.addresses = p.addresses;
        if (p.domain    !== undefined) params.domain    = p.domain;
        if (p.all       !== undefined) params.all       = p.all;
        const r = await bh.call<{ frozen_count: number }>(target, "unfreeze", params);
        return ok(`${r.frozen_count} address(es) frozen.`);
      }
      case "bizhawk_list_frozen": {
        const target = p.target as string;
        const r = await bh.call<{
          count: number;
          frozen?: { address: number; width: string; value: number; domain?: string }[];
        }>(target, "list_frozen");
        const list = Array.isArray(r.frozen) ? r.frozen : [];
        if (list.length === 0) return ok("(no frozen addresses)");
        return ok(list
          .map((f) => `${addrHex(f.address)} ${f.width} = ${f.value}${f.domain ? ` (${f.domain})` : ""}`)
          .join("\n"));
      }
      case "bizhawk_memory_ops": {
        const target = p.target as string;
        const ops = p.ops as { op: string; address: number; value?: number; width?: string; domain?: string }[];
        const params: Record<string, unknown> = { ops, ...dom() };
        if (p.width !== undefined) params.width = p.width;
        const r = await bh.call<{ applied: number; frozen_count: number }>(target, "memory_ops", params);
        const lines = ops.map((o) => {
          const d = o.domain ?? p.domain;
          const loc = `${addrHex(o.address)}${d ? ` (${d})` : ""}`;
          if (o.op === "unfreeze") return `Unfroze ${loc}`;
          return `${o.op === "freeze" ? "Froze" : "Wrote"} ${loc} = ${fmtHex(o.value)}`;
        });
        return ok(`${lines.join("\n")}\n${r.applied} op(s) applied in one frame. ${r.frozen_count} address(es) frozen.`);
      }

      // ── NHL94 game-semantic tools ───────────────────────────────────────
      case "nhl94_recipes":
        return ok(nhl94.RECIPES_GUIDE);

      case "nhl94_teleport": {
        const target = p.target as string;
        const backend = bh.getBackend(target);
        const entries = p.targets as nhl94.TeleportEntry[];
        const d = await backend.nhlDomain();
        const domain = await d.detect({});
        // Auto-detach: if pk is being teleported and a skater carries it, write
        // "nobody" to the carrier word first (else carry logic snaps it back).
        const hasPk = entries.some((e) => e.target === "pk");
        let carrier = -1;
        let detach = false;
        if (hasPk) {
          carrier = await bh.call<number>(target, "read16", { address: d.addr(nhl94.G.carrier), byteorder: "be", domain });
          detach = carrier >= 0 && carrier <= 11;
        }
        const ops = nhl94.teleportOps(entries, detach); // validates; throws before any write
        await bh.call(target, "memory_ops", { ops: d.rebase(ops), domain });
        const lines = entries.map((e) => {
          const parts = (["x", "y", "z", "xv", "yv", "zv"] as const)
            .filter((ax) => e[ax] !== undefined)
            .map((ax) => `${ax}=${e[ax]}`);
          let line = `Teleported ${e.target} → ${parts.join(" ")}`;
          if (e.target === "pk") line += detach ? ` (detached from s${carrier})` : " (loose puck)";
          return line;
        });
        const settleFrames = typeof p.settle_frames === "number" ? p.settle_frames : 0;
        const settled = await nhlSettle(target, bh, settleFrames);
        return ok(`${lines.join("\n")}${settled ? `\n(+${settleFrames} frames so the move renders)` : ""}`);
      }

      case "nhl94_freeze": {
        const target = p.target as string;
        const backend = bh.getBackend(target);
        const targets = p.targets as string[];
        if (!targets.length) throw new Error("targets must be a non-empty array");
        const d = await backend.nhlDomain();
        const domain = await d.detect({});
        const reads = targets.flatMap((t) => {
          const { base } = nhl94.resolveTarget(t); // validates target
          return (["x", "y", "z"] as const).map((ax) => ({
            name: `${t}.${ax}`, address: d.addr(base + nhl94.OFF[ax]), width: "s32_be", domain,
          }));
        });
        const vals = await bh.call<Record<string, number>>(target, "read_many", { reads });
        const positions: Record<string, { x: number; y: number; z: number }> = {};
        for (const t of targets) {
          positions[t] = { x: vals[`${t}.x`], y: vals[`${t}.y`], z: vals[`${t}.z`] };
        }
        const ops = nhl94.freezeOps(targets, positions);
        const r = await bh.call<{ frozen_count: number }>(target, "memory_ops", { ops: d.rebase(ops), domain });
        const whole = (raw: number) => nhl94.fromFixed(raw >>> 0).whole;
        const lines = targets.map((t) => {
          const pos = positions[t];
          return `Froze ${t} in place @ (x=${whole(pos.x)},y=${whole(pos.y)},z=${whole(pos.z)}); zeroed xv/yv/zv`;
        });
        return ok(`${lines.join("\n")}\n${r.frozen_count} address(es) frozen.`);
      }

      case "nhl94_unfreeze": {
        const target = p.target as string;
        const backend = bh.getBackend(target);
        const targets = p.targets as string[] | undefined;
        const all = p.all === true;
        if (all && targets !== undefined) throw new Error("pass either targets or all:true, not both");
        if (all) {
          const r = await bh.call<{ frozen_count: number }>(target, "unfreeze", { all: true });
          return ok(`Released all freezes (targets, globals, stale, and unmapped).\n${r.frozen_count} address(es) still frozen.`);
        }
        if (!targets?.length) throw new Error("pass a non-empty targets array or all:true");
        const d = await backend.nhlDomain();
        const domain = await d.detect({});
        const ops = nhl94.unfreezeOps(targets); // validates targets
        const r = await bh.call<{ frozen_count: number }>(target, "memory_ops", { ops: d.rebase(ops), domain });
        const lines = targets.map((t) => `Released freezes on ${t}`);
        return ok(`${lines.join("\n")}\n${r.frozen_count} address(es) still frozen.`);
      }

      case "nhl94_state": {
        const target = p.target as string;
        const backend = bh.getBackend(target);
        const raw = p.raw === true;
        const verbose = p.verbose === true;
        const sections = parseStateSections(p.sections, verbose);
        const d = await backend.nhlDomain();
        const domain = await d.detect({});
        const fields = [
          { name: "x", offset: nhl94.OFF.x, width: "s32_be" },
          { name: "y", offset: nhl94.OFF.y, width: "s32_be" },
          { name: "z", offset: nhl94.OFF.z, width: "s32_be" },
          { name: "xv", offset: nhl94.OFF.xv, width: "s16_be" },
          { name: "yv", offset: nhl94.OFF.yv, width: "s16_be" },
          { name: "zv", offset: nhl94.OFF.zv, width: "s16_be" },
          { name: "fdir", offset: nhl94.OFF.fdir, width: "u16_be" },
          { name: "frame", offset: nhl94.OFF.frame, width: "u16_be" },
          { name: "attr", offset: nhl94.OFF.attr, width: "u16_be" },
          { name: "anim", offset: nhl94.OFF.anim, width: "u16_be" },
          { name: "spanum", offset: nhl94.OFF.spanum, width: "u16_be" },
          { name: "spacnt", offset: nhl94.OFF.spacnt, width: "s16_be" },
          // Ratings — always read so the carrier's readout (OSD parity) is
          // available without a second round-trip; only printed for the carrier.
          { name: "shotpwr", offset: nhl94.OFF.shotpwr, width: "u8" },
          { name: "shotacc", offset: nhl94.OFF.shotacc, width: "u8" },
          { name: "passacc", offset: nhl94.OFF.passacc, width: "u8" },
          { name: "energy", offset: nhl94.OFF.energy, width: "u8" },
          { name: "pf", offset: nhl94.OFF.pf, width: "u8" },
          { name: "assidx", offset: 0x36, width: "u16_be" },
          { name: "assq0", offset: 0x38, width: "u8" },
          { name: "assq1", offset: 0x39, width: "u8" },
          { name: "assq2", offset: 0x3a, width: "u8" },
          { name: "assq3", offset: 0x3b, width: "u8" },
          { name: "assq4", offset: 0x3c, width: "u8" },
          { name: "assq5", offset: 0x3d, width: "u8" },
          { name: "assq6", offset: 0x3e, width: "u8" },
          { name: "assq7", offset: 0x3f, width: "u8" },
        ];
        // verbose adds the extended per-entity fields (accumulators/flags/weight)
        // — the ones agents otherwise hand-read; kept off the default block to
        // avoid bloating the common snapshot.
        const EXTRA_FIELDS = ["impact", "impactp", "pos", "nopuck", "pf2", "pf3", "wgt8"];
        if (sections.has("debug")) {
          for (const name of EXTRA_FIELDS) fields.push({ name, offset: nhl94.OFF[name], width: nhl94.FIELD_WIDTH[name] });
        }
        // Slots 0..14 in one contiguous read (12 skaters + 2 unused + puck@14).
        const recs = await bh.call<Record<string, number>[]>(target, "read_struct_array", {
          base: d.addr(nhl94.SORTCORDS), stride: nhl94.SCSIZE, count: 15, fields,
          domain,
        });
        const byIndex = new Map<number, Record<string, number>>(recs.map((r) => [r._index, r]));
        // gmode is a full u16 state word for clock semantics: the clock runs
        // only when the whole word is 0. The low bit still gates interaction.
        const S16G = new Set(["vpos", "hpos", "yleader", "shotplayer", "lastplayer", "passdir", "passspeed"]);
        const gReads: { name: string; address: number; width: string; domain: string }[] =
          (["carrier", "gameclock", "gsp", "gmode", "vpos", "hpos", "yleader",
            "shotplayer", "lastplayer", "passdir", "passspeed"] as const).map((k) => ({
            name: k, address: d.addr(nhl94.G[k]), width: S16G.has(k) ? "s16_be" : "u16_be", domain,
          }));
        gReads.push(
          { name: "faceoff_window_latch", address: d.addr(nhl94.G.faceoff_window_latch), width: "u16_be", domain },
          { name: "home_line", address: d.addr(nhl94.G.home_line), width: "u8", domain },
          { name: "away_line", address: d.addr(nhl94.G.away_line), width: "u8", domain },
        );
        for (const [name, address] of Object.entries(nhl94.CONTROL_G)) {
          const width = name.startsWith("switch_debounce_") ? "u8" : "u16_be";
          gReads.push({ name, address: d.addr(address), width, domain });
        }
        // Session/phase byte (0xFFC735) — read in the same round-trip; drives the
        // `phase:` label below (see nhl94.classifyPhase / SESSION_BYTE comment).
        gReads.push({ name: "session", address: d.addr(nhl94.SESSION_BYTE), width: "u8", domain });
        const gv = await bh.call<Record<string, number>>(target, "read_many", { reads: gReads });
        const frozen = await bh.call<{ frozen?: { address: number; width: string; value: number; domain?: string }[] }>(target, "list_frozen");
        const frozenList = Array.isArray(frozen.frozen) ? frozen.frozen : [];

        // Map frozen addresses onto {target, field}; tally mapped/unmapped.
        const frozenByTarget = new Map<string, Set<string>>();
        let mapped = 0, unmapped = 0;
        for (const f of frozenList) {
          const m = nhl94.mapFrozenAddress(f.address, f.domain ?? domain);
          if (!m) { unmapped++; continue; }
          mapped++;
          if (!frozenByTarget.has(m.target)) frozenByTarget.set(m.target, new Set());
          frozenByTarget.get(m.target)!.add(m.field);
        }
        const mark = (target: string, field: string) => frozenByTarget.get(target)?.has(field) ? "*" : "";
        // Globals (carrier/clock/period/play/camera) map onto target "global"
        // under their G-key field name; mark them frozen with the same "*".
        const markG = (field: string) => frozenByTarget.get("global")?.has(field) ? "*" : "";

        const whole = (rawv: number) => nhl94.fromFixed(rawv >>> 0).whole;
        const hex4 = (v: number) => (v >>> 0).toString(16).toUpperCase().padStart(4, "0");
        const hex2 = (v: number) => (v >>> 0).toString(16).toUpperCase().padStart(2, "0");
        // Absolute (domain-relative) struct base for a slot — the same number an
        // agent needs to read any field this tool doesn't decode (base + OFF.*).
        const slotAddr = (idx: number) => d.addr(nhl94.SORTCORDS + idx * nhl94.SCSIZE);
        const activeHomeRaw = gv.active_control_home ?? 0xffff;
        const activeAwayRaw = gv.active_control_away ?? 0xffff;
        const humanPointerSlots = new Set<number>();
        if (activeHomeRaw >= 0 && activeHomeRaw <= 11) humanPointerSlots.add(activeHomeRaw);
        if (activeAwayRaw >= 0 && activeAwayRaw <= 11) humanPointerSlots.add(activeAwayRaw);
        const targetLines = (label: string, idx: number): string[] => {
          const rec = byIndex.get(idx);
          const at = raw ? ` @0x${slotAddr(idx).toString(16).toUpperCase()}` : "";
          if (!rec) return [`${label}${at}: (no data)`];
          const pos = (["x", "y", "z"] as const)
            .map((ax) => {
              const w = whole(rec[ax]);
              if (!raw) return `${ax}=${w}${mark(label, ax)}`;
              const f = nhl94.fromFixed(rec[ax] >>> 0);
              return `${ax}=${w}${mark(label, ax)}(0x${(rec[ax] >>> 0).toString(16).padStart(8, "0")},frac=${f.frac})`;
            })
            .join(" ");
          const vel = (["xv", "yv", "zv"] as const).map((v) => `${v}=${rec[v]}${mark(label, v)}`).join(" ");
          // Animation (SPA) record — spanum is a byte offset into the per-direction
          // list, so ÷4 is the record index; attr bit 3 is the x-flip flag.
          const anim =
            `anim=0x${hex4(rec.anim)}${mark(label, "anim")} ` +
            `attr=0x${hex4(rec.attr)}${mark(label, "attr")}(xflip=${(rec.attr >> 3) & 1}) ` +
            `spanum=${rec.spanum}${mark(label, "spanum")}(rec ${rec.spanum >> 2}) ` +
            `spacnt=${rec.spacnt}${mark(label, "spacnt")}`;
          const out = [
            `${label}${at}: ${pos} | ${vel} | dir=${rec.fdir}${sections.has("anim") ? ` frame=${rec.frame}` : ""}`,
          ];
          if (sections.has("anim")) {
            out.push(`     ${anim}`);
          }
          if (idx <= 11 && sections.has("control")) {
            const ctx = nhl94.decodeSlotControl(rec);
            const mismatch = humanPointerSlots.has(idx) && !ctx.humanActive ? " control_pointer_mismatch=true" : "";
            const assqRaw = sections.has("debug") ? ` assidx=${ctx.assidx} assq=[${ctx.assq.join(",")}]` : "";
            out.push(`     ${nhl94.formatSlotControlContext(ctx)}${mismatch}${assqRaw}`);
          }
          if (sections.has("debug")) {
            out.push(
              `     impact=${rec.impact}${mark(label, "impact")} impactp=${rec.impactp}${mark(label, "impactp")} ` +
              `pos=${rec.pos}${mark(label, "pos")} nopuck=${rec.nopuck}${mark(label, "nopuck")} ` +
              `pf=0x${hex2(rec.pf)}${mark(label, "pf")} pf2=0x${hex2(rec.pf2)}${mark(label, "pf2")} ` +
              `pf3=0x${hex2(rec.pf3)}${mark(label, "pf3")} wgt8=${rec.wgt8}${mark(label, "wgt8")}`,
            );
          }
          return out;
        };

        const lines: string[] = [];
        for (let i = 0; i <= 11; i++) lines.push(...targetLines(`s${i}`, i));
        lines.push(...targetLines("pk", nhl94.PUCK_SLOT));

        const carrier = gv.carrier >= 0 && gv.carrier <= 11
          ? `s${gv.carrier}`
          : `none (0x${(gv.carrier >>> 0).toString(16).toUpperCase()})`;
        const period = ["1st", "2nd", "3rd", "OT"][gv.gsp] ?? `OT${gv.gsp - 2}`;
        // Full-word gmode == 0 is the verified clock-run condition. Bit0 is a
        // narrower interaction/stoppage gate and can be clear in stopped
        // presentation states such as faceoff/goal/period transitions.
        const gmodeWord = gv.gmode ?? 0;
        const interactionGateClosed = (gmodeWord & 1) === 1;
        const play = gmodeWord === 0 ? "running" : "stopped";
        const faceoff = interactionGateClosed ? "yes" : "no";
        // Coarse phase headline (heuristic: session byte + gmode bit0). Answers
        // the "is this a menu waiting for START, or live/faceoff on the ice?"
        // question that a bare positions read can't — see nhl94.classifyPhase.
        const phaseLabel = nhl94.classifyPhase(gv.session, interactionGateClosed);
        const faceoffLatch = gv.faceoff_window_latch ?? 0;
        const inFaceoffWindow = faceoffLatch !== 0;
        const phase = inFaceoffWindow ? "faceoff_line_change" : phaseLabel;
        const phaseRaw = raw ? `  [session=0x${hex2(gv.session)} gmode=0x${hex4(gmodeWord)}]` : "";
        lines.push("");
        lines.push(`phase: ${phase}${phaseRaw}`);
        if (inFaceoffWindow) {
          const homeRaw = gv.home_line ?? -1;
          const awayRaw = gv.away_line ?? -1;
          const puckLoose = (gv.carrier & 0xff00) === 0xff00;
          lines.push(`phase_label: faceoff / line-change (pre-drop)`);
          lines.push(
            `faceoff_window: active=true latch=0x${hex4(faceoffLatch)}(${faceoffLatch}) ` +
            `home=${nhl94.lineLabel(homeRaw)}(${homeRaw}) away=${nhl94.lineLabel(awayRaw)}(${awayRaw})`,
          );
          lines.push(
            `evidence: latch_nonzero=true interaction_gate_closed=${interactionGateClosed ? "true" : "false"} ` +
            `puck_loose=${puckLoose ? "true" : "false"}`,
          );
        }
        lines.push(interactionGateClosed
          ? `interaction_gate: CLOSED (gmode.bit0=1; collision/check dispatch is blocked during whistle/faceoff mode)`
          : `interaction_gate: OPEN (gmode.bit0=0; stoppage gate is clear — necessary, not proof that contact/resolver dispatch occurred)`);
        lines.push(`carrier: ${carrier}${markG("carrier")}   clock: ${nhl94.formatClock(gv.gameclock)} (${gv.gameclock}s)${markG("gameclock")}   period: ${period}${markG("gsp")}   play: ${play}${markG("gmode")}   faceoff: ${faceoff}`);
        // Carrier ratings (OSD parity): shotpwr/shotacc/passacc/energy of the
        // slot carrying the puck; dashes when the puck is loose.
        const crec = (gv.carrier >= 0 && gv.carrier <= 11) ? byIndex.get(gv.carrier) : undefined;
        const ratings = crec
          ? `shotpwr=${crec.shotpwr} shotacc=${crec.shotacc} passacc=${crec.passacc} energy=${crec.energy}`
          : "— (loose puck)";
        if (sections.has("ratings")) {
          lines.push(`carrier_ratings: ${ratings}`);
        }
        if (sections.has("camera")) {
          lines.push(`camera: vpos=${gv.vpos}${markG("vpos")} hpos=${gv.hpos}${markG("hpos")} yleader=${gv.yleader}${markG("yleader")}`);
        }
        // Play-context globals (OSD footer parity). shot/last are slot indices
        // (sN, or none when < 0 / out of range); pass is the last pass vector.
        const slotName = (v: number) => (v >= 0 && v <= 11 ? `s${v}` : `none (${v})`);
        if (sections.has("context")) {
          lines.push(`shot: ${slotName(gv.shotplayer)}${markG("shotplayer")}   last: ${slotName(gv.lastplayer)}${markG("lastplayer")}   pass: dir=${gv.passdir}${markG("passdir")} speed=${gv.passspeed}${markG("passspeed")}`);
        }
        const homeControl = nhl94.controlSlotInfo(activeHomeRaw, "home");
        const awayControl = nhl94.controlSlotInfo(activeAwayRaw, "away");
        const controlMode = nhl94.inferControlMode(activeHomeRaw, activeAwayRaw);
        const coopNote = controlMode === "1P-CPU" || controlMode === "CPU-1P" ? "; coop_unverified=true" : "";
        const unexpected = (info: nhl94.ControlSlotInfo) => info.slotTeamUnexpected ? " slot_team_unexpected=true" : "";
        lines.push(`control_mode: ${controlMode}${coopNote}`);
        if (sections.has("control")) {
          lines.push("control:");
          lines.push(
            `  home(team0): ${homeControl.role} active=${homeControl.active}${unexpected(homeControl)} ` +
            `switch_debounce=${nhl94.formatSwitchDebounce(gv.switch_debounce_home ?? 0)} ` +
            `line=${nhl94.lineLabel(gv.home_line ?? -1)} raw_active=${homeControl.raw}`,
          );
          lines.push(
            `  away(team1): ${awayControl.role} active=${awayControl.active}${unexpected(awayControl)} ` +
            `switch_debounce=${nhl94.formatSwitchDebounce(gv.switch_debounce_away ?? 0)} ` +
            `line=${nhl94.lineLabel(gv.away_line ?? -1)} raw_active=${awayControl.raw}`,
          );
          lines.push(`  mode: ${controlMode} inferred from active control slots${coopNote}`);
          lines.push(`  input_route: ${nhl94.formatInputRoute(controlMode, homeControl.active, awayControl.active)}`);
          lines.push(
            `  pad_words: word0@0xFFBEEE=${nhl94.formatPadWord(gv.pad_word_0 ?? 0)} ` +
            `word1@0xFFBEF0=${nhl94.formatPadWord(gv.pad_word_1 ?? 0)} ` +
            `word2@0xFFBEF2=${nhl94.formatPadWord(gv.pad_word_2 ?? 0)} ` +
            `word3@0xFFBEF4=${nhl94.formatPadWord(gv.pad_word_3 ?? 0)}`,
          );
          lines.push(
            `  caveat: c1playernum=${nhl94.hexWord(gv.c1playernum ?? 0)} ` +
            `c2playernum=${nhl94.hexWord(gv.c2playernum ?? 0)} are reported raw only; ` +
            `they are not active skater indices and are not used for mode/input_route inference`,
          );
        }
        if (sections.has("freezes") || frozenList.length > 0) {
          lines.push(`(\`*\` marks a value currently frozen by the bridge.)`);
        }
        const baseHex = d.addr(nhl94.SORTCORDS).toString(16).toUpperCase();
        if (sections.has("debug")) {
          lines.push(
            `layout: slot structs @ base=0x${baseHex} stride=0x${nhl94.SCSIZE.toString(16).toUpperCase()} domain='${domain}' ` +
            `(reference only; do not hand-compute reads). Use nhl94_read with a named field or raw +0xNN:width offset. ` +
            `offsets: x+00 y+14 z+18(all s32_be 16.16) xv+28 yv+2A zv+2C(s16_be) frame+06 fdir+54 attr+04 anim+58 spanum+5A(u16_be) spacnt+5C(s16_be).`,
          );
        }
        lines.push(`frozen_summary: total=${frozenList.length} mapped=${mapped} unmapped=${unmapped}`);
        const stateText = lines.join("\n");

        // Screenshot + vision description — ON BY DEFAULT (opt out with
        // describe:false). Best-effort: if vision is unconfigured or errors, the
        // structured data is still returned with a short note rather than
        // failing the whole read.
        if (p.describe !== false) {
          const cfg = visionConfig();
          if (!cfg) {
            return ok(`${stateText}\n\n=== Vision unavailable ===\n(describe is on by default but VISION_BASE_URL/VISION_MODEL are not set; pass describe:false to silence)`);
          }
          const backend = bh.getBackend(target);
          const { local: readPath, remote: sendPath } = shotPaths(`mcp-bizhawk-nhl-${process.pid}-${Date.now()}.png`, backend);
          try {
            await bh.call<string>(target, "screenshot", { path: sendPath });
            const desc = await describeImage(readPath, p.describe_prompt as string | undefined, cfg);
            return ok(`${stateText}\n\n=== Screenshot described by ${cfg.model} ===\n${desc}`);
          } catch (err) {
            return ok(`${stateText}\n\n=== Vision unavailable ===\n(${publicVisionError(err)})`);
          }
        }

        return ok(stateText);
      }

      case "nhl94_rules": {
        const target = p.target as string;
        const backend = bh.getBackend(target);
        const d = await backend.nhlDomain();
        const domain = await d.detect({});
        const reads = [
          { name: "game_mode_flags", address: d.addr(0xffc2fa), width: "u8", domain },
          { name: "opt_pen", address: d.addr(0xffd056), width: "u16_be", domain },
          { name: "gmode", address: d.addr(nhl94.G.gmode), width: "u16_be", domain },
          { name: "active_control_home", address: d.addr(nhl94.CONTROL_G.active_control_home), width: "u16_be", domain },
          { name: "active_control_away", address: d.addr(nhl94.CONTROL_G.active_control_away), width: "u16_be", domain },
          { name: "pad_word_0", address: d.addr(nhl94.CONTROL_G.pad_word_0), width: "u16_be", domain },
          { name: "pad_word_2", address: d.addr(nhl94.CONTROL_G.pad_word_2), width: "u16_be", domain },
        ];
        const gv = await bh.call<Record<string, number>>(target, "read_many", { reads });
        const offsideOn = ((gv.gmode ?? 0) & 0x2000) !== 0;
        const lines = [
          `game_mode: ${rulesGameMode(gv.game_mode_flags ?? 0)}`,
          `players: ${rulesPlayers(gv.active_control_home ?? 0xffff, gv.active_control_away ?? 0xffff, gv.pad_word_0 ?? 0, gv.pad_word_2 ?? 0)}`,
          `penalties: ${rulesPenalty(gv.opt_pen ?? -1)}`,
          `offside: ${offsideOn ? "ON" : "OFF"}`,
          `raw: game_mode_flags=0x${((gv.game_mode_flags ?? 0) & 0xff).toString(16).toUpperCase().padStart(2, "0")} ` +
            `opt_pen=${nhl94.hexWord(gv.opt_pen ?? 0)} gmode=${nhl94.hexWord(gv.gmode ?? 0)} ` +
            `active_home=${nhl94.hexWord(gv.active_control_home ?? 0xffff)} active_away=${nhl94.hexWord(gv.active_control_away ?? 0xffff)} ` +
            `pad0=${nhl94.hexWord(gv.pad_word_0 ?? 0)} pad2=${nhl94.hexWord(gv.pad_word_2 ?? 0)}`,
        ];
        return ok(lines.join("\n"));
      }

      case "nhl94_read": {
        const target = p.target as string;
        const backend = bh.getBackend(target);
        const d = await backend.nhlDomain();
        const domain = await d.detect({});
        const targets = (p.targets as string[] | undefined)
          ?? Array.from({ length: 12 }, (_, i) => `s${i}`).concat("pk");
        const fieldToks = (p.fields as string[] | undefined) ?? nhl94.READ_DEFAULT_FIELDS;
        const fields = fieldToks.map((t) => nhl94.resolveField(t)); // validates fields
        const bases = targets.map((t) => ({ t, base: nhl94.resolveTarget(t).base })); // validates targets
        const reads = bases.flatMap(({ t, base }) =>
          fields.map((f) => ({ name: `${t}.${f.field}`, address: d.addr(base + f.offset), width: f.width, domain })),
        );
        if (reads.length > 128) {
          throw new Error(`nhl94_read would issue ${reads.length} reads (>128); reduce targets or fields`);
        }
        const vals = await bh.call<Record<string, number>>(target, "read_many", { reads });
        const lines = bases.map(({ t }) => {
          const parts = fields.map((f) => {
            const v = vals[`${t}.${f.field}`] ?? 0;
            const shown = f.fixed ? nhl94.fromFixed(v >>> 0).whole : v;
            return `${f.field}=${shown}`;
          });
          return `${t}: ${parts.join(" ")}`;
        });
        return ok(lines.join("\n"));
      }

      case "nhl94_fields": {
        const target = p.target as string;
        const backend = bh.getBackend(target);
        const d = await backend.nhlDomain();
        const domain = await d.detect({});
        const opsIn = p.ops as Record<string, unknown>[] | undefined;
        if (!Array.isArray(opsIn) || opsIn.length === 0) throw new Error("nhl94_fields requires a non-empty ops array");
        const refs = opsIn.map((op) => ({ input: op, ref: resolveNhlFieldOp(op) }));
        const memOps: nhl94.MemOp[] = [];
        const readReqs: { name: string; address: number; width: string; domain: string }[] = [];
        const readbackRefs: NhlFieldRef[] = [];
        const currentFreezeReads = refs
          .filter(({ input }) => input.op === "freeze" && input.value === undefined)
          .map(({ ref }) => ({ name: ref.label, address: d.addr(ref.address), width: ref.width, domain }));
        const currentFreezeVals = currentFreezeReads.length
          ? await bh.call<Record<string, number>>(target, "read_many", { reads: currentFreezeReads })
          : {};

        for (const { input, ref } of refs) {
          const op = input.op;
          if (op === "read") {
            readReqs.push({ name: ref.label, address: d.addr(ref.address), width: ref.width, domain });
          } else if (op === "write") {
            const value = encodeNhlValue(ref, input.value);
            memOps.push({ op: input.freeze === true ? "freeze" : "write", address: ref.address, value, width: memoryOpsWriteWidth(ref.width) });
            if (p.readback !== "none") readbackRefs.push(ref);
          } else if (op === "freeze") {
            const value = input.value === undefined
              ? (currentFreezeVals[ref.label] ?? 0)
              : encodeNhlValue(ref, input.value);
            memOps.push({ op: "freeze", address: ref.address, value, width: memoryOpsWriteWidth(ref.width) });
            if (p.readback !== "none") readbackRefs.push(ref);
          } else if (op === "unfreeze") {
            memOps.push({ op: "unfreeze", address: ref.address, width: ref.width });
          } else {
            throw new Error(`unknown nhl94_fields op "${String(op)}"`);
          }
        }

        const lines: string[] = [];
        let readVals: Record<string, number> = {};
        if (readReqs.length) {
          readVals = await bh.call<Record<string, number>>(target, "read_many", { reads: readReqs });
          for (const { input, ref } of refs) {
            if (input.op !== "read") continue;
            lines.push(`${ref.label}=${decodeNhlValue(ref, readVals[ref.label] ?? 0)}`);
          }
        }

        if (memOps.length) {
          await bh.call(target, "memory_ops", { ops: d.rebase(memOps), domain });
        }

        if (readbackRefs.length) {
          const rbReads = readbackRefs.map((ref) => ({ name: ref.label, address: d.addr(ref.address), width: ref.width, domain }));
          const rbVals = await bh.call<Record<string, number>>(target, "read_many", { reads: rbReads });
          let rbIndex = 0;
          for (const { input, ref } of refs) {
            if (input.op !== "write" && input.op !== "freeze") continue;
            const raw = rbVals[ref.label] ?? 0;
            const verb = input.op === "freeze" || input.freeze === true ? "froze" : "wrote";
            lines.push(`${verb} ${ref.label}=${decodeNhlValue(ref, raw)} (readback ${decodeNhlValue(ref, raw)})`);
            rbIndex++;
          }
        } else {
          for (const { input, ref } of refs) {
            if (input.op === "unfreeze") lines.push(`unfroze ${ref.label}`);
            else if (input.op === "write") lines.push(`${input.freeze === true ? "froze" : "wrote"} ${ref.label}`);
            else if (input.op === "freeze") lines.push(`froze ${ref.label}`);
          }
        }

        return ok(lines.join("\n"));
      }

      case "nhl94_stage": {
        const target = p.target as string;
        const backend = bh.getBackend(target);
        const place = (p.place as Record<string, unknown>[] | undefined) ?? [];
        const possession = typeof p.possession === "string" ? p.possession : undefined;
        if (possession && possession !== "none" && place.some((e) => e.target === "pk")) {
          throw new Error("nhl94_stage cannot combine pk placement with skater possession; possession snaps pk to the carrier");
        }

        const lines: string[] = [];
        let domainStr: string | undefined;
        let domainObj: Awaited<ReturnType<typeof backend.nhlDomain>> | undefined;
        const getDomain = async () => {
          if (domainStr !== undefined) return domainStr;
          domainObj = await backend.nhlDomain();
          domainStr = await domainObj.detect({});
          return domainStr;
        };

        if (p.clear_freezes === true) {
          const r = await bh.call<{ frozen_count: number }>(target, "unfreeze", { all: true });
          lines.push(`Cleared freezes before staging (${r.frozen_count} remaining).`);
        }

        if (typeof p.rig === "string") {
          const hash = await currentRomHash(target, bh);
          const name = rigName(p.rig);
          const jsonPath = rigJsonPath(hash, name, backend);
          if (!fs.existsSync(jsonPath)) {
            throw new Error(`no rig "${name}" for the running ROM. ${availableRigs(hash, backend)}`);
          }
          const rig = JSON.parse(fs.readFileSync(jsonPath, "utf8")) as Rig;
          if (rig.rom_md5 !== hash) {
            throw new Error(`rig "${name}" is for ROM ${rig.rom_md5}, but ${hash} is running — not applied`);
          }
          await bh.call(target, "unfreeze", { all: true });
          await bh.call<{ path: string }>(target, "load_state", { path: rigBridgeStatePath(hash, name, backend), pause: true });
          let frozenCount = 0;
          if (rig.freezes.length) {
            const ops = rig.freezes.map(rigFreezeOp);
            const r = await bh.call<{ frozen_count: number }>(target, "memory_ops", { ops });
            frozenCount = r.frozen_count;
          }
          lines.push(`Applied rig "${name}": loaded named state (paused), re-applied ${rig.freezes.length} freeze(s). ${frozenCount} address(es) frozen.`);
        }

        if (p.park && typeof p.park === "object") {
          const keep = (((p.park as Record<string, unknown>).keep as string[] | undefined) ?? []);
          for (const k of keep) {
            if (!/^s\d{1,2}$/.test(k)) throw new Error("nhl94_stage park.keep accepts skaters s0-s11 only");
            nhl94.resolveTarget(k);
          }
          const d = await getDomain();
          const { ops, assignments } = nhl94.parkOps(keep);
          const r = await bh.call<{ frozen_count: number }>(target, "memory_ops", { ops: domainObj!.rebase(ops), domain: d });
          lines.push(`Parked ${assignments.length} skater(s); ${r.frozen_count} address(es) frozen.`);
        }

        if (place.length) {
          const d = await getDomain();
          const num = (v: unknown) => typeof v === "number" ? v : undefined;
          const hasTeleportAxis = (e: Record<string, unknown>) =>
            ["x", "y", "z", "xv", "yv", "zv"].some((k) => typeof e[k] === "number");
          const teleportSources = place.filter(hasTeleportAxis);
          const teleportEntries: nhl94.TeleportEntry[] = teleportSources.map((e) => ({
            target: String(e.target),
            x: num(e.x), y: num(e.y), z: num(e.z),
            xv: num(e.xv), yv: num(e.yv), zv: num(e.zv),
          }));
          const ops = teleportEntries.length
            ? nhl94.teleportOps(teleportEntries, teleportSources.some((e) => e.target === "pk"))
            : [];
          const fdirOps: nhl94.MemOp[] = [];
          for (const e of place) {
            if (e.fdir === undefined) continue;
            const { base } = nhl94.resolveTarget(String(e.target));
            fdirOps.push({ op: "write", address: base + nhl94.OFF.fdir, value: nhl94.fdirValue(e.fdir) & 0xffff, width: "u16_be" });
          }
          const r = await bh.call<{ applied: number; frozen_count: number }>(target, "memory_ops", { ops: domainObj!.rebase([...ops, ...fdirOps]), domain: d });
          lines.push(`Placed ${place.length} target(s) (${r.applied ?? [...ops, ...fdirOps].length} op(s)).`);
        }

        if (possession) {
          const d = await getDomain();
          const carrierAddr = domainObj!.addr(nhl94.G.carrier);
          if (possession === "none") {
            await bh.call(target, "memory_ops", { ops: [{ op: "write", address: carrierAddr, value: 0xffff, width: "u16_be" }], domain: d });
            lines.push("Set possession: none.");
          } else {
            const { slot, base } = nhl94.resolveTarget(possession);
            if (slot < 0 || slot > 11) throw new Error("possession must be s0-s11 or none");
            const pos = await bh.call<Record<string, number>>(target, "read_many", { reads: [
              { name: "x", address: domainObj!.addr(base + nhl94.OFF.x), width: "s32_be", domain: d },
              { name: "y", address: domainObj!.addr(base + nhl94.OFF.y), width: "s32_be", domain: d },
            ] });
            const pkBase = nhl94.PUCK_BASE;
            await bh.call(target, "memory_ops", { ops: [
              { op: "write", address: carrierAddr, value: slot, width: "u16_be" },
              { op: "write", address: domainObj!.addr(pkBase + nhl94.OFF.x), value: pos.x >>> 0, width: "u32_be" },
              { op: "write", address: domainObj!.addr(pkBase + nhl94.OFF.y), value: pos.y >>> 0, width: "u32_be" },
            ], domain: d });
            lines.push(`Set possession: ${possession}.`);
          }
        }

        const stageFields = (p.fields as Record<string, unknown>[] | undefined) ?? [];
        if (stageFields.length) {
          const d = await getDomain();
          const memOps: nhl94.MemOp[] = stageFields.map((raw) => {
            const input: Record<string, unknown> = { op: "write", ...raw };
            const ref = resolveNhlFieldOp(input);
            return { op: input.freeze === true ? "freeze" : "write", address: ref.address, value: encodeNhlValue(ref, input.value), width: memoryOpsWriteWidth(ref.width) };
          });
          await bh.call(target, "memory_ops", { ops: domainObj!.rebase(memOps), domain: d });
          lines.push(`Wrote ${stageFields.length} field(s).`);
        }

        const settleFrames = typeof p.settle_frames === "number" ? p.settle_frames : 0;
        if (settleFrames > 0) {
          await bh.call(target, "frame_advance", { count: settleFrames }, { timeoutMs: frameTimeout(settleFrames) });
          lines.push(`Settled ${settleFrames} frame(s).`);
        }

        return ok(lines.length ? lines.join("\n") : "No staging operations requested.");
      }

      case "nhl94_park": {
        const target = p.target as string;
        const backend = bh.getBackend(target);
        const keep = (p.keep as string[] | undefined) ?? [];
        for (const k of keep) nhl94.resolveTarget(k); // validate keep entries
        const d = await backend.nhlDomain();
        const domain = await d.detect({});
        const { ops, assignments } = nhl94.parkOps(keep); // validates
        const r = await bh.call<{ frozen_count: number }>(target, "memory_ops", { ops: d.rebase(ops), domain });
        const xs = assignments.map((a) => a.x);
        const head = `Parked ${assignments.length} skater(s) at y=${nhl94.PARK_Y} (x ${Math.min(...xs)}..${Math.max(...xs)})` +
          (keep.length ? `; kept ${keep.join(", ")}` : "");
        const detail = assignments.map((a) => `${a.target} x=${a.x}`).join(", ");
        const settleFrames = typeof p.settle_frames === "number" ? p.settle_frames : 0;
        const settled = await nhlSettle(target, bh, settleFrames);
        return ok(`${head}\n${detail}\n${r.frozen_count} address(es) frozen.${settled ? ` (+${settleFrames} frames so the move renders)` : ""}`);
      }

      case "nhl94_rig": {
        const target = p.target as string;
        const backend = bh.getBackend(target);
        const action = p.action as string;
        const hash = await currentRomHash(target, bh);

        if (action === "list") {
          const root = rigRoot(backend);
          const rows: string[] = [];
          if (fs.existsSync(root)) {
            for (const hd of fs.readdirSync(root)) {
              const dir = path.join(root, hd);
              if (!fs.statSync(dir).isDirectory()) continue;
              for (const fn of fs.readdirSync(dir)) {
                if (!fn.endsWith(".json")) continue;
                try {
                  const rig = JSON.parse(fs.readFileSync(path.join(dir, fn), "utf8")) as Rig;
                  const flag = rig.rom_md5 === hash ? "" : " [other ROM]";
                  rows.push(`${rig.name} — ${rig.freeze_count} freeze(s), ${rig.created_at}${flag}`);
                } catch { /* skip unreadable */ }
              }
            }
          }
          return ok(rows.length ? rows.join("\n") : "(no rigs saved)");
        }

        const name = rigName(p.name);
        const jsonPath = rigJsonPath(hash, name, backend);

        if (action === "save") {
          fs.mkdirSync(path.dirname(jsonPath), { recursive: true });
          const savestatePath = rigStatePath(hash, name, backend);
          const bridgeSavestatePath = rigBridgeStatePath(hash, name, backend);
          await bh.call(target, "save_state", { path: bridgeSavestatePath });
          const fl = await bh.call<{ frozen?: RigFreeze[] }>(target, "list_frozen");
          const freezes = Array.isArray(fl.frozen) ? fl.frozen : [];
          const rig: Rig = {
            name, rom_md5: hash, created_at: new Date().toISOString(),
            savestate_path: savestatePath,
            ...(bridgeSavestatePath !== savestatePath ? { bridge_savestate_path: bridgeSavestatePath } : {}),
            freezes, freeze_count: freezes.length,
            ...(typeof p.note === "string" ? { note: p.note } : {}),
          };
          fs.writeFileSync(jsonPath, JSON.stringify(rig, null, 2));
          return ok(`Saved rig "${name}" (${freezes.length} freeze(s)) for ROM ${hash}.`);
        }

        if (action === "apply") {
          if (!fs.existsSync(jsonPath)) {
            throw new Error(`no rig "${name}" for the running ROM. ${availableRigs(hash, backend)}`);
          }
          const rig = JSON.parse(fs.readFileSync(jsonPath, "utf8")) as Rig;
          if (rig.rom_md5 !== hash) {
            throw new Error(`rig "${name}" is for ROM ${rig.rom_md5}, but ${hash} is running — not applied`);
          }
          await bh.call(target, "unfreeze", { all: true });
          await bh.call<{ path: string }>(target, "load_state", { path: rigBridgeStatePath(hash, name, backend), pause: true });
          let frozenCount = 0;
          if (rig.freezes.length) {
            const ops = rig.freezes.map(rigFreezeOp);
            const r = await bh.call<{ frozen_count: number }>(target, "memory_ops", { ops });
            frozenCount = r.frozen_count;
          }
          return ok(`Applied rig "${name}": loaded named state (paused), re-applied ${rig.freezes.length} freeze(s). ${frozenCount} address(es) frozen.`);
        }

        // delete
        if (!fs.existsSync(jsonPath)) {
          throw new Error(`no rig "${name}" for the running ROM. ${availableRigs(hash, backend)}`);
        }
        const rig = JSON.parse(fs.readFileSync(jsonPath, "utf8")) as Rig;
        fs.rmSync(jsonPath, { force: true });
        if (rig.savestate_path) fs.rmSync(rig.savestate_path, { force: true });
        return ok(`Deleted rig "${name}".`);
      }

      case "nhl94_possession": {
        const target = p.target as string;
        const backend = bh.getBackend(target);
        const entity = p.entity as string;
        const hold = p.hold === true;
        const d = await backend.nhlDomain();
        const domain = await d.detect({});
        const carrierAddr = d.addr(nhl94.G.carrier);
        // Every call releases any prior hold first, then applies the new state.
        const ops: nhl94.MemOp[] = [{ op: "unfreeze", address: carrierAddr, width: "u16_be" }];
        let summary: string;
        if (entity === "none") {
          if (hold) ops.push({ op: "freeze", address: carrierAddr, value: 0xffff, width: "u16_be" });
          else ops.push({ op: "write", address: carrierAddr, value: 0xffff, width: "u16_be" });
          summary = `Puck set loose (nobody carrying); carrier hold: ${hold ? "on" : "off"}`;
        } else {
          const { slot, base } = nhl94.resolveTarget(entity); // validates sN
          if (entity === "pk" || slot > 11) throw new Error("possession target must be 's0'..'s11' or 'none'");
          const pos = await bh.call<Record<string, number>>(target, "read_many", {
            reads: [
              { name: "x", address: d.addr(base + nhl94.OFF.x), width: "s32_be", domain },
              { name: "y", address: d.addr(base + nhl94.OFF.y), width: "s32_be", domain },
            ],
          });
          const pkBase = nhl94.PUCK_BASE;
          // Assign the carrier word directly: proximity pickup alone doesn't
          // transfer when another skater already carries (its carry logic yanks
          // the puck back every frame). hold freezes it; otherwise a one-shot
          // write, which sticks because the puck is placed on this skater in the
          // same batch, so the game re-derives the same carrier next frame.
          if (hold) ops.push({ op: "freeze", address: carrierAddr, value: slot, width: "u16_be" });
          else ops.push({ op: "write", address: carrierAddr, value: slot, width: "u16_be" });
          ops.push({ op: "write", address: d.addr(pkBase + nhl94.OFF.x), value: pos.x >>> 0, width: "u32_be" });
          ops.push({ op: "write", address: d.addr(pkBase + nhl94.OFF.y), value: pos.y >>> 0, width: "u32_be" });
          const w = (raw: number) => nhl94.fromFixed(raw >>> 0).whole;
          summary = `Puck given to ${entity} (teleported to x=${w(pos.x)},y=${w(pos.y)}); carrier hold: ${hold ? "on" : "off"}`;
        }
        await bh.call(target, "memory_ops", { ops, domain });
        const settleFrames = typeof p.settle_frames === "number" ? p.settle_frames : 0;
        const settled = await nhlSettle(target, bh, settleFrames);
        return ok(`${summary}${settled ? ` (+${settleFrames} frames so the move renders)` : ""}`);
      }

      case "nhl94_clock": {
        const target = p.target as string;
        const backend = bh.getBackend(target);
        const hasSet = p.set !== undefined;
        const freeze = p.freeze === true;
        const release = p.release === true;
        if (freeze && release) throw new Error("freeze and release are mutually exclusive");
        if (!hasSet && !freeze && !release) throw new Error("pass at least one of set, freeze, release");
        const d = await backend.nhlDomain();
        const domain = await d.detect({});
        const clockAddr = d.addr(nhl94.G.gameclock);
        const ops: nhl94.MemOp[] = [];
        let seconds: number | undefined;
        if (hasSet) seconds = nhl94.parseClock(p.set as string | number);

        if (release) {
          ops.push({ op: "unfreeze", address: clockAddr, width: "u16_be" });
        } else if (freeze) {
          if (seconds === undefined) {
            seconds = await bh.call<number>(target, "read16", { address: clockAddr, byteorder: "be", domain });
          }
          ops.push({ op: "freeze", address: clockAddr, value: seconds, width: "u16_be" });
        } else {
          ops.push({ op: "write", address: clockAddr, value: seconds as number, width: "u16_be" });
        }
        await bh.call(target, "memory_ops", { ops, domain });
        const state = release ? "released" : freeze ? "frozen" : "set";
        const shown = seconds !== undefined ? ` to ${nhl94.formatClock(seconds)}` : "";
        return ok(`Clock ${state}${shown}.`);
      }

      case "nhl94_camera": {
        const target = p.target as string;
        const backend = bh.getBackend(target);
        const pin = p.pin as { v?: number; h?: number } | undefined;
        const release = p.release === true;
        if ((pin && release) || (!pin && !release)) {
          throw new Error("pass exactly one of pin or release");
        }
        const d = await backend.nhlDomain();
        const domain = await d.detect({});
        const vAddr = d.addr(nhl94.G.vpos);
        const hAddr = d.addr(nhl94.G.hpos);
        const ops: nhl94.MemOp[] = [];
        if (release) {
          ops.push({ op: "unfreeze", address: vAddr, width: "u16_be" });
          ops.push({ op: "unfreeze", address: hAddr, width: "u16_be" });
          await bh.call(target, "memory_ops", { ops, domain });
          return ok("Camera released.");
        }
        if (pin!.v === undefined && pin!.h === undefined) {
          throw new Error("pin needs at least one of v, h");
        }
        const parts: string[] = [];
        if (pin!.v !== undefined) { ops.push({ op: "freeze", address: vAddr, value: nhl94.toWord(pin!.v), width: "u16_be" }); parts.push(`v=${pin!.v}`); }
        if (pin!.h !== undefined) { ops.push({ op: "freeze", address: hAddr, value: nhl94.toWord(pin!.h), width: "u16_be" }); parts.push(`h=${pin!.h}`); }
        await bh.call(target, "memory_ops", { ops, domain });
        return ok(`Camera pinned @ ${parts.join(" ")}`);
      }

      case "bizhawk_eval_lua": {
        const target = p.target as string;
        const opts = p.timeout_ms !== undefined ? { timeoutMs: p.timeout_ms as number } : {};
        const params: Record<string, unknown> = { code: p.code };
        if (p.unpause !== undefined) params.unpause = p.unpause;
        const r = await bh.call<unknown>(target, "eval_lua", params, opts);
        return ok(r === undefined || r === null ? "(nil)" : JSON.stringify(r, null, 2));
      }

      case "bizhawk_search_begin": {
        const target = p.target as string;
        const params: Record<string, unknown> = { ...dom() };
        if (p.start  !== undefined) params.start  = p.start;
        if (p.length !== undefined) params.length = p.length;
        if (p.width  !== undefined) params.width  = p.width;
        const r = await bh.call<{
          start: number; length: number; width: string; potential_candidates: number;
        }>(target, "search_begin", params);
        return ok(
          `Search started: ${r.length} bytes @ ${addrHex(r.start)} (${r.width}${p.domain ? `, ${p.domain}` : ""}) — ` +
          `${r.potential_candidates} potential candidates.`,
        );
      }
      case "bizhawk_search_filter": {
        const target = p.target as string;
        const params: Record<string, unknown> = { condition: p.condition };
        if (p.value !== undefined) params.value = p.value;
        const r = await bh.call<{
          count: number; sample?: { address: number; value: number }[];
        }>(target, "search_filter", params);
        const sample = Array.isArray(r.sample) ? r.sample : [];
        const lines = [`${r.count} candidate(s) remain.`];
        for (const s of sample) lines.push(`  ${addrHex(s.address)} = ${s.value}`);
        if (r.count > sample.length && sample.length > 0) {
          lines.push(`  ... (${r.count - sample.length} more — use bizhawk_search_results)`);
        }
        return ok(lines.join("\n"));
      }
      case "bizhawk_search_results": {
        const target = p.target as string;
        const params: Record<string, unknown> = {};
        if (p.limit !== undefined) params.limit = p.limit;
        const r = await bh.call<{
          count: number; results?: { address: number; value: number }[];
        }>(target, "search_results", params);
        const results = Array.isArray(r.results) ? r.results : [];
        const lines = [`${r.count} candidate(s):`];
        for (const s of results) lines.push(`  ${addrHex(s.address)} = ${s.value}`);
        return ok(lines.join("\n"));
      }
      case "bizhawk_search_end": {
        const target = p.target as string;
        await bh.call(target, "search_end");
        return ok("Search ended.");
      }
      case "bizhawk_get_registers": {
        const target = p.target as string;
        const r = await bh.call<Record<string, number>>(target, "get_registers");
        const lines = Object.keys(r).sort().map((k) => `${k} = ${fmtHex(r[k])}`);
        return ok(lines.join("\n"));
      }
      case "bizhawk_set_register": {
        const target = p.target as string;
        await bh.call(target, "set_register", { name: p.name, value: p.value });
        return ok(`Set register ${p.name} = ${p.value}`);
      }

      case "bizhawk_disassemble": {
        const target = p.target as string;
        const params: Record<string, unknown> = {};
        if (p.address !== undefined) params.address = p.address;
        if (p.count !== undefined) params.count = p.count;
        if (p.domain !== undefined) params.domain = p.domain;
        const r = await bh.call<{ instructions: { address: number; disasm: string; length: number }[] }>(target, 
          "disassemble",
          params,
        );
        const lines = r.instructions.map(
          (i) => `0x${i.address.toString(16).toUpperCase()}: ${i.disasm}  (${i.length} bytes)`,
        );
        return ok(lines.join("\n"));
      }

      case "bizhawk_trap_memory": {
        const target = p.target as string;
        const timeoutFrames = (p.timeout_frames as number) ?? 600;
        const kind = (p.kind as string) ?? "write";
        const params: Record<string, unknown> = { address: a(), kind };
        if (p.timeout_frames !== undefined) params.timeout_frames = p.timeout_frames;
        if (p.turbo          !== undefined) params.turbo          = p.turbo;
        const r = await bh.call<{
          hit?: { address: number; value?: number; registers?: Record<string, number>; framecount?: number };
          frames_waited: number;
          final_framecount?: number;
        }>(target, "trap_memory", params, { timeoutMs: frameTimeout(timeoutFrames) });
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
        const target = p.target as string;
        const maxFrames = (p.max_frames as number) ?? 600;
        const params: Record<string, unknown> = {};
        if (p.max_frames            !== undefined) params.max_frames            = p.max_frames;
        if (p.player                !== undefined) params.player                = p.player;
        if (p.stop_on_memory_change !== undefined) params.stop_on_memory_change = p.stop_on_memory_change;
        const r = await bh.call<{
          recorded: number;
          stopped_early?: boolean;
          frames?: { buttons: Record<string, boolean>; hold: number }[];
        }>(target, "record_input", params, { timeoutMs: frameTimeout(maxFrames) });
        const frames = Array.isArray(r.frames) ? r.frames : [];
        const header =
          `Recorded ${r.recorded} frame(s) in ${frames.length} ${frames.length === 1 ? "entry" : "entries"}` +
          `${r.stopped_early ? ", stopped early (memory changed)" : ""}.`;
        return ok(`${header}\n${JSON.stringify(frames)}`);
      }

      case "bizhawk_get_input": {
        const target = p.target as string;
        const params: Record<string, unknown> = {};
        if (p.player !== undefined) params.player = p.player;
        const r = await bh.call<{
          player: number;
          buttons?: Record<string, boolean>;
          axes?: Record<string, number>;
        }>(target, "get_input", params);
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
        const target = p.target as string;
        const params: Record<string, unknown> = {};
        if (p.path !== undefined) rejectPathArg(name, "path");
        const r = await bh.call<{ loaded: boolean; mode?: string; filename?: string; length?: number }>(target, 
          "movie_play", params, { timeoutMs: 30000 });
        return ok(fmtMovieStatus(r));
      }
      case "bizhawk_movie_stop": {
        const target = p.target as string;
        await bh.call(target, "movie_stop");
        return ok("Movie stopped.");
      }
      case "bizhawk_movie_status": {
        const target = p.target as string;
        const r = await bh.call<{ loaded: boolean; mode?: string; filename?: string; length?: number }>(target, "movie_status");
        return ok(fmtMovieStatus(r));
      }

      case "bizhawk_save_slot": {
        const target = p.target as string;
        const slot = await namedStatePaths(target, bh, p.name);
        fs.mkdirSync(path.dirname(slot.local), { recursive: true });
        await bh.call(target, "save_state", { path: slot.bridge });
        return ok(`Saved slot '${slot.name}'`);
      }
      case "bizhawk_load_slot": {
        const target = p.target as string;
        const slot = await existingNamedStatePaths(target, bh, p.name);
        const params: Record<string, unknown> = { path: slot.bridge };
        params.pause = p.pause !== false;
        const r = await bh.call<{ paused?: boolean; state?: StateSummary }>(target, "load_state", params);
        return ok(withState(`Loaded slot '${slot.name}' (${r.paused ? "paused" : "running"})`, r.state));
      }
      case "bizhawk_list_slots": {
        const target = p.target as string;
        const backend = bh.getBackend(target);
        const hash = await currentRomHash(target, bh);
        const dir = path.join(stateDir(backend), hash);
        if (!fs.existsSync(dir)) return ok("(no slots saved for this ROM)");
        const entries = fs.readdirSync(dir).filter((f) => f.endsWith(".State")).sort()
          .map((f) => {
            const st = fs.statSync(path.join(dir, f));
            return `${f.slice(0, -6)}  (${st.size} bytes, ${st.mtime.toISOString()})`;
          });
        return ok(entries.length ? entries.join("\n") : "(no slots saved for this ROM)");
      }

      case "bizhawk_trace_start": {
        const target = p.target as string;
        const params: Record<string, unknown> = {};
        if (p.path !== undefined) rejectPathArg(name, "path");
        if (p.osd  !== undefined) params.osd  = p.osd;
        const r = await bh.call<{ path: string; osd: boolean }>(target, "trace_start", params);
        return ok(`Trace started (osd: ${r.osd ? "on" : "off"})`);
      }
      case "bizhawk_trace_stop": {
        const target = p.target as string;
        const r = await bh.call<{ path?: string; frames: number }>(target, "trace_stop");
        return ok(`Trace stopped after ${r.frames} rows`);
      }
      case "bizhawk_trace_status": {
        const target = p.target as string;
        const r = await bh.call<{ active: boolean; path?: string; frames: number; osd: boolean }>(target, "trace_status");
        return ok(
          `Trace ${r.active ? "active" : "inactive"}: ${r.frames} rows, ` +
          `osd: ${r.osd ? "on" : "off"}`,
        );
      }
      case "bizhawk_trace_tail": {
        const target = p.target as string;
        const st = await bh.call<{ active: boolean; path?: string }>(target, "trace_status");
        if (!st.path) throw new Error("no trace file — the trace has never been started on this bridge");
        const rows = (p.rows as number) ?? 10;
        let text: string;
        try {
          text = fs.readFileSync(st.path, "utf8");
        } catch (err) {
          throw new Error(`trace file is unavailable: ${pathlessFileReadError(err)}`);
        }
        const lines = text.trimEnd().split("\n");
        const header = lines[0];
        const tail = lines.slice(Math.max(1, lines.length - rows));
        return ok([
          `Trace tail (${lines.length - 1} rows, active: ${st.active ? "yes" : "no"})`,
          header,
          ...tail,
        ].join("\n"));
      }

      case "bizhawk_phys_trace_start": {
        const target = p.target as string;
        const params: Record<string, unknown> = {};
        if (p.path !== undefined) rejectPathArg(name, "path");
        const r = await bh.call<{ path: string; latch_addr: string; emit_addr: string }>(target, 
          "phys_trace_start", params);
        return ok(`Physics-sync trace started (latch ${r.latch_addr}, emit ${r.emit_addr})`);
      }
      case "bizhawk_phys_trace_stop": {
        const target = p.target as string;
        const r = await bh.call<{ path?: string; ticks: number }>(target, "phys_trace_stop");
        return ok(`Physics-sync trace stopped after ${r.ticks} ticks`);
      }
      case "bizhawk_phys_trace_status": {
        const target = p.target as string;
        const r = await bh.call<{ active: boolean; path?: string; ticks: number; latched_d7: number }>(target, 
          "phys_trace_status");
        return ok(
          `Physics-sync trace ${r.active ? "active" : "inactive"}: ` +
          `${r.ticks} ticks, last D7: ${r.latched_d7}`);
      }
      case "bizhawk_phys_trace_tail": {
        const target = p.target as string;
        const st = await bh.call<{ active: boolean; path?: string }>(target, "phys_trace_status");
        if (!st.path) throw new Error("no phys trace file — the physics-sync trace has never been started on this bridge");
        const rows = (p.rows as number) ?? 10;
        let text: string;
        try {
          text = fs.readFileSync(st.path, "utf8");
        } catch (err) {
          throw new Error(`physics-sync trace file is unavailable: ${pathlessFileReadError(err)}`);
        }
        const lines = text.trimEnd().split("\n");
        const header = lines[0];
        const tail = lines.slice(Math.max(1, lines.length - rows));
        return ok([
          `Physics-sync trace tail (${lines.length - 1} ticks, active: ${st.active ? "yes" : "no"})`,
          header,
          ...tail,
        ].join("\n"));
      }

      case "bizhawk_screenshot": {
        // Vision caption is ON BY DEFAULT (opt out with describe:false). It is
        // ADDITIVE: the inline PNG is ALWAYS returned; the caption is appended
        // when vision is available. Best-effort — a missing config or a vision
        // outage degrades to image-only + a short note, never a hard error.
        const target = p.target as string;
        const backend = bh.getBackend(target);
        const wantCaption = p.describe !== false;
        const cfg = wantCaption ? visionConfig() : null;
        if (p.path !== undefined) rejectPathArg(name, "path");
        const explicit = p.path as string | undefined;
        const shotName = p.name !== undefined
          ? screenshotFilename(p.name)
          : `mcp-bizhawk-shot-${process.pid}-${Date.now()}.png`;
        const { local: readPath, remote: sendPath } = explicit
          ? { local: explicit, remote: explicit }
          : shotPaths(shotName, backend);
        await bh.call<string>(target, "screenshot", { path: sendPath });

        // Build the caption (best-effort) before assembling the content blocks.
        let caption: string | null = null;
        if (wantCaption) {
          if (!cfg) {
            caption = "(vision caption unavailable: VISION_BASE_URL/VISION_MODEL not set; pass describe:false to silence)";
          } else {
            try {
              const desc = await describeImage(readPath, p.describe_prompt as string | undefined, cfg);
              caption = `Described by ${cfg.model}:\n${desc}`;
            } catch (err) {
              caption = `(vision caption unavailable: ${publicVisionError(err)})`;
            }
          }
        }

        let bytes: Buffer;
        try {
          bytes = fs.readFileSync(readPath);
        } catch (err) {
          // Can't inline the image (e.g. BizHawk on a different filesystem with no
          // shared-dir mapping) — still return the caption if we have one.
          const note = `Screenshot captured: ${shotName} (could not inline image: ${pathlessFileReadError(err)})`;
          return ok(caption ? `${note}\n\n${caption}` : note);
        }
        const content: (
          | { type: "text"; text: string }
          | { type: "image"; data: string; mimeType: string }
        )[] = [
          { type: "text", text: `Screenshot captured: ${shotName}` },
          { type: "image", data: bytes.toString("base64"), mimeType: "image/png" },
        ];
        if (caption) content.push({ type: "text", text: caption });
        return { content };
      }

      case "bizhawk_osd_message": {
        const target = p.target as string;
        const r = await bh.call<{ message: string }>(target, "osd_message", { message: p.message });
        return ok(`OSD message shown: ${r.message}`);
      }

      case "bizhawk_save_state": {
        const target = p.target as string;
        if (p.path !== undefined) rejectPathArg(name, "path");
        if (p.name !== undefined) {
          const slot = await namedStatePaths(target, bh, p.name);
          fs.mkdirSync(path.dirname(slot.local), { recursive: true });
          await bh.call<{ path: string }>(target, "save_state", { path: slot.bridge });
          return ok(`Saved state '${slot.name}'`);
        }
        throw new Error("bizhawk_save_state.name is required");
      }
      case "bizhawk_load_state": {
        const target = p.target as string;
        if (p.path !== undefined) rejectPathArg(name, "path");
        let stateName: string | null = null;
        const params: Record<string, unknown> = {};
        if (p.name !== undefined) {
          const slot = await existingNamedStatePaths(target, bh, p.name);
          params.path = slot.bridge;
          stateName = slot.name;
        } else throw new Error("bizhawk_load_state.name is required");
        params.pause = p.pause !== false;
        const r = await bh.call<{ path: string; paused?: boolean; state?: StateSummary }>(target, "load_state", params);
        const base = stateName
          ? `Loaded state '${stateName}' (${r.paused ? "paused" : "running"})`
          : `Loaded state from ${r.path} (${r.paused ? "paused" : "running"})`;
        const st = fmtState(r.state);
        return ok(st ? `${base}\nState: ${st}` : base);
      }

      default:
        throw new Error(`Unknown tool: ${name}`);
    }
  };

  // Timing + usage-log wrapper around the dispatcher. `ok` reflects whether the
  // call threw (validation/bridge errors throw) OR returned an isError result;
  // logging is best-effort and never alters the response.
  server.setRequestHandler(CallToolRequestSchema, async (req) => {
    const name = req.params.name;
    const args = (req.params.arguments ?? {}) as Record<string, unknown>;
    const target = args.target as string | undefined;
    const startedMs = Date.now();
    let ok = true;
    let errMsg: string | undefined;
    try {
      const res = await dispatchTool(req);
      if (res && (res as { isError?: boolean }).isError) {
        ok = false;
        const c = (res as { content?: { type: string; text?: string }[] }).content;
        errMsg = c?.find((x) => x.type === "text")?.text;
      }
      recordUsage(name, target, args, ok, Date.now() - startedMs, errMsg);
      return res;
    } catch (e) {
      ok = false;
      errMsg = errorCode(e as Error);
      recordUsage(name, target, args, ok, Date.now() - startedMs, errMsg);
      throw e;
    }
  });
}
