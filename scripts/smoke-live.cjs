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

  // Batch 3: registers / trap / movie / trace
  try {
    const regs = await bh.call("get_registers");
    console.log("[smoke] registers:", JSON.stringify(regs).slice(0, 200));
  } catch (e) {
    console.log("[smoke] registers unsupported on this core:", e.message);
  }

  try {
    // NHL94: 0xFFC468 (game clock, system bus) is written constantly in play.
    const trap = await bh.call("trap_memory",
      { kind: "write", address: 0xffc468, timeout_frames: 300, turbo: true },
      { timeoutMs: 60000 });
    console.log("[smoke] trap:", trap.hit
      ? `hit after ${trap.frames_waited} frames, PC=${trap.hit.registers?.PC?.toString(16)}`
      : `no hit in ${trap.frames_waited} frames (paused game/menu?)`);
  } catch (e) {
    console.log("[smoke] trap unsupported on this core:", e.message);
  }

  console.log("[smoke] movie_status:", JSON.stringify(await bh.call("movie_status")));

  console.log("[smoke] trace_status:", JSON.stringify(await bh.call("trace_status")));
  console.log("[smoke] trace rotate:", JSON.stringify(
    await bh.call("trace_start", { path: "/tmp/smoke-trace.csv" })));
  await bh.call("frame_advance", { count: 30 }, { timeoutMs: 30000 });
  console.log("[smoke] trace after 30 frames:", JSON.stringify(await bh.call("trace_status")));
  console.log("[smoke] trace_stop:", JSON.stringify(await bh.call("trace_stop")));
  console.log("[smoke] trace restored:", JSON.stringify(await bh.call("trace_start", {})));

  // Batch 4 — get_info new fields
  const info4 = await bh.call("get_info");
  console.log(`[smoke] get_info: system=${info4.system_id} paused=${info4.paused} ` +
    `lag=${info4.lag_count} movie=${info4.movie_mode}`);

  // get_input (nothing held during automated smoke is fine)
  console.log("[smoke] get_input:", JSON.stringify(await bh.call("get_input", { player: 1 })));

  // disassemble at current PC
  console.log("[smoke] disassemble @PC:", JSON.stringify(await bh.call("disassemble", { count: 3 })));

  // osd_message
  console.log("[smoke] osd_message:", JSON.stringify(await bh.call("osd_message", { message: "batch4 smoke" })));
  await bh.call("frame_advance", { count: 30 }, { timeoutMs: 30000 }); // let the toast render

  // eval_lua unpause: pause, then step frames INSIDE the chunk with unpause:true.
  // Without unpause this would block until manually unpaused; with it, it advances and re-pauses.
  await bh.call("pause");
  const fcBefore = await bh.call("eval_lua", { code: "return emu.framecount()" });
  const fcAfter = await bh.call("eval_lua", {
    code: "for i=1,10 do emu.frameadvance() end return emu.framecount()",
    unpause: true,
  }, { timeoutMs: 30000 });
  console.log(`[smoke] eval_lua unpause: framecount ${fcBefore} -> ${fcAfter} (expect +~10, no wedge)`);
  await bh.call("unpause");

  console.log("[smoke] ALL OK");
  bh.stop();
}

main().catch((e) => { console.error("[smoke] FAILED:", e); process.exit(1); });
