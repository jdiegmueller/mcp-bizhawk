import test from "node:test";
import assert from "node:assert/strict";
import { startHarness, textOf } from "./helpers/harness.mjs";

const DOMAINS = ["M68K BUS", "68K RAM"];

test("nhl94_fields reads named entity and global fields", async () => {
  const h = await startHarness({
    list_memory_domains: () => DOMAINS,
    read_many: (p) => {
      assert.ok(p.reads.some((r) => r.name === "s0.fdir" && r.address === 0xffb04a + 0x54 && r.width === "u16_be"));
      assert.ok(p.reads.some((r) => r.name === "global.clock" && r.address === 0xffc468 && r.width === "u16_be"));
      return { "s0.fdir": 4, "global.clock": 1199 };
    },
  });
  try {
    const res = await h.client.callTool({
      name: "nhl94_fields",
      arguments: { target: h.target, 
        ops: [
          { op: "read", target: "s0", field: "fdir" },
          { op: "read", target: "global", field: "clock" },
        ],
      },
    });
    const text = textOf(res);
    assert.match(text, /s0\.fdir=south \(4\)/);
    assert.match(text, /global\.clock=19:59 \(1199s\)/);
  } finally {
    await h.close();
  }
});

test("nhl94_fields reads documented NHL94 score globals", async () => {
  const h = await startHarness({
    list_memory_domains: () => DOMAINS,
    read_many: (p) => {
      assert.ok(p.reads.some((r) => r.name === "global.home_score" && r.address === 0xffc6da && r.width === "u16_be"));
      assert.ok(p.reads.some((r) => r.name === "global.away_score" && r.address === 0xffca3e && r.width === "u16_be"));
      return {
        "global.home_score": 2,
        "global.away_score": 1,
      };
    },
  });
  try {
    const res = await h.client.callTool({
      name: "nhl94_fields",
      arguments: { target: h.target,
        ops: [
          { op: "read", target: "global", field: "home_score" },
          { op: "read", target: "global", field: "away_score" },
        ],
      },
    });
    const text = textOf(res);
    assert.match(text, /global\.home_score=2/);
    assert.match(text, /global\.away_score=1/);
  } finally {
    await h.close();
  }
});

test("nhl94_fields reads documented NHL94 RNG and frame globals", async () => {
  const h = await startHarness({
    list_memory_domains: () => DOMAINS,
    read_many: (p) => {
      assert.ok(p.reads.some((r) => r.name === "global.rng_seed" && r.address === 0xffd066 && r.width === "u32_be"));
      assert.ok(p.reads.some((r) => r.name === "global.vblank_frame_counter" && r.address === 0xffb03e && r.width === "u16_be"));
      return {
        "global.rng_seed": 0x12345678,
        "global.vblank_frame_counter": 42,
      };
    },
  });
  try {
    const res = await h.client.callTool({
      name: "nhl94_fields",
      arguments: { target: h.target,
        ops: [
          { op: "read", target: "global", field: "rng_seed" },
          { op: "read", target: "global", field: "vblank_frame_counter" },
        ],
      },
    });
    const text = textOf(res);
    assert.match(text, /global\.rng_seed=305419896/);
    assert.match(text, /global\.vblank_frame_counter=42/);
  } finally {
    await h.close();
  }
});

test("nhl94_fields writes and freezes with post-write readback", async () => {
  const h = await startHarness({
    list_memory_domains: () => DOMAINS,
    memory_ops: (p) => {
      assert.deepEqual(p.ops, [
        { op: "write", address: 0xffb34a + 0x5e, value: 0, width: "u8" },
        { op: "freeze", address: 0xffb34a + 0x54, value: 4, width: "u16_be" },
      ]);
      return { applied: 2, frozen_count: 1 };
    },
    read_many: (p) => {
      assert.deepEqual(p.reads.map((r) => r.name), ["s6.lockout", "s6.fdir"]);
      return { "s6.lockout": 0, "s6.fdir": 4 };
    },
  });
  try {
    const res = await h.client.callTool({
      name: "nhl94_fields",
      arguments: { target: h.target, 
        ops: [
          { op: "write", target: "s6", field: "lockout", value: 0 },
          { op: "write", target: "s6", field: "fdir", value: 4, freeze: true },
        ],
      },
    });
    const text = textOf(res);
    assert.match(text, /wrote s6\.lockout=0 \(readback 0\)/);
    assert.match(text, /froze s6\.fdir=south \(4\) \(readback south \(4\)\)/);
  } finally {
    await h.close();
  }
});

test("nhl94_fields accepts compass direction strings for fdir writes", async () => {
  const h = await startHarness({
    list_memory_domains: () => DOMAINS,
    memory_ops: (p) => {
      assert.deepEqual(p.ops, [
        { op: "freeze", address: 0xffb34a + 0x54, value: 5, width: "u16_be" },
      ]);
      return { applied: 1, frozen_count: 1 };
    },
    read_many: (p) => {
      assert.deepEqual(p.reads.map((r) => r.name), ["s6.fdir"]);
      return { "s6.fdir": 5 };
    },
  });
  try {
    const res = await h.client.callTool({
      name: "nhl94_fields",
      arguments: { target: h.target,
        ops: [{ op: "write", target: "s6", field: "fdir", value: "southwest", freeze: true }],
      },
    });
    assert.match(textOf(res), /froze s6\.fdir=southwest \(5\) \(readback southwest \(5\)\)/);
  } finally {
    await h.close();
  }
});

test("nhl94_fields writes signed velocity fields with bridge-compatible widths", async () => {
  const h = await startHarness({
    list_memory_domains: () => DOMAINS,
    memory_ops: (p) => {
      assert.deepEqual(p.ops, [
        { op: "write", address: 0xffb04a + 0x28, value: 0, width: "u16_be" },
        { op: "write", address: 0xffb04a + 0x2a, value: 12000, width: "u16_be" },
      ]);
      return { applied: 2, frozen_count: 0 };
    },
    read_many: (p) => {
      assert.deepEqual(p.reads.map((r) => `${r.name}:${r.width}`), ["s0.xv:s16_be", "s0.yv:s16_be"]);
      return { "s0.xv": 0, "s0.yv": 12000 };
    },
  });
  try {
    const res = await h.client.callTool({
      name: "nhl94_fields",
      arguments: { target: h.target,
        ops: [
          { op: "write", target: "s0", field: "xv", value: 0 },
          { op: "write", target: "s0", field: "yv", value: 12000 },
        ],
      },
    });
    const text = textOf(res);
    assert.match(text, /wrote s0\.xv=0 \(readback 0\)/);
    assert.match(text, /wrote s0\.yv=12000 \(readback 12000\)/);
  } finally {
    await h.close();
  }
});

test("nhl94_fields rejects unknown compass direction strings for fdir", async () => {
  const h = await startHarness({ list_memory_domains: () => DOMAINS });
  try {
    await assert.rejects(
      h.client.callTool({
        name: "nhl94_fields",
        arguments: { target: h.target, ops: [{ op: "write", target: "s6", field: "fdir", value: "sideways" }] },
      }),
      /fdir direction must be one of/,
    );
  } finally {
    await h.close();
  }
});

test("nhl94_fields freeze without value pins the current RAM value", async () => {
  const readNames = [];
  const h = await startHarness({
    list_memory_domains: () => DOMAINS,
    read_many: (p) => {
      readNames.push(p.reads.map((r) => r.name));
      assert.deepEqual(p.reads.map((r) => r.name), ["s6.fdir"]);
      return { "s6.fdir": 5 };
    },
    memory_ops: (p) => {
      assert.deepEqual(p.ops, [
        { op: "freeze", address: 0xffb34a + 0x54, value: 5, width: "u16_be" },
      ]);
      return { applied: 1, frozen_count: 1 };
    },
  });
  try {
    const res = await h.client.callTool({
      name: "nhl94_fields",
      arguments: { target: h.target, 
        ops: [{ op: "freeze", target: "s6", field: "fdir" }],
      },
    });
    assert.match(textOf(res), /froze s6\.fdir=southwest \(5\) \(readback southwest \(5\)\)/);
    assert.deepEqual(readNames, [["s6.fdir"], ["s6.fdir"]]);
  } finally {
    await h.close();
  }
});

test("nhl94_fields requires allow_raw for raw entity offsets and global addresses", async () => {
  const h = await startHarness({ list_memory_domains: () => DOMAINS });
  try {
    await assert.rejects(
      h.client.callTool({
        name: "nhl94_fields",
        arguments: { target: h.target,  ops: [{ op: "read", target: "s0", offset: "0x71", width: "u8" }] },
      }),
      /allow_raw:true/,
    );
    await assert.rejects(
      h.client.callTool({
        name: "nhl94_fields",
        arguments: { target: h.target,  ops: [{ op: "read", target: "global", address: "0xFFC304", width: "u16_be" }] },
      }),
      /allow_raw:true/,
    );
  } finally {
    await h.close();
  }
});
