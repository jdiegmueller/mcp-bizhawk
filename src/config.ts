import fs from "node:fs";

export interface PathPair {
  host: string;
  bridge?: string;
}

export interface BackendPaths {
  shot?: PathPair;
  state?: PathPair;
  rig?: PathPair;
}

export interface BackendConfig {
  bizhawkPort: number;
  bizhawkHost?: string;
  allowedRemoteAddresses?: string[];
  shotDir?: string;
  shotDirBridge?: string;
  stateDir?: string;
  stateDirBridge?: string;
  rigDir?: string;
  rigDirBridge?: string;
}

export interface VisionConfig {
  baseUrl?: string;
  model?: string;
  apiKey?: string;
}

export interface MultiplexerConfig {
  backends: Record<string, BackendConfig>;
  vision?: VisionConfig;
}

const VALID_TOP_KEYS = new Set(["backends", "vision"]);
const VALID_BACKEND_KEYS = new Set([
  "bizhawkPort", "bizhawkHost", "allowedRemoteAddresses",
  "shotDir", "shotDirBridge",
  "stateDir", "stateDirBridge",
  "rigDir", "rigDirBridge",
]);

export function validateConfig(raw: Record<string, unknown>): MultiplexerConfig {
  for (const key of Object.keys(raw)) {
    if (!VALID_TOP_KEYS.has(key)) {
      throw new Error(`Unknown config key: "${key}". Valid keys: ${[...VALID_TOP_KEYS].join(", ")}`);
    }
  }

  const backendsRaw = raw.backends;
  if (!backendsRaw || typeof backendsRaw !== "object" || Array.isArray(backendsRaw)) {
    throw new Error('Config must have a "backends" object with at least one backend.');
  }

  const backends: Record<string, BackendConfig> = {};
  const names = Object.keys(backendsRaw as Record<string, unknown>);
  if (names.length === 0) throw new Error("At least one backend is required.");

  const ports = new Set<number>();

  for (const name of names) {
    if (!name || name.trim() === "") throw new Error("Backend names must be non-empty.");
    const raw = (backendsRaw as Record<string, Record<string, unknown>>)[name];
    if (!raw || typeof raw !== "object") {
      throw new Error(`Backend "${name}" must be an object.`);
    }

    for (const key of Object.keys(raw)) {
      if (!VALID_BACKEND_KEYS.has(key)) {
        throw new Error(`Unknown key "${key}" on backend "${name}". Valid keys: ${[...VALID_BACKEND_KEYS].join(", ")}`);
      }
    }

    const port = raw.bizhawkPort;
    if (typeof port !== "number" || !Number.isInteger(port) || port < 1 || port > 65535) {
      throw new Error(`Backend "${name}" has invalid bizhawkPort: must be an integer 1-65535.`);
    }
    if (ports.has(port)) throw new Error(`Port ${port} is used by more than one backend.`);
    ports.add(port);

    const host: string | undefined = typeof raw.bizhawkHost === "string" ? raw.bizhawkHost : undefined;

    let allowedRemoteAddresses: string[] | undefined;
    if (raw.allowedRemoteAddresses !== undefined) {
      if (!host || host === "127.0.0.1") {
        throw new Error(`Backend "${name}": allowedRemoteAddresses requires a non-loopback bizhawkHost.`);
      }
      if (!Array.isArray(raw.allowedRemoteAddresses) || !raw.allowedRemoteAddresses.every((a) => typeof a === "string")) {
        throw new Error(`Backend "${name}": allowedRemoteAddresses must be a string array.`);
      }
      allowedRemoteAddresses = raw.allowedRemoteAddresses as string[];
    }

    backends[name] = {
      bizhawkPort: port,
      bizhawkHost: host,
      allowedRemoteAddresses,
      shotDir: typeof raw.shotDir === "string" ? raw.shotDir : undefined,
      shotDirBridge: typeof raw.shotDirBridge === "string" ? raw.shotDirBridge : undefined,
      stateDir: typeof raw.stateDir === "string" ? raw.stateDir : undefined,
      stateDirBridge: typeof raw.stateDirBridge === "string" ? raw.stateDirBridge : undefined,
      rigDir: typeof raw.rigDir === "string" ? raw.rigDir : undefined,
      rigDirBridge: typeof raw.rigDirBridge === "string" ? raw.rigDirBridge : undefined,
    };
  }

  let vision: VisionConfig | undefined;
  if (raw.vision && typeof raw.vision === "object") {
    const v = raw.vision as Record<string, unknown>;
    vision = {
      baseUrl: typeof v.baseUrl === "string" ? v.baseUrl : undefined,
      model: typeof v.model === "string" ? v.model : undefined,
      apiKey: typeof v.apiKey === "string" ? v.apiKey : undefined,
    };
  }

  return { backends, vision };
}

export function loadConfig(filePath?: string): MultiplexerConfig {
  const path = filePath ?? process.env.MCP_BIZHAWK_CONFIG;
  if (!path) {
    process.stderr.write(
      "[mcp-bizhawk] FATAL: MCP_BIZHAWK_CONFIG is required.\n" +
      "              Set it to the path of your backends.json config file.\n",
    );
    process.exit(1);
  }

  let raw: unknown;
  try {
    const text = fs.readFileSync(path, "utf8");
    raw = JSON.parse(text);
  } catch (err) {
    process.stderr.write(
      `[mcp-bizhawk] FATAL: could not read config file "${path}": ${(err as Error).message}\n`,
    );
    process.exit(1);
  }

  if (!raw || typeof raw !== "object" || Array.isArray(raw)) {
    process.stderr.write(
      `[mcp-bizhawk] FATAL: config file "${path}" does not contain a JSON object.\n`,
    );
    process.exit(1);
  }

  try {
    return validateConfig(raw as Record<string, unknown>);
  } catch (err) {
    process.stderr.write(
      `[mcp-bizhawk] FATAL: invalid config "${path}": ${(err as Error).message}\n`,
    );
    process.exit(1);
  }
}
