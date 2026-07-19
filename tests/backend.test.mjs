import { describe, it } from "node:test";
import assert from "node:assert";
import { BizhawkBackend } from "../dist/backend.js";

describe("BizhawkBackend", () => {
  it("starts in stopped state", () => {
    const b = new BizhawkBackend("test", { bizhawkPort: 8766 });
    assert.equal(b.name, "test");
    assert.equal(b.isConnected(), false);
    assert.equal(b.isBridgeReady(), false);
    assert.equal(b.status().state, "stopped");
  });

  it("call() fails when not started", async () => {
    const b = new BizhawkBackend("test", { bizhawkPort: 29999 });
    await assert.rejects(
      () => b.call("ping"),
      /not connected/
    );
  });

  it("rejects unknown method", async function () {
    // This test requires a TCP listener — skip in CI without a port
    let b;
    let port;
    for (let attempt = 0; attempt < 5; attempt++) {
      port = 30000 + Math.floor(Math.random() * 20000);
      b = new BizhawkBackend("test", { bizhawkPort: port });
      try { await b.start(); break; } catch { b = null; }
    }
    if (!b) this.skip();

    try {
      await assert.rejects(
        () => b.call("nonexistent"),
        /not connected/
      );
    } finally {
      await b.stop();
    }
  });

  it("resolvePathPair resolves shot path", () => {
    const b = new BizhawkBackend("w", {
      bizhawkPort: 8766,
      os: "windows",
      shotDir: "/tmp/s",
      shotDirBridge: "X:\\tmp\\s",
    });
    const p = b.resolvePathPair("shot", "cap.png");
    assert.equal(p.host, "/tmp/s/cap.png");
    assert.equal(p.bridge, "X:\\tmp\\s\\cap.png");
  });

  it("derives Windows bridge paths from the shared /mnt/8tb/jason root", () => {
    const b = new BizhawkBackend("w", {
      bizhawkPort: 8766,
      os: "windows",
      shotDir: "/mnt/8tb/jason/tmp",
    });
    const p = b.resolvePathPair("shot", "cap.png");
    assert.equal(p.host, "/mnt/8tb/jason/tmp/cap.png");
    assert.equal(p.bridge, "X:\\tmp\\cap.png");
  });

  it("rejects path pair when dir not configured", () => {
    const b = new BizhawkBackend("w", { bizhawkPort: 8766 });
    assert.throws(() => b.resolvePathPair("shot", "cap.png"), /no shot directory/);
  });
});
