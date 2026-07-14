// Optional local vision-model integration.
// ─────────────────────────────────────────
// When a screenshot-producing tool is called with `describe: true`, the server
// reads the PNG off disk and POSTs it to a local OpenAI-compatible chat model
// (llama.cpp / llama-swap), returning the model's TEXT description instead of
// inlining the binary image into the tool response. That trades a few KB of
// base64-per-frame for a short caption — a large token saving on dense traces.
//
// Configured entirely via env vars on the server process:
//   VISION_BASE_URL   e.g. https://llama-swap.example.com/v1   (required)
//   VISION_MODEL      e.g. Qwen3.6-35B-A3B                       (required)
//   VISION_API_KEY    bearer token (optional; local servers often ignore it)
//   VISION_DEFAULT_PROMPT   used when a call omits describe_prompt
//   VISION_TIMEOUT_MS  per-image request timeout (default 60000)
//   VISION_MAX_BYTES   refuse images larger than this (default 10 MiB)

import fs from "node:fs";
import path from "node:path";

export interface VisionConfig {
  baseUrl: string;
  model: string;
  apiKey?: string;
  defaultPrompt?: string;
  timeoutMs: number;
  maxBytes: number;
}

/** Read vision config from the environment, or null if the required vars are
 *  unset (so callers can distinguish "not configured" from "misconfigured"). */
export function visionConfig(): VisionConfig | null {
  const baseUrl = process.env.VISION_BASE_URL;
  const model   = process.env.VISION_MODEL;
  if (!baseUrl || !model) return null;
  return {
    baseUrl: baseUrl.replace(/\/+$/, ""),   // strip trailing slash; we append /chat/completions
    model,
    apiKey:        process.env.VISION_API_KEY || undefined,
    defaultPrompt: process.env.VISION_DEFAULT_PROMPT,
    timeoutMs:     parseInt(process.env.VISION_TIMEOUT_MS || "60000", 10),
    maxBytes:      parseInt(process.env.VISION_MAX_BYTES  || "10485760", 10),
  };
}

/** Vision config or a thrown error naming the missing vars — used to fail fast
 *  when `describe` is requested but the server isn't set up for it. */
export function requireVisionConfig(): VisionConfig {
  const cfg = visionConfig();
  if (!cfg) {
    throw new Error(
      "describe requested but vision is not configured — set VISION_BASE_URL and " +
      "VISION_MODEL in the mcp-bizhawk server env (optionally VISION_API_KEY, " +
      "VISION_DEFAULT_PROMPT, VISION_TIMEOUT_MS, VISION_MAX_BYTES).",
    );
  }
  return cfg;
}

const MIME_BY_EXT: Record<string, string> = {
  ".png": "image/png", ".jpg": "image/jpeg", ".jpeg": "image/jpeg",
  ".webp": "image/webp", ".gif": "image/gif",
};

/**
 * Send one image file + prompt to the configured vision model and return its
 * text answer. Throws on read error, oversize image, HTTP error, timeout, or a
 * response without text content.
 */
export async function describeImage(
  imgPath: string,
  prompt: string | undefined,
  cfg: VisionConfig,
): Promise<string> {
  const st = fs.statSync(imgPath);
  if (st.size > cfg.maxBytes) {
    throw new Error(`image too large: ${st.size} bytes (limit ${cfg.maxBytes})`);
  }
  const mime = MIME_BY_EXT[path.extname(imgPath).toLowerCase()] ?? "image/png";
  const b64  = fs.readFileSync(imgPath).toString("base64");
  const q    = prompt || cfg.defaultPrompt || "Describe this image in detail.";

  const body = JSON.stringify({
    model: cfg.model,
    messages: [{
      role: "user",
      content: [
        { type: "text", text: q },
        { type: "image_url", image_url: { url: `data:${mime};base64,${b64}` } },
      ],
    }],
    max_tokens: 1024,
    temperature: 0.2,
  });

  const controller = new AbortController();
  const timer = setTimeout(() => controller.abort(), cfg.timeoutMs);
  let resp: Response;
  try {
    resp = await fetch(`${cfg.baseUrl}/chat/completions`, {
      method: "POST",
      headers: {
        "Content-Type": "application/json",
        ...(cfg.apiKey ? { Authorization: `Bearer ${cfg.apiKey}` } : {}),
      },
      body,
      signal: controller.signal,
    });
  } catch (e) {
    const err = e as Error;
    throw new Error(err.name === "AbortError"
      ? `vision request timed out after ${cfg.timeoutMs}ms`
      : `vision request failed: ${err.message}`);
  } finally {
    clearTimeout(timer);
  }

  if (!resp.ok) {
    const text = await resp.text().catch(() => "");
    throw new Error(`vision request HTTP ${resp.status}: ${text.slice(0, 300)}`);
  }
  const json = await resp.json() as {
    choices?: { message?: { content?: string } }[];
  };
  const content = json?.choices?.[0]?.message?.content;
  if (typeof content !== "string") {
    throw new Error("vision response had no text content");
  }
  return content;
}
