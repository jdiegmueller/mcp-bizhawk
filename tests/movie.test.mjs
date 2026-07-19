import test from "node:test";
import assert from "node:assert/strict";
import { startHarness, textOf } from "./helpers/harness.mjs";

test("bizhawk_movie_status formats loaded state", async () => {
  const h = await startHarness({
    movie_status: () => ({ loaded: true, mode: "PLAY", filename: "/tmp/run.bk2", length: 1242 }),
  });
  try {
    const res = await h.client.callTool({ name: "bizhawk_movie_status", arguments: { target: h.target } });
    const text = textOf(res);
    assert.match(text, /Movie: \/tmp\/run\.bk2/);
    assert.match(text, /mode: PLAY/);
    assert.match(text, /length: 1242/);
  } finally {
    await h.close();
  }
});

test("bizhawk_movie_play restarts the currently loaded movie", async () => {
  const h = await startHarness({
    movie_play: () => ({ loaded: true, mode: "PLAY", filename: "current.bk2", length: 500 }),
  });
  try {
    const res = await h.client.callTool({
      name: "bizhawk_movie_play",
      arguments: { target: h.target },
    });
    assert.match(textOf(res), /Movie: current\.bk2 \(loaded, mode: PLAY, length: 500\)/);
  } finally {
    await h.close();
  }
});

test("bizhawk_movie_stop", async () => {
  const h = await startHarness({ movie_stop: () => true });
  try {
    const res = await h.client.callTool({ name: "bizhawk_movie_stop", arguments: { target: h.target } });
    assert.equal(textOf(res), "Movie stopped.");
  } finally {
    await h.close();
  }
});
