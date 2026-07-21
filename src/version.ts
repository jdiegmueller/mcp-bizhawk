// Single source of truth for the server version string. The "-jd" suffix
// marks this modified build (frame-scaled timeouts, byteorder, hold,
// wait_for_memory, pause-safe bridge) vs the unmodified upstream server.
export const VERSION = "2026.7.54-jd";

// RPC PROTOCOL version — the wire contract between this server and the Lua
// bridge (command framing, command/RESULT shapes, the HELLO handshake). It is
// SEPARATE from VERSION: bump it ONLY when that contract changes in a way that
// makes mismatched halves actually incompatible. The bridge advertises its own
// protocol number; the two are "compatible" (no OSD stale-version warning) as
// long as the PROTOCOL numbers match, even when the display VERSION strings
// differ — so a bridge-only or server-only release no longer trips the warning.
export const PROTOCOL_VERSION = 3;
