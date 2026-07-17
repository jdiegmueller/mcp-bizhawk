export class BizhawkError extends Error {
  constructor(message: string) { super(message); this.name = "BizhawkError"; }
}

export class UnknownBackendError extends BizhawkError {
  constructor(target: string, validTargets: string[]) {
    super(`Unknown backend "${target}". Valid targets: ${validTargets.join(", ")}`);
    this.name = "UnknownBackendError";
  }
}

export class BackendNotConnectedError extends BizhawkError {
  constructor(target: string) {
    super(`Backend "${target}" is not connected (no bridge client).`);
    this.name = "BackendNotConnectedError";
  }
}

export class BackendNotReadyError extends BizhawkError {
  constructor(target: string) {
    super(`Backend "${target}" is connected but bridge handshake is not complete yet.`);
    this.name = "BackendNotReadyError";
  }
}

export class BackendDisconnectedError extends BizhawkError {
  constructor(target: string) {
    super(`Backend "${target}" was disconnected unexpectedly.`);
    this.name = "BackendDisconnectedError";
  }
}

export class BackendStoppedError extends BizhawkError {
  constructor(target: string) {
    super(`Backend "${target}" has been shut down.`);
    this.name = "BackendStoppedError";
  }
}

export class BackendCallTimeoutError extends BizhawkError {
  constructor(target: string, method: string) {
    super(`Call "${method}" to backend "${target}" timed out.`);
    this.name = "BackendCallTimeoutError";
  }
}

export function errorCode(err: unknown): string {
  if (err instanceof UnknownBackendError) return "UNKNOWN_BACKEND";
  if (err instanceof BackendNotConnectedError) return "BACKEND_NOT_CONNECTED";
  if (err instanceof BackendNotReadyError) return "BACKEND_NOT_READY";
  if (err instanceof BackendDisconnectedError) return "BACKEND_DISCONNECTED";
  if (err instanceof BackendStoppedError) return "BACKEND_STOPPED";
  if (err instanceof BackendCallTimeoutError) return "BACKEND_TIMEOUT";
  return "ERROR";
}
