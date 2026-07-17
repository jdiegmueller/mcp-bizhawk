import { BizhawkBackend } from "./backend.js";
import type { BackendStatus } from "./backend.js";
import type { BackendConfig } from "./config.js";
import { UnknownBackendError } from "./errors.js";

export type { BackendStatus };

export class BizhawkServer {
  private backends = new Map<string, BizhawkBackend>();

  private startPromise: Promise<void> | null = null;
  private stopPromise: Promise<void> | null = null;

  /** Validate and start all backends atomically. */
  async start(config: Record<string, BackendConfig>): Promise<void> {
    if (this.backends.size > 0) return;
    if (this.startPromise) return this.startPromise;

    const names = Object.keys(config);
    if (names.length === 0) throw new Error("at least one backend is required");
    for (const name of names) {
      if (!name || name.trim() === "") throw new Error("backend names must be non-empty");
    }
    const seen = new Set<string>();
    for (const name of names) {
      if (seen.has(name)) throw new Error(`duplicate backend name "${name}"`);
      seen.add(name);
    }

    for (const name of names) {
      const backend = new BizhawkBackend(name, config[name]);
      this.backends.set(name, backend);
    }

    this.startPromise = (async () => {
      const started: BizhawkBackend[] = [];
      try {
        for (const name of names) {
          const backend = this.backends.get(name)!;
          await backend.start();
          started.push(backend);
        }
      } catch (err) {
        for (const s of started) {
          try { await s.stop(); } catch { /* best effort */ }
        }
        this.backends.clear();
        this.startPromise = null;
        throw err;
      }
    })();

    try {
      await this.startPromise;
    } finally {
      this.startPromise = null;
    }
  }

  /** Route a command to the named backend. */
  async call<T = unknown>(
    target: string,
    method: string,
    params: Record<string, unknown> = {},
    opts: { timeoutMs?: number } = {},
  ): Promise<T> {
    const backend = this.backends.get(target);
    if (!backend) throw new UnknownBackendError(target, this.validTargets());
    return backend.call<T>(method, params, opts);
  }

  /** Get a backend instance (for NHL domain access, path resolution, etc.). */
  getBackend(target: string): BizhawkBackend {
    const backend = this.backends.get(target);
    if (!backend) throw new UnknownBackendError(target, this.validTargets());
    return backend;
  }

  /** Stop all backends in parallel. Clears the registry. */
  async stop(): Promise<void> {
    if (this.stopPromise) return this.stopPromise;

    this.stopPromise = (async () => {
      const errors: Error[] = [];
      await Promise.all(
        [...this.backends.values()].map(async (b) => {
          try { await b.stop(); } catch (e) { errors.push(e as Error); }
        }),
      );
      this.backends.clear();
      this.stopPromise = null;
      if (errors.length) throw new Error(`errors stopping backends: ${errors.map((e) => e.message).join("; ")}`);
    })();

    return this.stopPromise;
  }

  /** List all configured backends with status snapshots. */
  listBackends(): BackendStatus[] {
    return [...this.backends.values()]
      .map((b) => b.status())
      .sort((a, b) => a.name.localeCompare(b.name));
  }

  private validTargets(): string[] {
    return [...this.backends.keys()].sort();
  }
}
