import net from "node:net";

/**
 * Emulates bridge_JD.lua's side of the wire protocol for tests:
 *   bridge → server:  "READY\n" | "RESULT <json>\n"
 *   server → bridge:  "<byteLen> <payload>\n"   (BizHawk length-prefix framing)
 *
 * `handlers` maps method name → (params) => result. Throwing inside a
 * handler produces an RPC error reply, mirroring the Lua bridge's pcall path.
 */
export class FakeBridge {
  constructor(port, handlers = {}) {
    this.port = port;
    this.handlers = handlers;
    this.calls = []; // every {method, params} received, for assertions
    this.sock = null;
    this.buf = "";
    this.timer = null;
    this.pendingResult = null;
    this.hello = null; // parsed payload of the server's HELLO greeting
    this.helloCount = 0;
  }

  connect() {
    return new Promise((resolve, reject) => {
      this.sock = net.connect(this.port, "127.0.0.1", () => {
        this.sock.setNoDelay(true);
        // Poll like the Lua bridge does once per frame (fast for tests).
        this.timer = setInterval(() => this.tick(), 2);
        resolve();
      });
      this.sock.once("error", reject);
      this.sock.on("data", (chunk) => this.onData(chunk.toString("utf8")));
    });
  }

  onData(chunk) {
    this.buf += chunk;
    let nl;
    while ((nl = this.buf.indexOf("\n")) !== -1) {
      let line = this.buf.slice(0, nl);
      this.buf = this.buf.slice(nl + 1);
      line = line.replace(/^\d+ /, ""); // strip BizHawk length prefix
      if (line === "NONE" || line.length === 0) continue;
      if (line.startsWith("HELLO ")) {
        this.hello = JSON.parse(line.slice(6));
        this.helloCount += 1;
        continue;
      }
      this.onCommand(JSON.parse(line));
    }
  }

  onCommand(cmd) {
    this.calls.push({ method: cmd.method, params: cmd.params ?? {} });
    const h = this.handlers[cmd.method];
    let reply;
    if (!h) {
      reply = { id: cmd.id, error: { code: -32601, message: `unknown method: ${cmd.method}` } };
    } else {
      try {
        reply = { id: cmd.id, result: h(cmd.params ?? {}) };
      } catch (err) {
        reply = { id: cmd.id, error: { code: -32603, message: String(err.message ?? err) } };
      }
    }
    this.pendingResult = "RESULT " + JSON.stringify(reply);
  }

  tick() {
    if (!this.sock || this.sock.destroyed) return;
    const out = this.pendingResult ?? "READY";
    this.pendingResult = null;
    this.sock.write(out + "\n");
  }

  close() {
    clearInterval(this.timer);
    this.sock?.destroy();
  }
}
