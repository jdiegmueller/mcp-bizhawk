import test from "node:test";
import assert from "node:assert/strict";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { startHarness } from "./helpers/harness.mjs";

const readLines = (f) =>
  fs.readFileSync(f, "utf8").trim().split("\n").filter(Boolean).map((l) => JSON.parse(l));

test("usage log records one JSONL row per call with tool, ok, ms, and verbatim args", async () => {
  const file = path.join(fs.mkdtempSync(path.join(os.tmpdir(), "mcp-usage-")), "usage.jsonl");
  process.env.MCP_BIZHAWK_USAGE_LOG = file;
  const h = await startHarness({ ping: () => "pong" });
  try {
    await h.client.callTool({ name: "bizhawk_ping", arguments: { target: h.target } });
    await h.client.callTool({ name: "bizhawk_ping", arguments: { target: h.target } });
    const rows = readLines(file);
    assert.equal(rows.length, 2);
    for (const r of rows) {
      assert.equal(r.tool, "bizhawk_ping");
      assert.equal(r.ok, true);
      assert.equal(typeof r.ms, "number");
      assert.ok(typeof r.ts === "string" && r.ts.endsWith("Z"));
      assert.deepEqual(r.args, { target: "test" });
    }
  } finally {
    await h.close();
    delete process.env.MCP_BIZHAWK_USAGE_LOG;
  }
});

test("usage log captures args verbatim and marks failures with ok:false + error", async () => {
  const file = path.join(fs.mkdtempSync(path.join(os.tmpdir(), "mcp-usage-")), "usage.jsonl");
  process.env.MCP_BIZHAWK_USAGE_LOG = file;
  // No handler for this tool on the fake bridge → the call fails.
  const h = await startHarness({});
  try {
    await h.client.callTool({ name: "bizhawk_frame_advance", arguments: { target: h.target, count: 7 } }).catch(() => {});
    const rows = readLines(file);
    assert.equal(rows.length, 1);
    assert.equal(rows[0].tool, "bizhawk_frame_advance");
    assert.deepEqual(rows[0].args, { target: "test", count: 7 }); // verbatim
    assert.equal(rows[0].ok, false);
    assert.ok(typeof rows[0].error === "string" && rows[0].error.length > 0);
  } finally {
    await h.close();
    delete process.env.MCP_BIZHAWK_USAGE_LOG;
  }
});

test("MCP_BIZHAWK_USAGE_LOG=off disables logging entirely", async () => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), "mcp-usage-"));
  const file = path.join(dir, "usage.jsonl");
  process.env.MCP_BIZHAWK_USAGE_LOG = "off";
  const h = await startHarness({ ping: () => "pong" });
  try {
    await h.client.callTool({ name: "bizhawk_ping", arguments: { target: h.target } });
    assert.equal(fs.existsSync(file), false);
    assert.deepEqual(fs.readdirSync(dir), []);
  } finally {
    await h.close();
    delete process.env.MCP_BIZHAWK_USAGE_LOG;
  }
});
