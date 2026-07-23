import fs from "node:fs";
import crypto from "node:crypto";
import { parseTeamStructure } from "../dist/nhl94-lines.js";

const romPath = "/mnt/8tb/jason/nvnhl94-2/rom/nhl94.gen";
const expectedSha256 = "ccc0298c118d580863c877abd470c71186ef0a1b60f1e7c6ff1e5a38f48fd053";

if (!fs.existsSync(romPath)) {
  console.log(`SKIP: retail ROM not present at ${romPath}`);
  process.exit(0);
}

const rom = fs.readFileSync(romPath);
const sha256 = crypto.createHash("sha256").update(rom).digest("hex");
if (sha256 !== expectedSha256) {
  throw new Error(`unexpected ROM SHA-256 ${sha256}`);
}

const teamIndex = 11; // MTL
const pointerOffset = 0x30e + teamIndex * 4;
const pointer = rom.readUInt32BE(pointerOffset);
const span = rom.readUInt16BE(pointer + 0x04);
const parsed = parseTeamStructure(rom.subarray(pointer, pointer + span), pointer);
const sc1 = parsed.lines.find((line) => line.name === "Sc1");
if (!sc1) throw new Error("MTL Sc1 row missing");

const goalie = parsed.records[sc1.members.G];
const center = parsed.records[sc1.members.C];
if (goalie?.name !== "Patrick Roy") {
  throw new Error(`MTL Sc1 goalie mismatch: ${goalie?.name ?? "(missing)"}`);
}
if (center?.name !== "Kirk Muller") {
  throw new Error(`MTL Sc1 center mismatch: ${center?.name ?? "(missing)"}`);
}

console.log(
  `Verified retail ROM ${sha256.slice(0, 12)}…: MTL Sc1 G=${goalie.name}, C=${center.name}`,
);
