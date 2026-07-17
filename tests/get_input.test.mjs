import test from "node:test";
import assert from "node:assert/strict";
import { startHarness, textOf } from "./helpers/harness.mjs";

test("bizhawk_get_input lists held buttons sorted and passes player through", async () => {
  const h = await startHarness({
    get_input: ({ player }) => ({ player: player ?? 1, buttons: { Start: true, A: true } }),
  });
  try {
    const res = await h.client.callTool({ name: "bizhawk_get_input", arguments: { target: h.target, player: 2 } });
    assert.match(textOf(res), /Player 2 held buttons: A, Start/);
    assert.equal(h.bridge.calls.find((c) => c.method === "get_input").params.player, 2);
  } finally {
    await h.close();
  }
});

test("bizhawk_get_input reports (none) when nothing is held", async () => {
  const h = await startHarness({ get_input: () => ({ player: 1 }) });
  try {
    const res = await h.client.callTool({ name: "bizhawk_get_input", arguments: { target: h.target } });
    assert.match(textOf(res), /Player 1 held buttons: \(none\)/);
  } finally {
    await h.close();
  }
});

test("bizhawk_get_input renders axes", async () => {
  const h = await startHarness({
    get_input: () => ({ player: 1, axes: { X: 127, Y: 0 } }),
  });
  try {
    const res = await h.client.callTool({ name: "bizhawk_get_input", arguments: { target: h.target } });
    assert.match(textOf(res), /Axes: X=127, Y=0/);
  } finally {
    await h.close();
  }
});
