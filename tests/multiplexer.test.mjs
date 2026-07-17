import { describe, it } from "node:test";
import assert from "node:assert";
import { BizhawkServer } from "../dist/bizhawk.js";
import { FakeBridge } from "./helpers/fake-bridge.mjs";

describe("BizhawkServer multiplexer", () => {
  it("starts and stops two backends", async () => {
    let portA, portB;
    for (let attempt = 0; attempt < 10; attempt++) {
      portA = 30000 + Math.floor(Math.random() * 20000);
      portB = portA + 1 + Math.floor(Math.random() * 100);
      if (portA !== portB) break;
    }

    const bh = new BizhawkServer();
    await bh.start({
      a: { bizhawkPort: portA },
      b: { bizhawkPort: portB },
    });

    const statuses = bh.listBackends();
    assert.equal(statuses.length, 2);
    assert.equal(statuses[0].state, "listening");
    assert.equal(statuses[1].state, "listening");

    await bh.stop();
    assert.equal(bh.listBackends().length, 0);
  });

  it("routes calls to correct backend", async () => {
    let portA, portB;
    for (let attempt = 0; attempt < 10; attempt++) {
      portA = 30000 + Math.floor(Math.random() * 20000);
      portB = portA + 1 + Math.floor(Math.random() * 100);
      if (portA !== portB) break;
    }

    const bh = new BizhawkServer();
    await bh.start({
      a: { bizhawkPort: portA },
      b: { bizhawkPort: portB },
    });

    const bridgeA = new FakeBridge(portA, {
      ping: () => "from-a",
    });
    const bridgeB = new FakeBridge(portB, {
      ping: () => "from-b",
    });
    await Promise.all([bridgeA.connect(), bridgeB.connect()]);

    // Wait for both ready
    const deadline = Date.now() + 3000;
    while (true) {
      const s = bh.listBackends();
      if (s.every((x) => x.state === "ready")) break;
      if (Date.now() > deadline) throw new Error("timeout waiting for ready");
      await new Promise((r) => setTimeout(r, 10));
    }

    const rA = await bh.call("a", "ping");
    const rB = await bh.call("b", "ping");
    assert.equal(rA, "from-a");
    assert.equal(rB, "from-b");

    assert.equal(bridgeA.calls.length, 1);
    assert.equal(bridgeA.calls[0].method, "ping");
    assert.equal(bridgeB.calls.length, 1);
    assert.equal(bridgeB.calls[0].method, "ping");

    bridgeA.close();
    bridgeB.close();
    await bh.stop();
  });

  it("throws UnknownBackendError for bad target", async () => {
    let port;
    for (let attempt = 0; attempt < 5; attempt++) {
      port = 30000 + Math.floor(Math.random() * 20000);
      try {
        const bh = new BizhawkServer();
        await bh.start({ a: { bizhawkPort: port } });
        await assert.rejects(
          () => bh.call("nope", "ping"),
          (err) => err.message.includes("Unknown backend") && err.message.includes("a")
        );
        await bh.stop();
        break;
      } catch {
        continue;
      }
    }
  });
});
