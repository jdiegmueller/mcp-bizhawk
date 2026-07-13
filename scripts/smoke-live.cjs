#!/usr/bin/env node
// Live smoke test for batch-1 features against a real BizHawk + bridge_JD.lua.
//
// Usage:
//   npm run build
//   node scripts/smoke-live.cjs [port]        (default 8768)
// then launch BizHawk against that port, e.g.:
//   ./EmuHawkMono.sh --socket_ip=127.0.0.1 --socket_port=8768 \
//       --lua=Lua/bridge_JD.lua <rom>
//
// NOTE: uses a dedicated port so it never fights the MCP servers on 8766/8767.

const port = parseInt(process.argv[2] ?? "8768", 10);

async function main() {
  const { BizhawkServer } = await import("../dist/bizhawk.js");
  const bh = new BizhawkServer({ host: "127.0.0.1", port, timeoutMs: 15000 });
  await bh.start();
  console.log(`[smoke] listening on ${port}; waiting for bridge_JD.lua to poll...`);
  while (!bh.isBridgeReady()) await new Promise((r) => setTimeout(r, 200));

  const info = await bh.call("get_info");
  console.log("[smoke] bridge:", JSON.stringify(info.bridge), "rom:", info.rom_name);

  console.log("[smoke] read_many:", JSON.stringify(await bh.call("read_many", {
    reads: [
      { name: "b0", address: 0, width: "u8" },
      { name: "w0_be", address: 0, width: "u16_be" },
      { name: "sw0", address: 0, width: "s16_be" },
    ],
  })));

  console.log("[smoke] read_struct_array:", JSON.stringify(await bh.call("read_struct_array", {
    base: 0, stride: 4, count: 3,
    fields: [{ name: "a", offset: 0, width: "u16_be" }, { name: "b", offset: 2, width: "u16_be" }],
  })));

  let t = Date.now();
  await bh.call("frame_advance", { count: 300 }, { timeoutMs: 60000 });
  console.log(`[smoke] 300 frames normal: ${Date.now() - t}ms (expect ~5000)`);

  t = Date.now();
  await bh.call("frame_advance", { count: 300, turbo: true }, { timeoutMs: 60000 });
  console.log(`[smoke] 300 frames turbo:  ${Date.now() - t}ms (expect a small fraction of normal)`);

  console.log("[smoke] screenshot:", await bh.call("screenshot", { path: "/tmp/smoke-shot.png" }));

  // Batch 2: freeze / eval_lua / search
  console.log("[smoke] eval_lua framecount:", JSON.stringify(
    await bh.call("eval_lua", { code: "return emu.framecount()" })));

  console.log("[smoke] freeze:", JSON.stringify(
    await bh.call("freeze", { address: 0x10, value: 0xab, width: "u8", domain: "68K RAM" })));
  await bh.call("frame_advance", { count: 10 }, { timeoutMs: 30000 });
  const frozenVal = await bh.call("read8", { address: 0x10, domain: "68K RAM" });
  console.log(`[smoke] frozen value after 10 frames: ${frozenVal} (expect 171)`);
  console.log("[smoke] unfreeze:", JSON.stringify(await bh.call("unfreeze", { all: true })));

  console.log("[smoke] search_begin:", JSON.stringify(
    await bh.call("search_begin", { width: "u8", start: 0, length: 65536, domain: "68K RAM" })));
  await bh.call("frame_advance", { count: 60, turbo: true }, { timeoutMs: 30000 });
  const f1 = await bh.call("search_filter", { condition: "changed" });
  console.log(`[smoke] changed after 60 frames: ${f1.count} candidates`);
  const f2 = await bh.call("search_filter", { condition: "unchanged" });
  console.log(`[smoke] then unchanged: ${f2.count} candidates (expect < ${f1.count})`);
  await bh.call("search_end");

  console.log("[smoke] ALL OK");
  bh.stop();
}

main().catch((e) => { console.error("[smoke] FAILED:", e); process.exit(1); });
