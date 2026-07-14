# Spec: expose the physics-sync trace as MCP tools

## Context

`lua/bridge_JD.lua` **v0.15.0** added a *physics-sync trace* — an NHL94-specific
capture that writes **one CSV row per `updateplayers` physics tick** (not per
video frame), carrying the per-pass D7 step multiplier. It works by registering
two `event.on_bus_exec` hooks in the retail nhl94.gen Gameloop:

- `@0x7958` latches `D7 = $B03E − $B040` (elapsed vblanks) before the snapshot
  instruction zeroes the diff;
- `@0x7966` (first instruction after `bsr updateplayers` returns) writes the
  post-update slot-2 state + the latched D7 + a monotonic tick counter.

The three bridge handlers already exist and are in the `HANDLERS` dispatch
table:

| method | params | returns |
|---|---|---|
| `phys_trace_start` | `{ path? }` | `{ path, latch_addr, emit_addr }` |
| `phys_trace_stop`  | `{}` | `{ path, ticks }` |
| `phys_trace_status`| `{}` | `{ active, path, ticks, latched_d7 }` |

`phys_trace_start` is **retail-hash-guarded** (errors on any ROM whose MD5 ≠
`8356B3F0…`) and requires `event.on_bus_exec` (errors on cores without it).
Both surface naturally as tool errors — no special handling needed.

CSV columns: `tick,frame,d7,pad,x,xsub,y,ysub,xv,yv,fdir,frac` (`frac` added in
bridge v0.16.0: the low word of the 32-bit heading longword @+0x54, of which
`fdir` is the octant high word).
Default path: `/tmp/nhl94_phys_<port>.csv`.

Because the Node server's tool list is fixed, these handlers are currently only
reachable via the `eval_lua` global-alias workaround (`_G.phys_trace_start`
etc. in the bridge). **This task replaces that with first-class MCP tools.**

## The task

Add three (optionally four) MCP tools in **`src/tools.ts`**, mirroring the
existing `bizhawk_trace_*` tools exactly.

### 1. Tool definitions — in the tools array

Add after the `bizhawk_trace_tail` block (~line 1037+). Follow the
`bizhawk_trace_start`/`_stop`/`_status` shape at lines 1002–1035 verbatim
(PURPOSE/USAGE/BEHAVIOR/RETURNS description style, `inputSchema` with
`additionalProperties: false`):

- **`bizhawk_phys_trace_start`** — `inputSchema` property `path` (string,
  optional; "Omit to reuse the bridge default /tmp/nhl94_phys_<port>.csv").
  Description must note: retail nhl94.gen ONLY (hash-guarded → errors on other
  ROMs), writes one row per physics tick with a per-tick D7 column, and that it
  suppresses the per-video-frame `bizhawk_trace_*` writer while active.
- **`bizhawk_phys_trace_stop`** — no params (`properties: {}`).
- **`bizhawk_phys_trace_status`** — no params.
- *(optional)* **`bizhawk_phys_trace_tail`** — clone `bizhawk_trace_tail`
  (lines 1037+/1598–1611) but read the path from `phys_trace_status` instead of
  `trace_status`. The phys CSV is narrow (12 cols), so a tail is genuinely
  useful here; still nice-to-have, not required.

### 2. Dispatch cases — in the switch (~line 1580)

Add after the `bizhawk_trace_*` cases, using the same `bh.call<…>(…)` +
`ok(...)` pattern:

```ts
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
```

### 3. Housekeeping

- Update `CHANGELOG.md` and bump the server version (`src/version.ts`).
- `npm run build` (server runs from `dist/`), then run the test suite.
- If there is a tools-count or schema snapshot test, update it.
- The user must restart the MCP server / Claude Code session to pick up the new
  tools.

### 4. After the tools land (bridge cleanup — optional)

Once `bizhawk_phys_trace_*` work through normal dispatch, the
`_G.phys_trace_start/stop/status` global aliases in `bridge_JD.lua` (added only
for the eval_lua workaround) can be removed. Harmless to leave; note it either
way. **Do not** touch the hook logic, addresses, or CSV format — those are
trace-verified against retail.

## Acceptance

- `bizhawk_phys_trace_start` on retail nhl94.gen returns the started message
  with the two hook addresses; on any other ROM it returns a hash-guard error.
- Start → `bizhawk_play_input_sequence` (hold a direction) → stop yields a CSV
  whose `tick` column is monotonic 1..N with no gaps/dups and whose `d7` column
  contains only values ≥ 1.
- `bizhawk_trace_*` still works unchanged when phys-sync is inactive.
