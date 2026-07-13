import test from "node:test";
import assert from "node:assert/strict";
import { startHarness, textOf } from "./helpers/harness.mjs";

test("bizhawk_movie_status formats loaded state", async () => {
  const h = await startHarness({
    movie_status: () => ({ loaded: true, mode: "PLAY", filename: "/tmp/run.bk2", length: 1242 }),
  });
  try {
    const res = await h.client.callTool({ name: "bizhawk_movie_status", arguments: {} });
    const text = textOf(res);
    assert.match(text, /Movie: \/tmp\/run\.bk2/);
    assert.match(text, /mode: PLAY/);
    assert.match(text, /length: 1242/);
  } finally {
    await h.close();
  }
});

test("bizhawk_movie_play passes the path and reports status", async () => {
  const h = await startHarness({
    movie_play: (p) => ({ loaded: true, mode: "PLAY", filename: p.path, length: 500 }),
  });
  try {
    const res = await h.client.callTool({
      name: "bizhawk_movie_play",
      arguments: { path: "/tmp/demo.bk2" },
    });
    assert.match(textOf(res), /Movie: \/tmp\/demo\.bk2 \(loaded, mode: PLAY, length: 500\)/);
  } finally {
    await h.close();
  }
});

test("bizhawk_movie_stop", async () => {
  const h = await startHarness({ movie_stop: () => true });
  try {
    const res = await h.client.callTool({ name: "bizhawk_movie_stop", arguments: {} });
    assert.equal(textOf(res), "Movie stopped.");
  } finally {
    await h.close();
  }
});
