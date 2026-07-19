import { describe, it } from "node:test";
import assert from "node:assert";
import { validateConfig } from "../dist/config.js";

describe("config validation", () => {
  it("accepts minimal valid config", () => {
    const cfg = validateConfig({ backends: { a: { bizhawkPort: 8766 } } });
    assert.equal(cfg.backends.a.bizhawkPort, 8766);
    assert.equal(cfg.backends.a.bizhawkHost, undefined);
  });

  it("rejects missing backends", () => {
    assert.throws(() => validateConfig({}), /must have a "backends" object/);
  });

  it("rejects empty backends", () => {
    assert.throws(() => validateConfig({ backends: {} }), /At least one backend/);
  });

  it("rejects empty backend name", () => {
    assert.throws(() => validateConfig({ backends: { "": { bizhawkPort: 8766 } } }), /must be non-empty/);
  });

  it("rejects duplicate ports", () => {
    assert.throws(() => validateConfig({
      backends: { a: { bizhawkPort: 8766 }, b: { bizhawkPort: 8766 } }
    }), /used by more than one backend/);
  });

  it("rejects invalid port (zero)", () => {
    assert.throws(() => validateConfig({ backends: { a: { bizhawkPort: 0 } } }), /must be an integer 1-65535/);
  });

  it("rejects invalid port (too high)", () => {
    assert.throws(() => validateConfig({ backends: { a: { bizhawkPort: 99999 } } }), /must be an integer 1-65535/);
  });

  it("rejects unknown top-level key", () => {
    assert.throws(() => validateConfig({ backends: { a: { bizhawkPort: 8766 } }, extra: true }), /Unknown config key.*"extra"/);
  });

  it("rejects unknown backend key", () => {
    assert.throws(() => validateConfig({ backends: { a: { bizhawkPort: 8766, bizhawkHosst: "0.0.0.0" } } }), /Unknown key.*"bizhawkHosst"/);
  });

  it("rejects allowedRemoteAddresses on loopback host", () => {
    assert.throws(() => validateConfig({
      backends: { a: { bizhawkPort: 8766, allowedRemoteAddresses: ["1.2.3.4"] } }
    }), /requires a non-loopback/);
  });

  it("accepts allowedRemoteAddresses on non-loopback host", () => {
    const cfg = validateConfig({
      backends: { a: { bizhawkPort: 8766, bizhawkHost: "0.0.0.0", allowedRemoteAddresses: ["192.168.1.50"] } }
    });
    assert.deepEqual(cfg.backends.a.allowedRemoteAddresses, ["192.168.1.50"]);
  });

  it("parses vision section", () => {
    const cfg = validateConfig({
      backends: { a: { bizhawkPort: 8766 } },
      vision: { baseUrl: "http://x/v1", model: "m" }
    });
    assert.equal(cfg.vision?.baseUrl, "http://x/v1");
    assert.equal(cfg.vision?.model, "m");
  });

  it("rejects non-object backends value", () => {
    assert.throws(() => validateConfig({ backends: 42 }), /must have a "backends" object/);
  });

  it("accepts full path config", () => {
    const cfg = validateConfig({
      backends: {
        w: {
          bizhawkPort: 8766,
          os: "windows",
          bizhawkHost: "0.0.0.0",
          allowedRemoteAddresses: ["10.0.0.5"],
          shotDir: "/tmp/shot",
          shotDirBridge: "X:\\tmp\\shot",
          stateDir: "/tmp/state",
          stateDirBridge: "X:\\tmp\\state",
          rigDir: "/tmp/rig",
          rigDirBridge: "X:\\tmp\\rig",
        }
      }
    });
    assert.equal(cfg.backends.w.os, "windows");
    assert.equal(cfg.backends.w.shotDir, "/tmp/shot");
    assert.equal(cfg.backends.w.shotDirBridge, "X:\\tmp\\shot");
  });

  it("rejects invalid backend os", () => {
    assert.throws(
      () => validateConfig({ backends: { a: { bizhawkPort: 8766, os: "mac" } } }),
      /os must be "windows" or "linux"/,
    );
  });
});
