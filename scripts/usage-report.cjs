#!/usr/bin/env node
"use strict";

const fs = require("node:fs");

function usage() {
  return [
    "Usage: node scripts/usage-report.cjs <jsonl-file> [--json]",
    "",
    "Reads JSONL tool-call records with fields such as:",
    "  {\"tool\":\"nhl94_state\",\"target\":\"bizhawk_8713\",\"duration_ms\":120,\"ok\":true,\"args\":{}}",
  ].join("\n");
}

function percentile(values, pct) {
  if (values.length === 0) return 0;
  const sorted = [...values].sort((a, b) => a - b);
  const idx = Math.ceil((pct / 100) * sorted.length) - 1;
  return sorted[Math.max(0, Math.min(sorted.length - 1, idx))];
}

function incBucket(map, key, duration, ok) {
  const name = key || "(unknown)";
  if (!map[name]) {
    map[name] = { count: 0, failures: 0, durations: [] };
  }
  map[name].count += 1;
  if (!ok) map[name].failures += 1;
  if (Number.isFinite(duration)) map[name].durations.push(duration);
}

function finalizeBucket(bucket) {
  const durations = bucket.durations;
  const sum = durations.reduce((acc, value) => acc + value, 0);
  return {
    count: bucket.count,
    failures: bucket.failures,
    avgMs: durations.length ? Math.round(sum / durations.length) : 0,
    p50Ms: percentile(durations, 50),
    p95Ms: percentile(durations, 95),
    maxMs: durations.length ? Math.max(...durations) : 0,
  };
}

function summarize(records) {
  const tools = {};
  const targets = {};
  const flags = {
    evalLuaFrameadvanceCalls: 0,
    longCalls: 0,
    nhl94StateDescribeTrue: 0,
    nhl94StateDescribeFalse: 0,
  };

  for (const record of records) {
    const tool = record.tool || record.name || record.method;
    const target = record.target || record.args?.target;
    const duration = Number(record.ms ?? record.duration_ms ?? record.durationMs ?? record.elapsed_ms ?? record.elapsedMs);
    const ok = record.ok !== false && !record.error;

    incBucket(tools, tool, duration, ok);
    incBucket(targets, target, duration, ok);

    if (!ok) flags.failures = (flags.failures || 0) + 1;
    if (Number.isFinite(duration) && duration >= 10000) flags.longCalls += 1;
    if (tool === "bizhawk_eval_lua" && /(?:emu\.)?frameadvance\s*\(/.test(String(record.args?.code ?? record.code ?? ""))) {
      flags.evalLuaFrameadvanceCalls += 1;
    }
    if (tool === "nhl94_state") {
      if (record.args?.describe === false) flags.nhl94StateDescribeFalse += 1;
      else flags.nhl94StateDescribeTrue += 1;
    }
  }

  const finalizedTools = Object.fromEntries(
    Object.entries(tools).map(([key, value]) => [key, finalizeBucket(value)]),
  );
  const finalizedTargets = Object.fromEntries(
    Object.entries(targets).map(([key, value]) => [key, finalizeBucket(value)]),
  );

  return {
    totalCalls: records.length,
    failures: records.filter((record) => record.ok === false || record.error).length,
    tools: finalizedTools,
    targets: finalizedTargets,
    flags,
    topTools: Object.entries(finalizedTools)
      .sort((a, b) => b[1].count - a[1].count || a[0].localeCompare(b[0]))
      .slice(0, 12)
      .map(([tool, stats]) => ({ tool, ...stats })),
    topTargets: Object.entries(finalizedTargets)
      .sort((a, b) => b[1].count - a[1].count || a[0].localeCompare(b[0]))
      .slice(0, 12)
      .map(([target, stats]) => ({ target, ...stats })),
  };
}

function readJsonl(path) {
  return fs.readFileSync(path, "utf8")
    .split(/\r?\n/)
    .map((line) => line.trim())
    .filter(Boolean)
    .map((line, index) => {
      try {
        return JSON.parse(line);
      } catch (error) {
        throw new Error(`${path}:${index + 1}: invalid JSON: ${error.message}`);
      }
    });
}

function formatText(report) {
  const lines = [
    `Total calls: ${report.totalCalls}`,
    `Failures: ${report.failures}`,
    "",
    "Top tools:",
  ];
  for (const row of report.topTools) {
    lines.push(`  ${row.tool}: ${row.count} call(s), ${row.failures} failure(s), avg ${row.avgMs}ms, p95 ${row.p95Ms}ms`);
  }
  lines.push("", "Targets:");
  for (const row of report.topTargets) {
    lines.push(`  ${row.target}: ${row.count} call(s), ${row.failures} failure(s), avg ${row.avgMs}ms`);
  }
  lines.push(
    "",
    "Flags:",
    `  eval_lua frameadvance calls: ${report.flags.evalLuaFrameadvanceCalls}`,
    `  long calls (>=10s): ${report.flags.longCalls}`,
    `  nhl94_state describe true/default: ${report.flags.nhl94StateDescribeTrue}`,
    `  nhl94_state describe false: ${report.flags.nhl94StateDescribeFalse}`,
  );
  return `${lines.join("\n")}\n`;
}

function main(argv) {
  const json = argv.includes("--json");
  if (argv.includes("--help") || argv.includes("-h")) {
    console.log(usage());
    return;
  }
  const file = argv.find((arg) => !arg.startsWith("--"));
  if (!file) {
    console.error(usage());
    process.exitCode = 2;
    return;
  }

  const report = summarize(readJsonl(file));
  process.stdout.write(json ? `${JSON.stringify(report, null, 2)}\n` : formatText(report));
}

if (require.main === module) {
  main(process.argv.slice(2));
}

module.exports = { summarize, formatText };
