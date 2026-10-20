import assert from "node:assert/strict";
import { test } from "node:test";
import {
  canStartOutboundCall,
  chooseCallMethod,
  classifyZiwoEvent,
  createListenerRegistry,
  inferDirection,
  postWithRetry,
} from "../../src/composables/ziwoCall/logic.ts";

// --- Duplicate outbound call prevention -------------------------------------

test("a fresh/idle state allows starting an outbound call", () => {
  assert.equal(canStartOutboundCall({ outboundInFlight: false, callStatus: "" }), true);
  assert.equal(canStartOutboundCall({ outboundInFlight: false, callStatus: "ended" }), true);
});

test("a call already in flight, ringing or active blocks a second attempt", () => {
  assert.equal(canStartOutboundCall({ outboundInFlight: true, callStatus: "" }), false);
  assert.equal(canStartOutboundCall({ outboundInFlight: false, callStatus: "ringing" }), false);
  assert.equal(canStartOutboundCall({ outboundInFlight: false, callStatus: "active" }), false);
  // Both signals set at once is still blocked, not double-counted or ignored.
  assert.equal(canStartOutboundCall({ outboundInFlight: true, callStatus: "active" }), false);
});

// --- Call method selection: decided once, before invocation ----------------

test("prefers clickToCall when both methods are exposed by the SDK", () => {
  const method = chooseCallMethod({
    clickToCall: () => undefined,
    startCall: () => undefined,
  });
  assert.equal(method, "clickToCall");
});

test("falls back to startCall only when clickToCall is not a function at all", () => {
  assert.equal(chooseCallMethod({ startCall: () => undefined }), "startCall");
  assert.equal(chooseCallMethod({ clickToCall: undefined, startCall: () => undefined }), "startCall");
});

test("returns null, never a method, when neither is available", () => {
  assert.equal(chooseCallMethod({}), null);
  assert.equal(chooseCallMethod(null), null);
  assert.equal(chooseCallMethod(undefined), null);
});

test("the decision never depends on invoking either method", () => {
  // A clickToCall that would throw/reject if called is still chosen: the
  // selection is made from typeof alone, before any call happens, so a
  // caller cannot accidentally trigger BOTH methods for one click by
  // "trying" one and "falling back" to the other after a bad outcome.
  let called = false;
  const sdk = {
    clickToCall: () => {
      called = true;
      throw new Error("would fail if invoked");
    },
    startCall: () => undefined,
  };
  const method = chooseCallMethod(sdk);
  assert.equal(method, "clickToCall");
  assert.equal(called, false, "chooseCallMethod must not invoke either method");
});

// --- Event classification ---------------------------------------------------

test("classifies each documented ZIWO event into one call-state category", () => {
  assert.equal(classifyZiwoEvent("ringing"), "ringing");
  assert.equal(classifyZiwoEvent("requesting"), "outbound-progress");
  assert.equal(classifyZiwoEvent("trying"), "outbound-progress");
  assert.equal(classifyZiwoEvent("early"), "outbound-progress");
  assert.equal(classifyZiwoEvent("active"), "active");
  assert.equal(classifyZiwoEvent("answering"), "active");
  assert.equal(classifyZiwoEvent("hangup"), "hangup");
  assert.equal(classifyZiwoEvent("destroy"), "hangup");
});

test("an unrecognized or missing event type is 'unknown', never crashes", () => {
  assert.equal(classifyZiwoEvent("something-new"), "unknown");
  assert.equal(classifyZiwoEvent(""), "unknown");
  assert.equal(classifyZiwoEvent(null), "unknown");
  assert.equal(classifyZiwoEvent(undefined), "unknown");
});

test("event type matching is case-insensitive", () => {
  assert.equal(classifyZiwoEvent("RINGING"), "ringing");
  assert.equal(classifyZiwoEvent("Hangup"), "hangup");
});

// --- Direction inference -----------------------------------------------------

test("direction is inferred purely from whether this agent initiated the call", () => {
  assert.equal(inferDirection(true), "Outbound");
  assert.equal(inferDirection(false), "Inbound");
});

// --- Listener lifecycle: install once, survive repeated setup() calls ------

function fakeWindow() {
  const handlers = new Map<string, Set<Function>>();
  return {
    addEventListener(name: string, fn: Function) {
      if (!handlers.has(name)) handlers.set(name, new Set());
      handlers.get(name)!.add(fn);
    },
    removeEventListener(name: string, fn: Function) {
      handlers.get(name)?.delete(fn);
    },
    dispatch(name: string, detail: unknown) {
      for (const fn of handlers.get(name) || []) (fn as any)({ detail });
    },
    count(name: string) {
      return handlers.get(name)?.size || 0;
    },
  };
}

test("install() registers each event exactly once", () => {
  const win = fakeWindow();
  const registry = createListenerRegistry(win as any, ["ziwo-call-ringing", "ziwo-call-hangup"], () => {});
  registry.install();
  assert.equal(win.count("ziwo-call-ringing"), 1);
  assert.equal(win.count("ziwo-call-hangup"), 1);
  assert.equal(registry.isInstalled(), true);
});

test("repeated install() calls (e.g. setup() firing more than once) do not double-register", () => {
  const win = fakeWindow();
  const registry = createListenerRegistry(win as any, ["ziwo-call-ringing"], () => {});
  registry.install();
  registry.install();
  registry.install();
  assert.equal(win.count("ziwo-call-ringing"), 1, "the same handler must not be added three times");
});

test("remove() is a no-op when nothing was installed, and idempotent after install", () => {
  const win = fakeWindow();
  const registry = createListenerRegistry(win as any, ["ziwo-call-ringing"], () => {});
  registry.remove(); // no-op, must not throw
  assert.equal(registry.isInstalled(), false);

  registry.install();
  registry.remove();
  registry.remove(); // idempotent
  assert.equal(win.count("ziwo-call-ringing"), 0);
  assert.equal(registry.isInstalled(), false);
});

test("a handler stays reachable across many dispatches while installed (models surviving ticket navigation)", () => {
  // The component itself never calls remove() on ticket navigation or on
  // closing the popup — only on its own unmount (onBeforeUnmount), which
  // does not happen when only the nested <router-view> content changes (see
  // AppHeader -> DesktopLayout -> <router-view>). This test models that: the
  // registry, once installed, keeps delivering events through any number of
  // simulated "closed the dialog" / "navigated to another ticket" steps,
  // because none of those actions call remove().
  const win = fakeWindow();
  let received = 0;
  const registry = createListenerRegistry(win as any, ["ziwo-call-active"], () => {
    received += 1;
  });
  registry.install();
  for (let i = 0; i < 5; i++) {
    win.dispatch("ziwo-call-active", {});
    // Simulated "navigate to ticket #i" / "close the dialog" — neither is a
    // real action on the registry, exactly as in the component.
  }
  assert.equal(received, 5);
  assert.equal(registry.isInstalled(), true);
});

// --- Bounded retry for a failed call-event POST -----------------------------

function noWait() {
  return () => Promise.resolve();
}

test("a successful post on the first attempt needs no retry", async () => {
  let calls = 0;
  const result = await postWithRetry(async () => {
    calls += 1;
  });
  assert.deepEqual(result, { ok: true, attempts: 1 });
  assert.equal(calls, 1);
});

test("a post that fails then succeeds is retried and reported as recorded", async () => {
  let calls = 0;
  const result = await postWithRetry(
    async () => {
      calls += 1;
      if (calls < 2) throw new Error("network blip");
    },
    { retries: 2, wait: noWait() }
  );
  assert.deepEqual(result, { ok: true, attempts: 2 });
});

test("a post that always fails is retried up to the bound, then reported as lost — never retried forever", async () => {
  let calls = 0;
  const result = await postWithRetry(
    async () => {
      calls += 1;
      throw new Error("still down");
    },
    { retries: 2, wait: noWait() }
  );
  assert.equal(result.ok, false);
  assert.equal(result.attempts, 3); // 1 initial + 2 retries, then it gives up
  assert.equal(calls, 3);
});

test("backoff delay doubles between attempts", async () => {
  const delays: number[] = [];
  await postWithRetry(
    async () => {
      throw new Error("down");
    },
    {
      retries: 2,
      baseDelayMs: 100,
      wait: async (ms) => {
        delays.push(ms);
      },
    }
  );
  assert.deepEqual(delays, [100, 200]);
});
