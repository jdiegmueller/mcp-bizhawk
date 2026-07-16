import http from "node:http";

// A tiny stub of the OpenAI-compatible /chat/completions endpoint a local
// vision model (llama.cpp / llama-swap) would serve. Captures each request so
// tests can assert we sent the system message + prompt + image correctly.
export async function startVisionStub(content) {
  const received = [];
  const server = http.createServer((req, res) => {
    let body = "";
    req.on("data", (c) => (body += c));
    req.on("end", () => {
      received.push({ url: req.url, body: JSON.parse(body) });
      res.writeHead(200, { "Content-Type": "application/json" });
      res.end(JSON.stringify({ choices: [{ message: { content } }] }));
    });
  });
  await new Promise((r) => server.listen(0, "127.0.0.1", r));
  const port = server.address().port;
  return {
    baseUrl: `http://127.0.0.1:${port}/v1`,
    received,
    close: () => new Promise((r) => server.close(r)),
  };
}
