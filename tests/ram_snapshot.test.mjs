import test from "node:test";
import assert from "node:assert/strict";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import crypto from "node:crypto";
import { startHarness, textOf } from "./helpers/harness.mjs";

test("bizhawk_ram_snapshot chunks read_range, writes the file, reports sha256", async () => {
  // Deterministic memory: byte at address A = A & 0xff.
  const calls = [];
  const h = await startHarness({
    read_range: (p) => {
      calls.push({ address: p.address, length: p.length, domain: p.domain });
      return Array.from({ length: p.length }, (_, i) => (p.address + i) & 0xff);
    },
  });
  const out = path.join(os.tmpdir(), `ram-snap-test-${process.pid}.bin`);
  try {
    const res = await h.client.callTool({
      name: "bizhawk_ram_snapshot",
      arguments: { target: h.target, base: 0, size: 0x2800, domain: "68K RAM", path: out }, // 0x2800 = 10240 → 3 chunks (4096,4096,2048)
    });
    const t = textOf(res);
    assert.match(t, new RegExp(`${out.replace(/[.\\/]/g, "\\$&")} \\(10240 bytes, 68K RAM @0x0\\)`));
    assert.match(t, /sha256=[0-9a-f]{64}/);

    // File exists, correct size, and content matches the deterministic pattern.
    const buf = fs.readFileSync(out);
    assert.equal(buf.length, 0x2800);
    for (const probe of [0, 1, 255, 256, 4095, 4096, 10239]) {
      assert.equal(buf[probe], probe & 0xff, `byte ${probe}`);
    }
    // Chunking: 4096 + 4096 + 2048, contiguous from base 0.
    assert.deepEqual(calls.map((c) => c.length), [4096, 4096, 2048]);
    assert.deepEqual(calls.map((c) => c.address), [0, 4096, 8192]);
    assert.ok(calls.every((c) => c.domain === "68K RAM"));

    // Reported digest matches an independent hash of the file.
    const digest = crypto.createHash("sha256").update(buf).digest("hex");
    assert.match(t, new RegExp(`sha256=${digest}`));
  } finally {
    await h.close();
    fs.rmSync(out, { force: true });
  }
});

test("bizhawk_ram_snapshot defaults to the full 64 KiB 68K RAM", async () => {
  const h = await startHarness({
    read_range: (p) => Array.from({ length: p.length }, () => 0),
  });
  try {
    const res = await h.client.callTool({ name: "bizhawk_ram_snapshot", arguments: { target: h.target } });
    const t = textOf(res);
    assert.match(t, /\(65536 bytes, 68K RAM @0x0\)/);
    const m = /^(\S+) \(/.exec(t);
    if (m) fs.rmSync(m[1], { force: true });
  } finally {
    await h.close();
  }
});
