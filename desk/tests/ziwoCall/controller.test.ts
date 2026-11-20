import assert from "node:assert/strict";
import { test } from "node:test";
import {
  DISPATCH_WAIT_MS,
  HANGUP_CONFIRM_MS,
  LOGIN_TIMEOUT_MS,
  REJECT_CONFIRM_MS,
  ZiwoController,
} from "../../src/composables/ziwoCall/controller.ts";

// --- fakes -----------------------------------------------------------------------

class Subject {
  value: any = undefined;
  subs = new Set<(v: any) => void>();
  subscribe(fn: (v: any) => void) {
    this.subs.add(fn);
    fn(this.value); // the vendor's info$ is a BehaviorSubject: it replays on subscribe
    return { unsubscribe: () => this.subs.delete(fn) };
  }
  next(value: any) {
    this.value = value;
    [...this.subs].forEach((fn) => fn(value));
  }
}

class FakeClock {
  t = 1_000_000;
  timers: { id: number; at: number; fn: () => void }[] = [];
  seq = 0;
  now = () => this.t;
  setTimeout = (fn: () => void, ms: number) => {
    const id = ++this.seq;
    this.timers.push({ id, at: this.t + ms, fn });
    return id;
  };
  clearTimeout = (id: number) => {
    this.timers = this.timers.filter((timer) => timer.id !== id);
  };
  async advance(ms: number) {
    const end = this.t + ms;
    for (;;) {
      const due = this.timers
        .filter((timer) => timer.at <= end)
        .sort((a, b) => a.at - b.at)[0];
      if (!due) break;
      this.timers = this.timers.filter((timer) => timer !== due);
      this.t = Math.max(this.t, due.at);
      due.fn();
      await tick();
    }
    this.t = end;
    await tick();
  }
}

const tick = () => new Promise<void>((resolve) => setImmediate(resolve));

class FakeWindow {
  listeners = new Map<string, Set<(e: any) => void>>();
  ZIWO: any;
  info = new Subject();
  connection = new Subject();
  status = new Subject();
  log: { fn: string; args: any[] }[] = [];
  consoleLines: string[] = [];
  console: { error: (...args: any[]) => void } = {
    error: (...args: any[]) => {
      this.consoleLines.push(args.join(" "));
    },
  };
  startCallImpl: (n: string) => Promise<any> = async () => ({
    callId: "out-1",
  });
  loginImpl: (...a: any[]) => any = () => undefined;

  constructor() {
    const record =
      (fn: string) =>
      (...args: any[]) => {
        this.log.push({ fn, args });
      };
    this.ZIWO = {
      session: {
        info$: this.info,
        login: (...args: any[]) => {
          this.log.push({ fn: "login", args });
          return this.loginImpl(...args);
        },
        logout: () => {
          this.log.push({ fn: "logout", args: [] });
        },
      },
      calls: {
        connectionStatus$: this.connection,
        startCall: (number: string) => {
          this.log.push({ fn: "startCall", args: [number] });
          return this.startCallImpl(number);
        },
        clickToCall: record("clickToCall"),
        answerCall: record("answerCall"),
        rejectCall: record("rejectCall"),
        hangUpCall: record("hangUpCall"),
        muteCall: record("muteCall"),
        unMuteCall: record("unMuteCall"),
        holdCall: record("holdCall"),
        unHoldCall: record("unHoldCall"),
        sendDtmfCall: record("sendDtmfCall"),
        reconnect: record("reconnect"),
      },
      status: { status$: this.status },
    };
  }
  addEventListener(name: string, fn: (e: any) => void) {
    if (!this.listeners.has(name)) this.listeners.set(name, new Set());
    this.listeners.get(name)!.add(fn);
  }
  removeEventListener(name: string, fn: (e: any) => void) {
    this.listeners.get(name)?.delete(fn);
  }
  count(name = "ziwo-call-all") {
    return this.listeners.get(name)?.size ?? 0;
  }
  emit(detail: any) {
    [...(this.listeners.get("ziwo-call-all") ?? [])].forEach((fn) =>
      fn({ detail })
    );
  }
  calls(fn: string) {
    return this.log.filter((entry) => entry.fn === fn);
  }
}

function ev(type: string, callId: string, extra: Record<string, any> = {}) {
  return {
    type,
    call: {
      callId,
      primaryCallId: `p-${callId}`,
      direction: "outbound",
      participants: [{ number: extra.number ?? "+201001234567" }],
    },
    payload: { callId },
    ...(extra.cause ? { cause: extra.cause, causeCode: extra.causeCode } : {}),
  };
}

const SIGNED_IN = {
  tenant: "inchaa",
  token: "SECRET-SESSION-TOKEN",
  name: "Mahmoud Hussein",
  ccLogin: "x",
};

interface Harness {
  win: FakeWindow;
  clock: FakeClock;
  c: ZiwoController;
  posts: { method: string; args: Record<string, any> }[];
  persisted: number;
  postImpl: (method: string, args: Record<string, any>) => Promise<any>;
}

function setup(options: { signedIn?: boolean } = {}): Harness {
  const win = new FakeWindow();
  const clock = new FakeClock();
  const h: Harness = {
    win,
    clock,
    posts: [],
    persisted: 0,
    postImpl: async (method, args) => {
      if (method === "record_call_event") {
        return {
          event_created: true,
          call: {
            name: `n-${args.call_id}`,
            direction: args.direction,
            status: "Ringing",
            ticket: args.ticket ?? "",
            contact: "",
          },
          ...(args.ticket ? { origin_link: "linked" } : {}),
        };
      }
      if (method === "lookup_customer")
        return { contacts: [], tickets: [], requires_selection: false };
      return {};
    },
    c: undefined as any,
  };
  let n = 0;
  h.c = new ZiwoController({
    post: (method, args) => {
      h.posts.push({ method, args: { ...args } });
      return h.postImpl(method, args);
    },
    now: clock.now,
    uuid: () => `uuid-${++n}`,
    setTimeout: clock.setTimeout,
    clearTimeout: clock.clearTimeout,
    onPersisted: () => {
      h.persisted += 1;
    },
  });
  if (options.signedIn) win.info.next(SIGNED_IN);
  h.c.attach(win as any);
  return h;
}

const saved = (h: Harness) =>
  h.posts.filter((p) => p.method === "record_call_event");

// --- SDK readiness ---------------------------------------------------------------

test("the SDK is idle, then loading, then ready when attached", () => {
  const win = new FakeWindow();
  const c = new ZiwoController({ post: async () => ({}) });
  assert.equal(c.snapshot().sdk, "idle");
  c.setSdkLoading();
  assert.equal(c.snapshot().sdk, "loading");
  c.attach(win as any);
  assert.equal(c.snapshot().sdk, "ready");
});

test("a load failure is reported and blocks dialing and sign-in", async () => {
  const c = new ZiwoController({ post: async () => ({}) });
  c.setSdkFailed("The ZIWO softphone did not start.");
  assert.equal(c.snapshot().sdk, "failed");
  assert.equal((await c.dial("+971541482148")).ok, false);
  assert.equal((await c.login("inchaa", "a@b.c", "pw")).ok, false);
});

test("attaching twice or to a new window never leaves two listeners", () => {
  const first = new FakeWindow();
  const second = new FakeWindow();
  const c = new ZiwoController({ post: async () => ({}) });
  c.attach(first as any);
  c.attach(first as any);
  assert.equal(first.count(), 1);
  c.attach(second as any); // a reloaded frame
  assert.equal(first.count(), 0);
  assert.equal(second.count(), 1);
  c.dispose();
  assert.equal(second.count(), 0);
  assert.equal(second.info.subs.size, 0);
});

// --- sign-in ---------------------------------------------------------------------

test("sign-in is only confirmed by the session stream, however long it takes", async () => {
  const h = setup();
  const result = await h.c.login(
    "inchaa",
    "agent@example.com",
    "correct horse"
  );
  assert.deepEqual(result, { ok: true, pending: true });
  assert.equal(h.c.snapshot().session, "authenticating");
  await h.clock.advance(3000);
  assert.equal(h.c.snapshot().session, "authenticating"); // login() returning proved nothing
  h.win.info.next(SIGNED_IN);
  const snap = h.c.snapshot();
  assert.equal(snap.session, "signed-in");
  assert.equal(snap.agentName, "Mahmoud Hussein");
  assert.equal(snap.authError, "");
  assert.deepEqual(h.win.calls("login")[0]!.args, [
    "inchaa",
    "agent@example.com",
    "correct horse",
  ]);
});

test("a sign-in that is never confirmed times out visibly and can be retried", async () => {
  const h = setup();
  await h.c.login("inchaa", "agent@example.com", "wrong");
  await h.clock.advance(LOGIN_TIMEOUT_MS - 1);
  assert.equal(h.c.snapshot().session, "authenticating");
  await h.clock.advance(2);
  const snap = h.c.snapshot();
  assert.equal(snap.session, "signed-out");
  assert.match(snap.authError, /did not confirm the sign-in within 25 seconds/);
  assert.equal(
    (await h.c.login("inchaa", "agent@example.com", "right")).ok,
    true
  );
  assert.equal(h.win.calls("login").length, 2);
});

test("a late confirmation after the timeout is still accepted", async () => {
  const h = setup();
  await h.c.login("inchaa", "agent@example.com", "pw");
  await h.clock.advance(LOGIN_TIMEOUT_MS + 1);
  h.win.info.next(SIGNED_IN);
  assert.equal(h.c.snapshot().session, "signed-in");
});

test("a login that throws fails at once", async () => {
  const h = setup();
  h.win.loginImpl = () => {
    throw new Error("Account not found");
  };
  const result = await h.c.login("inchaa", "agent@example.com", "pw");
  assert.equal(result.ok, false);
  assert.equal(h.c.snapshot().session, "signed-out");
  assert.match(h.c.snapshot().authError, /Account not found/);
});

test("a restored session is recognised without signing in again", async () => {
  const h = setup({ signedIn: true });
  assert.equal(h.c.snapshot().session, "signed-in");
  assert.equal((await h.c.login("inchaa", "agent@example.com", "pw")).ok, true);
  assert.equal(h.win.calls("login").length, 0);
});

test("an account name that is a host name or URL is refused before the SDK is called", async () => {
  const h = setup();
  for (const bad of [
    "inchaa-api.aswat.co:8082",
    "https://inchaa.ziwo.io",
    "in chaa",
    "",
  ]) {
    assert.equal((await h.c.login(bad, "a@b.c", "pw")).ok, false, bad);
  }
  assert.equal((await h.c.login("inchaa", "", "pw")).ok, false);
  assert.equal((await h.c.login("inchaa", "a@b.c", "")).ok, false);
  assert.equal(h.win.calls("login").length, 0);
});

function ownValues(
  value: any,
  skip: Set<any>,
  seen = new Set<any>(),
  out: string[] = []
): string[] {
  if (
    value === null ||
    typeof value !== "object" ||
    seen.has(value) ||
    skip.has(value)
  )
    return out;
  seen.add(value);
  const entries =
    value instanceof Map
      ? [...value.values()]
      : value instanceof Set
      ? [...value]
      : Object.values(value);
  for (const item of entries) {
    if (typeof item === "string") out.push(item);
    else ownValues(item, skip, seen, out);
  }
  return out;
}

test("the password and the session token are never kept or exposed", async () => {
  const h = setup();
  await h.c.login("inchaa", "agent@example.com", "hunter2-secret");
  h.win.info.next(SIGNED_IN);
  const snapshotText = JSON.stringify(h.c.snapshot());
  assert.equal(snapshotText.includes("hunter2-secret"), false);
  assert.equal(snapshotText.includes("SECRET-SESSION-TOKEN"), false);
  // Everything the controller itself holds, apart from the SDK window it was handed.
  const held = ownValues(
    h.c,
    new Set<any>([h.win, (h.c as any).deps, (h.c as any).handler])
  );
  assert.equal(
    held.some((text) => text.includes("hunter2-secret")),
    false
  );
  assert.equal(
    held.some((text) => text.includes("SECRET-SESSION-TOKEN")),
    false
  );
  // Nothing sent to Helpdesk contains either.
  h.win.emit(ev("requesting", "c1"));
  await tick();
  assert.equal(JSON.stringify(h.posts).includes("hunter2-secret"), false);
  assert.equal(JSON.stringify(h.posts).includes("SECRET-SESSION-TOKEN"), false);
});

test("a deliberate sign-out is quiet; an unexpected end of session is reported", async () => {
  const h = setup({ signedIn: true });
  assert.equal(h.c.logout().ok, true);
  h.win.info.next(undefined);
  let snap = h.c.snapshot();
  assert.equal(snap.session, "signed-out");
  assert.equal(snap.expired, false);
  assert.equal(snap.authError, "");

  h.win.info.next(SIGNED_IN);
  h.win.info.next(undefined); // not initiated by us
  snap = h.c.snapshot();
  assert.equal(snap.session, "signed-out");
  assert.equal(snap.expired, true);
  assert.match(snap.authError, /session ended/);
});

test("when the session ends mid-call the call is marked unconfirmed and no longer blocks dialing", async () => {
  const h = setup({ signedIn: true });
  h.win.emit(ev("requesting", "out-1"));
  h.win.emit(ev("active", "out-1"));
  await tick();
  assert.equal(h.c.snapshot().liveCall?.callId, "out-1");
  h.win.info.next(undefined);
  const call = h.c.snapshot().calls[0]!;
  assert.equal(call.status, "ended");
  assert.equal(call.endUnconfirmed, true);
  h.win.info.next(SIGNED_IN);
  assert.equal((await h.c.dial("+971541482148")).ok, true);
});

test("the connection stream is shown and a reconnect uses the documented method", () => {
  const h = setup({ signedIn: true });
  h.win.connection.next("notConnected");
  assert.equal(h.c.snapshot().connection, "disconnected");
  h.win.connection.next("connected");
  assert.equal(h.c.snapshot().connection, "connected");
  assert.equal(h.c.reconnect().ok, true);
  assert.equal(h.win.calls("reconnect").length, 1);
});

// --- one outbound dispatch ---------------------------------------------------------

test("repeated clicks place exactly one call, as a string, through startCall only", async () => {
  const h = setup({ signedIn: true });
  let release: (v: any) => void = () => {};
  h.win.startCallImpl = () => new Promise((resolve) => (release = resolve));
  const first = h.c.dial("+971 54 148 2148", { ticket: "T-1" });
  const second = await h.c.dial("+971541482148", { ticket: "T-1" });
  const third = await h.c.dial("+971541482148");
  assert.equal(second.ok, false);
  assert.equal(third.ok, false);
  release({ callId: "out-1" });
  await first;
  assert.equal(h.win.calls("startCall").length, 1);
  assert.deepEqual(h.win.calls("startCall")[0]!.args, ["+971541482148"]);
  assert.equal(typeof h.win.calls("startCall")[0]!.args[0], "string");
  assert.equal(h.win.calls("clickToCall").length, 0);
  // A further click while that call is live is refused too.
  assert.equal((await h.c.dial("+971541482148")).ok, false);
  assert.equal(h.win.calls("startCall").length, 1);
});

test("a rejected dispatch is never retried through another method and blocks redialing until confirmed", async () => {
  const h = setup({ signedIn: true });
  h.win.startCallImpl = async () => {
    throw new Error("Microphone is not available");
  };
  const result = await h.c.dial("+971541482148");
  assert.equal(result.ok, false);
  assert.match(result.error!, /Microphone/);
  assert.equal(h.win.calls("clickToCall").length, 0);
  assert.equal(h.win.calls("startCall").length, 1);
  // Still guarded: the attempt may have reached ZIWO.
  assert.equal((await h.c.dial("+971541482148")).ok, false);
  assert.equal(h.win.calls("startCall").length, 1);
  await h.clock.advance(REJECT_CONFIRM_MS + 1);
  assert.match(h.c.snapshot().dialError, /Microphone/);
  assert.equal(h.c.snapshot().intent, null);
  // A new, deliberate action may dial again.
  h.win.startCallImpl = async () => ({ callId: "out-2" });
  assert.equal((await h.c.dial("+971541482148")).ok, true);
  assert.equal(h.win.calls("startCall").length, 2);
  assert.equal(h.win.calls("clickToCall").length, 0);
});

test("a rejection followed by a real outbound event is recognised as a call, not a failure", async () => {
  const h = setup({ signedIn: true });
  h.win.startCallImpl = async () => {
    throw new Error("timeout");
  };
  await h.c.dial("+201001234567", { ticket: "T-9" });
  h.win.emit(ev("requesting", "late-1", { number: "+201001234567" }));
  await tick();
  const call = h.c.snapshot().calls[0]!;
  assert.equal(call.callId, "late-1");
  assert.equal(call.originTicket, "T-9");
  assert.equal(h.c.snapshot().intent, null);
  assert.equal(h.c.snapshot().dialError, "");
});

test("an unconfirmed dispatch becomes uncertain, blocks redialing, and needs a deliberate confirmation", async () => {
  const h = setup({ signedIn: true });
  h.win.startCallImpl = async () => undefined; // resolves with no call id
  await h.c.dial("+971541482148");
  assert.equal(h.c.snapshot().intent?.state, "awaiting-event");
  await h.clock.advance(DISPATCH_WAIT_MS + 1);
  assert.equal(h.c.snapshot().intent?.state, "uncertain");
  const blocked = await h.c.dial("+971541482148");
  assert.equal(blocked.ok, false);
  assert.match(blocked.error!, /not confirmed/);
  assert.equal(h.win.calls("startCall").length, 1);
  h.c.acknowledgeUncertain();
  assert.equal((await h.c.dial("+971541482148")).ok, true);
  assert.equal(h.win.calls("startCall").length, 2);
});

test("a late event settles an uncertain dispatch", async () => {
  const h = setup({ signedIn: true });
  h.win.startCallImpl = async () => undefined;
  await h.c.dial("+971541482148", { ticket: "T-2" });
  await h.clock.advance(DISPATCH_WAIT_MS + 1);
  h.win.emit(ev("trying", "c9", { number: "+971541482148" }));
  await tick();
  assert.equal(h.c.snapshot().intent, null);
  assert.equal(h.c.snapshot().calls[0]!.originTicket, "T-2");
});

test("an outbound call placed some other way is not attributed to the ticket we dialed from", async () => {
  const h = setup({ signedIn: true });
  h.win.startCallImpl = async () => undefined;
  await h.c.dial("+971541482148", { ticket: "T-3" });
  h.win.emit(ev("requesting", "elsewhere", { number: "+20 100 999 8888" }));
  await tick();
  assert.equal(h.c.snapshot().calls[0]!.originTicket, "");
  assert.equal(h.c.snapshot().intent?.state, "awaiting-event");
});

test("a number that is not a phone number never reaches the SDK", async () => {
  const h = setup({ signedIn: true });
  for (const bad of ["", "abc", "12", "+97 1x"]) {
    assert.equal((await h.c.dial(bad)).ok, false, bad);
  }
  assert.equal(h.win.calls("startCall").length, 0);
});

// --- controls by call id ------------------------------------------------------------

test("answer, reject and hang up always name the call they act on", async () => {
  const h = setup({ signedIn: true });
  h.win.emit(ev("ringing", "in-1", { number: "+201005550001" }));
  h.win.emit(ev("ringing", "in-2", { number: "+201005550002" }));
  await tick();
  assert.equal(h.c.answer("in-2").ok, true);
  assert.deepEqual(
    h.win.calls("answerCall").map((c) => c.args),
    [["in-2"]]
  );
  assert.equal(h.c.reject("in-1").ok, true);
  assert.deepEqual(
    h.win.calls("rejectCall").map((c) => c.args),
    [["in-1"]]
  );
  h.win.emit(ev("active", "in-2"));
  assert.equal(h.c.hangup("in-2").ok, true);
  assert.deepEqual(
    h.win.calls("hangUpCall").map((c) => c.args),
    [["in-2"]]
  );
});

test("controls refuse calls they do not apply to and never invent an id", async () => {
  const h = setup({ signedIn: true });
  assert.equal(h.c.hangup("nope").ok, false);
  assert.equal(h.c.answer("nope").ok, false);
  h.win.emit(ev("requesting", "out-1"));
  assert.equal(h.c.answer("out-1").ok, false); // outbound: nothing to answer
  assert.equal(h.c.reject("out-1").ok, false);
  h.win.emit(ev("hangup", "out-1"));
  assert.equal(h.c.hangup("out-1").ok, false); // already ended
  assert.equal(
    h.win.calls("answerCall").length + h.win.calls("rejectCall").length,
    0
  );
  assert.equal(h.win.calls("hangUpCall").length, 0);
});

test("mute and hold follow the call's reported state and use the call id", async () => {
  const h = setup({ signedIn: true });
  h.win.emit(ev("ringing", "c1"));
  h.win.emit(ev("active", "c1"));
  assert.equal(h.c.toggleMute("c1").ok, true);
  h.win.emit(ev("mute", "c1"));
  assert.equal(h.c.snapshot().calls[0]!.muted, true);
  assert.equal(h.c.toggleMute("c1").ok, true);
  assert.deepEqual(
    h.win.calls("muteCall").map((c) => c.args),
    [["c1"]]
  );
  assert.deepEqual(
    h.win.calls("unMuteCall").map((c) => c.args),
    [["c1"]]
  );
  h.c.toggleHold("c1");
  h.win.emit(ev("held", "c1"));
  h.c.toggleHold("c1");
  assert.deepEqual(
    h.win.calls("holdCall").map((c) => c.args),
    [["c1"]]
  );
  assert.deepEqual(
    h.win.calls("unHoldCall").map((c) => c.args),
    [["c1"]]
  );
  // Audit events change the screen, not the server.
  await tick();
  assert.equal(
    saved(h).filter((p) => ["mute", "held"].includes(p.args.event_type)).length,
    0
  );
});

// --- direction and context through a call --------------------------------------------

test("an inbound call keeps its direction through ringing, active and hangup", async () => {
  const h = setup({ signedIn: true });
  h.win.emit(ev("ringing", "in-1"));
  h.win.emit(ev("active", "in-1"));
  h.win.emit(ev("hangup", "in-1", { cause: "NORMAL_CLEARING", causeCode: 16 }));
  await tick();
  await tick();
  assert.deepEqual(
    saved(h).map((p) => [p.args.event_type, p.args.direction]),
    [
      ["ringing", "Inbound"],
      ["active", "Inbound"],
      ["hangup", "Inbound"],
    ]
  );
  assert.equal(saved(h)[2]!.args.cause, "NORMAL_CLEARING");
  assert.equal(saved(h)[2]!.args.cause_code, "16");
  assert.equal(h.c.snapshot().calls[0]!.direction, "Inbound");
});

test("an outbound call keeps its direction through active and hangup", async () => {
  const h = setup({ signedIn: true });
  await h.c.dial("+201001234567");
  h.win.emit(ev("requesting", "out-1"));
  h.win.emit(ev("active", "out-1"));
  h.win.emit(ev("hangup", "out-1"));
  await tick();
  await tick();
  assert.deepEqual(
    saved(h).map((p) => p.args.direction),
    ["Outbound", "Outbound", "Outbound"]
  );
});

test("a recovered call starts Unknown and adopts the server's direction for the rest of the call", async () => {
  const h = setup({ signedIn: true });
  h.postImpl = async (method, args) =>
    method === "record_call_event"
      ? {
          event_created: true,
          call: {
            direction: "Inbound",
            ticket: "",
            contact: "",
            status: "Active",
          },
        }
      : { contacts: [], tickets: [], requires_selection: false };
  h.win.emit(ev("attach", "re-1"));
  await tick();
  assert.equal(saved(h)[0]!.args.direction, "Unknown");
  h.win.emit(ev("active", "re-1"));
  h.win.emit(ev("hangup", "re-1"));
  await tick();
  await tick();
  assert.deepEqual(
    saved(h).map((p) => p.args.direction),
    ["Unknown", "Inbound", "Inbound"]
  );
  assert.equal(h.c.snapshot().calls[0]!.recovered, true);
});

test("recovery and reconnect events do not create duplicate calls", async () => {
  const h = setup({ signedIn: true });
  h.win.emit(ev("ringing", "in-1"));
  h.win.emit(ev("active", "in-1"));
  h.win.emit(ev("recovering", "in-1"));
  h.win.emit(ev("attach", "in-1"));
  h.win.emit(ev("attach", "in-1"));
  await tick();
  assert.equal(h.c.snapshot().calls.length, 1);
  assert.equal(h.c.snapshot().liveCall?.callId, "in-1");
  assert.equal(h.win.count(), 1);
});

test("a repeated lifecycle event is sent once", async () => {
  const h = setup({ signedIn: true });
  h.win.emit(ev("ringing", "in-1"));
  h.win.emit(ev("ringing", "in-1"));
  h.win.emit(ev("active", "in-1"));
  h.win.emit(ev("active", "in-1"));
  await tick();
  await tick();
  assert.deepEqual(
    saved(h).map((p) => p.args.event_type),
    ["ringing", "active"]
  );
});

test("the ticket the agent dialed from stays attached however the screen changes", async () => {
  const h = setup({ signedIn: true });
  // The ticket is captured at dispatch. The controller has no notion of 'current ticket'.
  h.postImpl = async (method, args) =>
    method === "record_call_event"
      ? {
          event_created: true,
          call: {
            direction: "Outbound",
            ticket: "",
            contact: "",
            status: "Ringing",
          },
        }
      : { contacts: [], tickets: [], requires_selection: false };
  await h.c.dial("+201001234567", { ticket: "T-1" });
  h.win.emit(ev("requesting", "out-1"));
  await tick();
  h.win.emit(ev("trying", "out-1")); // the agent has navigated elsewhere by now
  h.win.emit(ev("active", "out-1"));
  h.win.emit(ev("hangup", "out-1"));
  await tick();
  await tick();
  await tick();
  assert.equal(
    saved(h).every((p) => p.args.ticket === "T-1"),
    true
  );
  assert.equal(h.c.snapshot().calls[0]!.originTicket, "T-1");
  // A second call dialed later from another ticket is its own, separate association.
  h.postImpl = async (method, args) =>
    method === "record_call_event"
      ? {
          event_created: true,
          call: {
            direction: "Outbound",
            ticket: args.ticket ?? "",
            contact: "",
            status: "Ringing",
          },
        }
      : { contacts: [], tickets: [], requires_selection: false };
  h.win.startCallImpl = async () => ({ callId: "out-2" });
  await h.c.dial("+201009998888", { ticket: "T-2" });
  h.win.emit(ev("requesting", "out-2", { number: "+201009998888" }));
  await tick();
  const second = h.c.snapshot().calls.find((c) => c.callId === "out-2")!;
  const first = h.c.snapshot().calls.find((c) => c.callId === "out-1")!;
  assert.equal(second.originTicket, "T-2");
  assert.equal(first.originTicket, "T-1");
});

test("the ticket hint stops once the server holds the link, and stops if the server refuses it", async () => {
  const h = setup({ signedIn: true });
  await h.c.dial("+201001234567", { ticket: "T-1" });
  h.win.emit(ev("requesting", "out-1"));
  await tick();
  assert.equal(saved(h)[0]!.args.ticket, "T-1");
  assert.equal(h.c.snapshot().calls[0]!.ticket, "T-1"); // the server confirmed it
  h.win.emit(ev("active", "out-1"));
  await tick();
  assert.equal("ticket" in saved(h)[1]!.args, false);

  // A refusal is shown and the hint is not repeated.
  const g = setup({ signedIn: true });
  g.postImpl = async (method) =>
    method === "record_call_event"
      ? {
          event_created: true,
          call: {
            direction: "Outbound",
            ticket: "",
            contact: "",
            status: "Ringing",
          },
          origin_link: "not_permitted",
        }
      : { contacts: [], tickets: [], requires_selection: false };
  await g.c.dial("+201001234567", { ticket: "T-7" }); // the fake startCall answers with call id out-1
  g.win.emit(ev("requesting", "out-1"));
  await tick();
  assert.equal(g.c.snapshot().calls[0]!.originError, "not_permitted");
  g.win.emit(ev("active", "out-1"));
  await tick();
  assert.equal("ticket" in saved(g)[1]!.args, false);
});

test("a lost first event does not lose the originating ticket", async () => {
  const h = setup({ signedIn: true });
  let failFirst = true;
  h.postImpl = async (method, args) => {
    if (method === "record_call_event") {
      if (failFirst) {
        failFirst = false;
        throw Object.assign(new Error("offline"), { httpStatus: 0 });
      }
      return {
        event_created: true,
        call: {
          direction: "Outbound",
          ticket: args.ticket ?? "",
          contact: "",
          status: "Active",
        },
      };
    }
    return { contacts: [], tickets: [], requires_selection: false };
  };
  await h.c.dial("+201001234567", { ticket: "T-5" });
  h.win.emit(ev("requesting", "out-1"));
  await tick();
  await h.clock.advance(1100); // the automatic retry
  assert.equal(h.c.snapshot().unsaved.count, 0);
  assert.equal(h.c.snapshot().calls[0]!.ticket, "T-5");
});

// --- saving events ----------------------------------------------------------------------

test("an event that cannot be saved is shown, retried automatically, and cleared once saved", async () => {
  const h = setup({ signedIn: true });
  let up = false;
  h.postImpl = async (method) => {
    if (method === "record_call_event") {
      if (!up) throw new TypeError("Failed to fetch");
      return {
        event_created: true,
        call: {
          direction: "Inbound",
          ticket: "",
          contact: "",
          status: "Ringing",
        },
      };
    }
    return { contacts: [], tickets: [], requires_selection: false };
  };
  h.win.emit(ev("ringing", "in-1"));
  await tick();
  let snap = h.c.snapshot();
  assert.equal(snap.unsaved.count, 1);
  assert.match(snap.unsaved.error, /Failed to fetch/);
  assert.equal(h.persisted, 0);
  up = true;
  await h.clock.advance(1100);
  snap = h.c.snapshot();
  assert.equal(snap.unsaved.count, 0);
  assert.equal(h.persisted, 1);
  assert.equal(snap.calls[0]!.saved, true);
});

test("the same event is retried with the same client id so the server can deduplicate it", async () => {
  const h = setup({ signedIn: true });
  let attempts = 0;
  h.postImpl = async (method) => {
    if (method === "record_call_event") {
      attempts += 1;
      if (attempts < 3) throw new TypeError("Failed to fetch");
      return {
        event_created: true,
        call: {
          direction: "Inbound",
          ticket: "",
          contact: "",
          status: "Ringing",
        },
      };
    }
    return { contacts: [], tickets: [], requires_selection: false };
  };
  h.win.emit(ev("ringing", "in-1"));
  await tick();
  await h.clock.advance(1100);
  await h.clock.advance(3100);
  const ids = new Set(saved(h).map((p) => p.args.client_event_id));
  assert.equal(saved(h).length, 3);
  assert.equal(ids.size, 1);
  assert.equal(h.c.snapshot().unsaved.count, 0);
});

test("a permanent refusal stays visible, is not retried on its own, and can be retried by hand", async () => {
  const h = setup({ signedIn: true });
  let allow = false;
  h.postImpl = async (method) => {
    if (method === "record_call_event") {
      if (!allow)
        throw Object.assign(
          new Error("Only an active support agent may use ZIWO."),
          { exc_type: "PermissionError", httpStatus: 403 }
        );
      return {
        event_created: true,
        call: {
          direction: "Inbound",
          ticket: "",
          contact: "",
          status: "Ringing",
        },
      };
    }
    return { contacts: [], tickets: [], requires_selection: false };
  };
  h.win.emit(ev("ringing", "in-1"));
  await tick();
  await h.clock.advance(120000);
  assert.equal(saved(h).length, 1); // not hammered
  const snap = h.c.snapshot();
  assert.equal(snap.unsaved.count, 1);
  assert.equal(snap.unsaved.permanent, 1);
  allow = true;
  h.c.retryUnsaved();
  await tick();
  await tick();
  assert.equal(h.c.snapshot().unsaved.count, 0);
});

test("unsaved events do not stop later events from being saved", async () => {
  const h = setup({ signedIn: true });
  let calls = 0;
  h.postImpl = async (method, args) => {
    if (method === "record_call_event") {
      calls += 1;
      if (args.event_type === "ringing" && calls === 1)
        throw new TypeError("Failed to fetch");
      return {
        event_created: true,
        call: {
          direction: "Inbound",
          ticket: "",
          contact: "",
          status: "Active",
        },
      };
    }
    return { contacts: [], tickets: [], requires_selection: false };
  };
  h.win.emit(ev("ringing", "in-1"));
  h.win.emit(ev("active", "in-1"));
  await tick();
  await tick();
  assert.equal(h.c.snapshot().unsaved.count, 1); // only the ringing event is waiting
  await h.clock.advance(1100);
  assert.equal(h.c.snapshot().unsaved.count, 0);
});

test("events are saved in the order they happened", async () => {
  const h = setup({ signedIn: true });
  h.win.emit(ev("requesting", "out-1"));
  h.win.emit(ev("active", "out-1"));
  h.win.emit(ev("hangup", "out-1"));
  await tick();
  await tick();
  await tick();
  assert.deepEqual(
    saved(h).map((p) => p.args.event_type),
    ["requesting", "active", "hangup"]
  );
});

test("a lifecycle event without a call id is counted as unparsed, but benign events are not", () => {
  const h = setup({ signedIn: true });
  h.win.emit({ type: "ready" });
  h.win.emit({ type: "mute", payload: {} });
  assert.equal(h.c.snapshot().unparsedEvents, 0);
  h.win.emit({ type: "active", payload: {} });
  assert.equal(h.c.snapshot().unparsedEvents, 1);
  assert.match(h.c.snapshot().lastEventShape, /type=active/);
  assert.equal(saved(h).length, 0);
});

// --- explicit links -------------------------------------------------------------------------

test("linking a ticket or choosing a contact is explicit, saved on the server, and refreshes history", async () => {
  const h = setup({ signedIn: true });
  h.postImpl = async (method, args) => {
    if (method === "record_call_event")
      return {
        event_created: true,
        call: {
          name: "log-in-1",
          direction: "Inbound",
          ticket: "",
          contact: "",
          status: "Ringing",
        },
      };
    if (method === "link_saved_call")
      return {
        call: { ticket: args.ticket, contact: "CONTACT-1", name: "log-in-1" },
        ticket: { name: args.ticket, subject: "Leak", status: "Open" },
      };
    if (method === "set_saved_contact")
      return { contact: args.contact, name: "log-in-1" };
    if (method === "get_call_ticket_panel")
      return { call_log: "log-in-1", linked: false, tickets: [], contacts: [], fields: [] };
    return { contacts: [], tickets: [], requires_selection: false };
  };
  h.win.emit(ev("ringing", "in-1"));
  await tick();
  const before = h.persisted;
  assert.equal(
    (await h.c.linkTicket("in-1", "T-77", { callLog: "log-in-1" })).ok,
    true
  );
  assert.equal(h.c.snapshot().calls[0]!.ticket, "T-77");
  assert.equal(h.c.snapshot().calls[0]!.contact, "CONTACT-1");
  assert.equal(h.persisted, before + 1);
  assert.equal(
    (await h.c.chooseContact("in-1", "CONTACT-2", { callLog: "log-in-1" })).ok,
    true
  );
  assert.equal(h.c.snapshot().calls[0]!.contact, "CONTACT-2");
  assert.deepEqual(
    h.posts.filter((p) => p.method === "link_saved_call")[0]!.args,
    { call_log: "log-in-1", ticket: "T-77" }
  );
  assert.deepEqual(
    h.posts.filter((p) => p.method === "set_saved_contact")[0]!.args,
    { call_log: "log-in-1", contact: "CONTACT-2" }
  );
});

test("a refused link is reported and changes nothing", async () => {
  const h = setup({ signedIn: true });
  h.postImpl = async (method) => {
    if (method === "record_call_event")
      return {
        event_created: true,
        call: {
          name: "log-in-1",
          direction: "Inbound",
          ticket: "",
          contact: "",
          status: "Ringing",
        },
      };
    if (method === "link_saved_call")
      throw Object.assign(
        new Error("This ticket belongs to a different contact"),
        { exc_type: "ValidationError", httpStatus: 417 }
      );
    if (method === "get_call_ticket_panel")
      return { call_log: "log-in-1", linked: false, tickets: [], contacts: [], fields: [] };
    return { contacts: [], tickets: [], requires_selection: false };
  };
  h.win.emit(ev("ringing", "in-1"));
  await tick();
  const result = await h.c.linkTicket("in-1", "T-1", { callLog: "log-in-1" });
  assert.equal(result.ok, false);
  assert.match(result.error!, /different contact/);
  assert.equal(h.c.snapshot().calls[0]!.ticket, "");
});

test("linking before the call is saved says so instead of failing silently", async () => {
  const h = setup({ signedIn: true });
  h.postImpl = async (method) => {
    if (method === "record_call_event") throw new TypeError("Failed to fetch");
    return { contacts: [], tickets: [], requires_selection: false };
  };
  h.win.emit(ev("ringing", "in-1"));
  await tick();
  const result = await h.c.linkTicket("in-1", "T-1");
  assert.equal(result.ok, false);
  assert.match(result.error!, /not saved in Helpdesk yet/);
});

test("the customer lookup runs once per call and a failure does not break the call", async () => {
  const h = setup({ signedIn: true });
  h.postImpl = async (method) => {
    if (method === "lookup_customer") throw new Error("lookup failed");
    return {
      event_created: true,
      call: {
        direction: "Inbound",
        ticket: "",
        contact: "",
        status: "Ringing",
      },
    };
  };
  h.win.emit(ev("ringing", "in-1"));
  h.win.emit(ev("active", "in-1"));
  await tick();
  await tick();
  assert.equal(h.posts.filter((p) => p.method === "lookup_customer").length, 1);
  assert.equal(h.c.snapshot().calls[0]!.lookupError, "lookup failed");
  assert.equal(h.c.snapshot().calls[0]!.status, "active");
});

// --- the plugin's own failure reports --------------------------------------------------------

const REJECTED =
  "[3:05:08 PM] Error Code: 401, Message: Http failure response for https://inchaa-api.aswat.co/auth/login: 401 OK";
const SSO_CORS =
  "Access to XMLHttpRequest at 'https://directory.ziwo.co/v1/account' from origin 'https://x' has been blocked by CORS policy";

test("a rejected sign-in is reported at once, not after the timeout, and says what to do", async () => {
  const h = setup();
  await h.c.login("inchaa", "agent@example.com", "wrong");
  assert.equal(h.c.snapshot().session, "authenticating");
  h.win.ZIWO.__ignored = true;
  h.win.console.error(REJECTED); // the plugin logs the reason; the controller is listening
  const snap = h.c.snapshot();
  assert.equal(snap.session, "signed-out");
  assert.match(snap.authError, /rejected this email or password \(HTTP 401\)/);
  assert.match(snap.authError, /single sign-on/);
  assert.deepEqual(snap.sdkMessages, [REJECTED.replace(/\s+/g, " ")]);
  // The timeout that would have said "did not confirm" is gone, so it cannot overwrite the reason.
  await h.clock.advance(LOGIN_TIMEOUT_MS + 1000);
  assert.match(h.c.snapshot().authError, /rejected this email or password/);
  // And the agent can simply try again.
  assert.equal(
    (await h.c.login("inchaa", "agent@example.com", "right")).ok,
    true
  );
});

test("an unknown account name is reported as such", async () => {
  const h = setup();
  await h.c.login("nope", "agent@example.com", "pw");
  h.win.console.error(
    "Error Code: 404, Message: Http failure response for https://nope-api.aswat.co/info: 404 Not Found"
  );
  assert.match(
    h.c.snapshot().authError,
    /does not recognise this account name/
  );
  assert.equal(h.c.snapshot().session, "signed-out");
});

test("the single-sign-on lookup's CORS error is recorded but never fails a sign-in", async () => {
  const h = setup();
  await h.c.login("inchaa", "agent@example.com", "pw");
  h.win.console.error(SSO_CORS);
  h.win.console.error(
    "Error Code: 0, Message: Http failure response for https://directory.ziwo.co/v1/account: 0 Unknown Error"
  );
  assert.equal(h.c.snapshot().session, "authenticating");
  assert.equal(h.c.snapshot().authError, "");
  assert.equal(h.c.snapshot().sdkMessages.length, 2);
  h.win.info.next(SIGNED_IN);
  assert.equal(h.c.snapshot().session, "signed-in");
});

test("a failure line outside a sign-in attempt changes nothing but the diagnostic list", async () => {
  const h = setup({ signedIn: true });
  h.win.console.error(REJECTED);
  const snap = h.c.snapshot();
  assert.equal(snap.session, "signed-in");
  assert.equal(snap.authError, "");
  assert.equal(snap.sdkMessages.length, 1);
});

test("the plugin's console still receives every line, and only a bounded list is kept", () => {
  const h = setup();
  for (let i = 0; i < 9; i++)
    h.win.console.error(
      `Error Code: 500, Message: Http failure response for https://x/y${i}: 500`
    );
  h.win.console.error("an unrelated error nobody asked about");
  assert.equal(h.win.consoleLines.length, 10); // nothing was swallowed
  assert.equal(h.c.snapshot().sdkMessages.length, 5);
});

test("the console is wrapped once, and put back on detach or reattach", () => {
  const win = new FakeWindow();
  const original = win.console.error;
  const c = new ZiwoController({ post: async () => ({}) });
  c.attach(win as any);
  const tapped = win.console.error;
  assert.notEqual(tapped, original);
  c.attach(win as any); // a second attach must not stack a second wrapper
  win.console.error(REJECTED);
  assert.equal(win.consoleLines.length, 1, "forwarded exactly once");
  c.detach();
  assert.equal(win.console.error, original, "restored");
  c.attach(win as any);
  c.dispose();
  assert.equal(win.console.error, original, "restored after dispose");
});

test("a faulty log line can never break the plugin's own logging", () => {
  const win = new FakeWindow();
  const c = new ZiwoController({
    post: async () => ({}),
    onChange: () => {
      throw new Error("listener bug");
    },
  });
  c.attach(win as any);
  assert.doesNotThrow(() => win.console.error(REJECTED));
  assert.equal(win.consoleLines.length, 1);
});

test("creating a ticket uses the saved call log name and keeps the agent on the call", async () => {
  const h = setup({ signedIn: true });
  let creates = 0;
  h.postImpl = async (method, args) => {
    if (method === "record_call_event")
      return {
        event_created: true,
        call: {
          name: "log-in-1",
          direction: "Inbound",
          ticket: "",
          contact: "",
          status: "Active",
        },
      };
    if (method === "create_call_ticket") {
      creates += 1;
      return {
        created: creates === 1,
        call: { name: "log-in-1", ticket: "T-9", contact: "C-1" },
        ticket: { name: "T-9", subject: args.subject, status: "Open" },
      };
    }
    if (method === "get_call_ticket_panel")
      return {
        call_log: "log-in-1",
        linked: true,
        link_source: "Agent selection",
        ticket: { name: "T-9", subject: "Leak", status: "Open" },
        tickets: [],
        contacts: [],
        fields: [],
      };
    return { contacts: [], tickets: [], requires_selection: false };
  };
  h.win.emit(ev("ringing", "in-1"));
  await tick();
  const first = await h.c.createTicket(
    "in-1",
    { subject: "Leak", description: "Under the sink" },
    { callLog: "log-in-1" }
  );
  const second = await h.c.createTicket(
    "in-1",
    { subject: "Leak again", description: "Under the sink" },
    { callLog: "log-in-1" }
  );
  assert.equal(first.ok, true);
  assert.equal(second.ok, true);
  assert.equal(h.c.snapshot().calls[0]!.ticket, "T-9");
  assert.equal(creates, 2); // the server, not the client, collapses the retry
  const posted = h.posts.filter((p) => p.method === "create_call_ticket");
  assert.equal(posted.length, 2);
  assert.deepEqual(posted[0]!.args.call_log, "log-in-1");
  assert.deepEqual(posted[1]!.args.call_log, "log-in-1");
});

test("an unknown caller search is sent for the saved call and a missing call is explained", async () => {
  const h = setup({ signedIn: true });
  h.postImpl = async (method) => {
    if (method === "record_call_event") throw new TypeError("Failed to fetch");
    if (method === "search_call_tickets")
      return { tickets: [{ name: "T-3", subject: "Pump", status: "Open" }] };
    return {};
  };
  h.win.emit(ev("ringing", "in-1"));
  await tick();
  const blocked = await h.c.searchTickets("in-1", "pump");
  assert.equal(blocked.ok, false);
  assert.match(blocked.error!, /not saved in Helpdesk yet/);
  assert.equal(
    h.posts.filter((p) => p.method === "search_call_tickets").length,
    0
  );
  const created = await h.c.createTicket("in-1", {
    subject: "Leak",
    description: "Under the sink",
  });
  assert.equal(created.ok, false);
  assert.match(created.error!, /not saved in Helpdesk yet/);
});

test("availability is the string ZIWO reports, and a session object is ignored", async () => {
  const h = setup({ signedIn: true });
  assert.equal(h.win.count("ziwo-status-update"), 1);
  assert.equal(h.win.status.subs.size, 1);
  h.c.attach(h.win);
  assert.equal(h.win.count("ziwo-status-update"), 1);
  assert.equal(h.win.status.subs.size, 1);
  h.win.status.next("Available");
  assert.equal(h.c.snapshot().ziwoStatus, "Available");
  h.win.status.next({ status: "On Break", token: "SECRET-SESSION-TOKEN" });
  assert.equal(h.c.snapshot().ziwoStatus, "Available");
  assert.equal(JSON.stringify(h.c.snapshot()).includes("SECRET-SESSION-TOKEN"), false);
  h.win.listeners.get("ziwo-status-update")!.forEach((fn) =>
    fn({ detail: "On Break" })
  );
  assert.equal(h.c.snapshot().ziwoStatus, "On Break");
  h.c.detach();
  assert.equal(h.win.count("ziwo-status-update"), 0);
  assert.equal(h.win.status.subs.size, 0);
});

test("DTMF uses the agent leg id and a second answer click does not fire twice", async () => {
  const h = setup({ signedIn: true });
  h.win.emit(ev("ringing", "leg-1", { number: "+971501112233" }));
  h.win.emit(ev("active", "leg-1"));
  await tick();
  assert.equal(h.c.sendDtmf("leg-1", "1*").ok, true);
  assert.deepEqual(h.win.calls("sendDtmfCall").map((c) => c.args), [
    ["leg-1", "1*"],
  ]);
  assert.equal(
    h.win.calls("sendDtmfCall").some((c) => String(c.args[0]).startsWith("p-")),
    false
  );
  assert.equal(h.c.sendDtmf("leg-1", "").ok, false);
  h.win.emit(ev("hangup", "leg-1"));
  assert.equal(h.c.sendDtmf("leg-1", "1").ok, false);

  h.win.emit(ev("ringing", "leg-2"));
  await tick();
  assert.equal(h.c.answer("leg-2").ok, true);
  assert.equal(h.c.answer("leg-2").ok, false);
  assert.equal(h.win.calls("answerCall").length, 1);
  await h.clock.advance(400);
  assert.equal(h.c.answer("leg-2").ok, true);
  assert.equal(h.win.calls("answerCall").length, 2);
});

test("a ticket action for a different saved call is refused and not sent", async () => {
  const h = setup({ signedIn: true });
  h.postImpl = async (method) => {
    if (method === "record_call_event")
      return {
        event_created: true,
        call: {
          name: "log-in-1",
          direction: "Inbound",
          ticket: "",
          contact: "",
          status: "Ringing",
        },
      };
    if (method === "get_call_ticket_panel")
      return { call_log: "log-in-1", linked: false, tickets: [], contacts: [], fields: [] };
    return {};
  };
  h.win.emit(ev("ringing", "in-1"));
  await tick();
  const link = await h.c.linkTicket("in-1", "T-1", { callLog: "log-other" });
  const created = await h.c.createTicket(
    "in-1",
    { subject: "Leak", description: "Under the sink" },
    { callLog: "log-other" }
  );
  const search = await h.c.searchTickets("in-1", "pump", { callLog: "log-other" });
  const contact = await h.c.chooseContact("in-1", "CONTACT-2", {
    callLog: "log-other",
  });
  assert.equal(link.ok, false);
  assert.match(link.error!, /different saved call/);
  assert.equal(created.ok, false);
  assert.equal(search.ok, false);
  assert.equal(contact.ok, false);
  assert.equal(
    h.posts.filter((p) =>
      ["link_saved_call", "create_call_ticket", "search_call_tickets", "set_saved_contact"].includes(
        p.method
      )
    ).length,
    0
  );
});

test("a pinned ended call is kept when older calls are trimmed", async () => {
  const h = setup({ signedIn: true });
  for (let i = 0; i < 12; i++) {
    h.win.emit(ev("ringing", `c${i}`));
    h.win.emit(ev("hangup", `c${i}`));
    await tick();
  }
  h.c.pin("c0");
  h.win.emit(ev("ringing", "c12"));
  h.win.emit(ev("hangup", "c12"));
  await tick();
  const ids = h.c.snapshot().calls.map((call) => call.callId);
  assert.equal(ids.includes("c0"), true);
  assert.equal(ids.includes("c1"), false);
  assert.equal(ids.length, 12);
});

test("a second hangup is refused until ZIWO confirms, then a timeout allows one explicit retry", async () => {
  const h = setup({ signedIn: true });
  h.win.emit(ev("ringing", "in-1"));
  h.win.emit(ev("active", "in-1"));
  await tick();
  assert.equal(h.c.hangup("in-1").ok, true);
  assert.equal(h.c.snapshot().calls[0]!.ending, true);
  const again = h.c.hangup("in-1");
  assert.equal(again.ok, false);
  assert.match(again.error!, /Ending is already requested/);
  assert.equal(h.win.calls("hangUpCall").length, 1);

  h.win.emit(ev("hangup", "in-1"));
  assert.equal(h.c.snapshot().calls[0]!.ending, false);
  assert.equal(h.c.snapshot().calls[0]!.endError, "");
  assert.equal(h.c.hangup("in-1").ok, false);

  h.win.emit(ev("ringing", "in-2"));
  h.win.emit(ev("active", "in-2"));
  await tick();
  assert.equal(h.c.hangup("in-2").ok, true);
  await h.clock.advance(HANGUP_CONFIRM_MS);
  const stalled = h.c.snapshot().calls.find((call) => call.callId === "in-2")!;
  assert.equal(stalled.ending, false);
  assert.match(stalled.endError, /has not confirmed the call ended/);
  assert.equal(h.c.hangup("in-2").ok, true);
  assert.equal(h.win.calls("hangUpCall").filter((c) => c.args[0] === "in-2").length, 2);
});

test("Decline is offered only when the SDK exposes reject", () => {
  const h = setup({ signedIn: true });
  assert.equal(h.c.snapshot().canReject, true);
  delete h.win.ZIWO.calls.rejectCall;
  assert.equal(h.c.snapshot().canReject, false);
});

test("the contact the agent dialed stays on every saved event until the server links it", async () => {
  const h = setup({ signedIn: true });
  h.postImpl = async (method, args) =>
    method === "record_call_event"
      ? {
          event_created: true,
          call: {
            direction: "Outbound",
            ticket: "",
            contact: "",
            status: "Ringing",
          },
        }
      : { contacts: [], tickets: [], requires_selection: false };
  await h.c.dial("+971501112233", { contact: "CONTACT-9" });
  h.win.emit(ev("requesting", "out-1"));
  await tick();
  h.win.emit(ev("hangup", "out-1"));
  await tick();
  await tick();
  assert.equal(
    saved(h).every((p) => p.args.contact === "CONTACT-9" && !("ticket" in p.args)),
    true
  );
  assert.equal(h.c.snapshot().calls[0]!.originContact, "CONTACT-9");

  const linked = setup({ signedIn: true });
  let linkedContact = "";
  linked.postImpl = async (method, args) => {
    if (method !== "record_call_event")
      return { contacts: [], tickets: [], requires_selection: false };
    if (args.contact) linkedContact = args.contact;
    return {
      event_created: true,
      call: {
        direction: "Outbound",
        ticket: "",
        contact: linkedContact,
        status: "Ringing",
      },
      ...(args.contact ? { origin_contact_link: "linked" } : {}),
    };
  };
  await linked.c.dial("+971501112233", { contact: "CONTACT-8" });
  linked.win.emit(ev("requesting", "out-1"));
  await tick();
  linked.win.emit(ev("active", "out-1"));
  await tick();
  assert.equal(saved(linked)[0]!.args.contact, "CONTACT-8");
  assert.equal("contact" in saved(linked)[1]!.args, false);
  assert.equal(linked.c.snapshot().calls[0]!.contact, "CONTACT-8");
});
