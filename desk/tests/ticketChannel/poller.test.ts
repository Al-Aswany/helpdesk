import assert from "node:assert/strict";
import { test } from "node:test";
import {
  BoundedPoller,
  POLL_DELAYS_MS,
} from "../../src/composables/ticketChannel/poller.ts";

function setup(options: { isVisible?: () => boolean } = {}) {
  const timers: { fn: () => void; ms: number; cleared: boolean }[] = [];
  const state = { pending: true, now: 0, fetches: 0, fail: false };
  const poller = new BoundedPoller({
    fetch: async () => {
      state.fetches += 1;
      if (state.fail) throw new Error("offline");
    },
    shouldPoll: () => state.pending,
    now: () => state.now,
    setTimer: (fn, ms) => {
      const timer = { fn, ms, cleared: false };
      timers.push(timer);
      return timer;
    },
    clearTimer: (handle) => {
      (handle as { cleared: boolean }).cleared = true;
    },
    ...options,
  });
  const live = () => timers.filter((t) => !t.cleared);
  async function fire() {
    const timer = live().at(-1)!;
    timer.cleared = true;
    timer.fn();
    await new Promise((resolve) => setImmediate(resolve));
  }
  return { poller, timers, state, live, fire };
}

test("polls with a backoff and keeps one timer", async () => {
  const { poller, state, live, fire } = setup();
  poller.start();
  poller.start();
  poller.start();
  assert.equal(live().length, 1);
  assert.equal(live()[0]!.ms, POLL_DELAYS_MS[0]);
  for (let i = 0; i < 8; i++) {
    await fire();
    assert.equal(live().length, 1);
  }
  assert.equal(state.fetches, 8);
  assert.equal(live()[0]!.ms, POLL_DELAYS_MS.at(-1));
  poller.stop();
  assert.equal(live().length, 0);
});

test("does not start, and stops, when nothing is pending", async () => {
  const { poller, state, live, fire } = setup();
  state.pending = false;
  poller.start();
  assert.equal(live().length, 0);
  state.pending = true;
  poller.start();
  assert.equal(live().length, 1);
  await fire();
  assert.equal(state.fetches, 1);
  state.pending = false;
  await fire();
  assert.equal(poller.active, false);
  assert.equal(live().length, 0);
});

test("stop is idempotent and no tick runs after it", async () => {
  const { poller, state, timers } = setup();
  poller.start();
  poller.stop();
  poller.stop();
  timers[0]!.fn();
  await new Promise((resolve) => setImmediate(resolve));
  assert.equal(state.fetches, 0);
});

test("gives up after the maximum duration", async () => {
  const { poller, state, live, fire } = setup();
  poller.start();
  state.now = 10 * 60 * 1000 + 1;
  await fire();
  assert.equal(poller.exhausted, true);
  assert.equal(state.fetches, 0);
  assert.equal(live().length, 0);
  state.now = 0;
  poller.start();
  assert.equal(poller.exhausted, false);
  assert.equal(live().length, 1);
});

test("skips the read while the tab is hidden and survives failures", async () => {
  let visible = false;
  const { poller, state, live, fire } = setup({ isVisible: () => visible });
  poller.start();
  await fire();
  assert.equal(state.fetches, 0);
  assert.equal(live().length, 1);
  visible = true;
  state.fail = true;
  await fire();
  assert.equal(state.fetches, 1);
  assert.equal(live().length, 1);
});

test("restart begins again from the first delay without a second timer", async () => {
  const { poller, live, fire } = setup();
  poller.start();
  await fire();
  await fire();
  poller.restart();
  assert.equal(live().length, 1);
  assert.equal(live()[0]!.ms, POLL_DELAYS_MS[0]);
});
