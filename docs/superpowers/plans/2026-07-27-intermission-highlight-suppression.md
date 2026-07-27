# Intermission Highlight Suppression Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Make `nhl94_state` return only an explicit terminal intermission-highlight message whenever the full `gmode` word is in the `0x1xxx` band.

**Architecture:** Add a minimal two-field preflight read before the existing entity snapshot. A pure classifier owns the high-nibble predicate and terminal response formatting; the handler returns before entity, freeze, screenshot, or vision work. Normal values continue through the existing state path unchanged.

**Tech Stack:** TypeScript, Node.js test runner, MCP test harness, Lua bridge version metadata, systemd user service.

## Global Constraints

- Detection is exactly `(gmode & 0xF000) === 0x1000`.
- The session byte at `0xFFC735` is diagnostic evidence and never a gate.
- No option, including `raw`, `verbose`, `sections`, or `describe`, bypasses suppression.
- Highlight handling reads no entity slots, freezes, screenshots, or vision output.
- The response includes the raw 16-bit `gmode` and raw 8-bit session values.
- Server and Lua bridge versions both become `2026.7.59-jd`; protocol remains `3`.
- Preserve unrelated working-tree changes and commit only scoped files.

---

### Task 1: Classifier and suppression contract

**Files:**
- Modify: `src/nhl94.ts`
- Test: `tests/nhl94.test.mjs`

**Interfaces:**
- Produces: `isIntermissionHighlight(gmode: number): boolean`
- Produces: `formatIntermissionHighlight(gmode: number, sessionByte: number): string`

- [ ] **Step 1: Write failing classifier and formatter tests**

Add imports for `isIntermissionHighlight` and `formatIntermissionHighlight`.
Assert that `0x1000`, `0x1200`, `0x1500`, and `0x1700` classify true; `0x0000`,
`0x0fff`, `0x2000`, `0x6000`, and `0xe500` classify false. Assert exact output:

```js
assert.equal(
  formatIntermissionHighlight(0x1500, 0xff),
  [
    "phase: intermission_highlight",
    "INTERMISSION HIGHLIGHT — footage is not part of the active game.",
    "Active-game entities, puck, score, screenshot, and vision intentionally suppressed.",
    "evidence: gmode=0x1500 high_nibble=0x1 session=0xFF",
  ].join("\n"),
);
```

- [ ] **Step 2: Run the focused test and verify failure**

Run: `node --test tests/nhl94.test.mjs`

Expected: FAIL because the two exports do not exist.

- [ ] **Step 3: Implement the pure functions**

Add:

```ts
export function isIntermissionHighlight(gmode: number): boolean {
  return ((gmode >>> 0) & 0xf000) === 0x1000;
}

export function formatIntermissionHighlight(gmode: number, sessionByte: number): string {
  const word = (gmode >>> 0).toString(16).toUpperCase().padStart(4, "0");
  const session = (sessionByte >>> 0).toString(16).toUpperCase().padStart(2, "0");
  return [
    "phase: intermission_highlight",
    "INTERMISSION HIGHLIGHT — footage is not part of the active game.",
    "Active-game entities, puck, score, screenshot, and vision intentionally suppressed.",
    `evidence: gmode=0x${word} high_nibble=0x1 session=0x${session}`,
  ].join("\n");
}
```

- [ ] **Step 4: Run the focused test and verify success**

Run: `node --test tests/nhl94.test.mjs`

Expected: all tests PASS.

### Task 2: State preflight and no-leak behavior

**Files:**
- Modify: `src/tools.ts`
- Test: `tests/nhl94_tools.test.mjs`

**Interfaces:**
- Consumes: `nhl94.isIntermissionHighlight(gmode)`
- Consumes: `nhl94.formatIntermissionHighlight(gmode, sessionByte)`
- Produces: a two-read `read_many` preflight before `read_struct_array`

- [ ] **Step 1: Write failing handler tests**

Add a parameterized test over `0x1000`, `0x1200`, `0x1500`, and `0x1700`.
Have `read_many` return `{ gmode, session: 0xff }`, invoke `nhl94_state` with
`raw:true`, `verbose:true`, `sections:"all"`, and `describe:true`, then assert:

```js
assert.match(text, /^phase: intermission_highlight/m);
assert.match(text, new RegExp(`gmode=0x${gmode.toString(16).toUpperCase().padStart(4, "0")}`));
assert.equal(h.bridge.calls.filter((c) => c.method === "read_struct_array").length, 0);
assert.equal(h.bridge.calls.filter((c) => c.method === "list_frozen").length, 0);
assert.equal(h.bridge.calls.filter((c) => c.method === "screenshot").length, 0);
```

Also assert the single `read_many` contains only `gmode` as `u16_be` and
`session` as `u8`. Add a non-highlight test using `0x2000` that asserts
`read_struct_array` executes. Update existing call-count assertions to expect
the new preflight plus the existing globals read.

- [ ] **Step 2: Run the focused handler tests and verify failure**

Run: `npm run build && node --test tests/nhl94_tools.test.mjs`

Expected: highlight tests FAIL because entity reads still execute and no terminal
response is returned.

- [ ] **Step 3: Add the preflight before entity-field construction**

Immediately after domain detection in `case "nhl94_state"`:

```ts
const preflight = await bh.call<Record<string, number>>(target, "read_many", {
  reads: [
    { name: "gmode", address: d.addr(nhl94.G.gmode), width: "u16_be", domain },
    { name: "session", address: d.addr(nhl94.SESSION_BYTE), width: "u8", domain },
  ],
});
if (nhl94.isIntermissionHighlight(preflight.gmode ?? 0)) {
  return ok(nhl94.formatIntermissionHighlight(preflight.gmode ?? 0, preflight.session ?? 0));
}
```

Update the `nhl94_state` tool description so its behavior and return contract
say that `intermission_highlight` is terminal and that agents must not infer
team, score, rig failure, callback failure, reset, or attract mode.

- [ ] **Step 4: Run focused tests and verify success**

Run: `npm run build && node --test tests/nhl94.test.mjs tests/nhl94_tools.test.mjs`

Expected: all focused tests PASS.

### Task 3: Release metadata, full verification, and deployment

**Files:**
- Modify: `package.json`
- Modify: `src/version.ts`
- Modify: `lua/bridge_JD.lua`
- Verify: generated `dist/`

**Interfaces:**
- Produces: server and bridge display version `2026.7.59-jd`
- Preserves: RPC protocol version `3`

- [ ] **Step 1: Bump version metadata**

Change `package.json`, `src/version.ts`, the Lua header, Lua changelog entry,
and `BRIDGE.version` from `2026.7.58-jd` to `2026.7.59-jd`. Add a concise Lua
entry explaining server-side highlight suppression; do not change protocol.

- [ ] **Step 2: Run full verification**

Run:

```bash
npm test
git diff --check
```

Expected: build succeeds, every test passes, and `git diff --check` emits no
output.

- [ ] **Step 3: Restart and inspect the daemon**

Run:

```bash
systemctl --user restart bizhawk-daemon
systemctl --user is-active bizhawk-daemon
systemctl --user status bizhawk-daemon --no-pager
```

Expected: `is-active` prints `active`, and status shows the rebuilt server
running as `2026.7.59-jd`.

- [ ] **Step 4: Verify the live server version**

Call the server ping/list-backends path or inspect the service log and confirm
that the live process reports `mcp-bizhawk v2026.7.59-jd`.

- [ ] **Step 5: Commit scoped implementation files**

Run:

```bash
git add -- src/nhl94.ts src/tools.ts tests/nhl94.test.mjs tests/nhl94_tools.test.mjs package.json src/version.ts lua/bridge_JD.lua
git commit -m "fix(nhl94): suppress intermission highlight state"
```

Expected: a local commit containing only the implementation, tests, and version
metadata; unrelated working-tree changes remain unstaged.
