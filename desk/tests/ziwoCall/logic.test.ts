import assert from "node:assert/strict";
import { test } from "node:test";
import {
  canDial,
  classifyEvent,
  classifySdkMessage,
  describeShape,
  dialBackspace,
  dialForCall,
  directionHint,
  draftFromInput,
  dtmfSequence,
  emptyDial,
  errorMessage,
  exposesReject,
  internalNoteHtml,
  isPermanentError,
  mapConnection,
  nextRetryDelay,
  parseCallEvent,
  presenceKind,
  pushDialDigit,
  sanitizeDialNumber,
  setCallingCode,
} from "../../src/composables/ziwoCall/logic.ts";

/** The shape the vendor plugin dispatches: { type, cause?, causeCode?, call, payload }. */
function vendorEvent(type: string, extra: Record<string, any> = {}) {
  return {
    type,
    call: {
      callId: "call-1",
      primaryCallId: "primary-1",
      direction: "outbound",
      participants: [{ number: "+201001234567", isInternal: false }],
      myself: { number: "agent-login" },
      states: [{ state: "active" }],
      userVariables: { secret: "must-not-be-listed-by-value" },
    },
    payload: {
      callId: "call-1",
      params: { caller_id_number: "+971541482148" },
    },
    ...extra,
  };
}

test("the call id is read from payload.callId, not from a top-level callId", () => {
  const parsed = parseCallEvent(vendorEvent("active"));
  assert.equal(parsed?.callId, "call-1");
  // The shape that the first proof of concept assumed carries no usable id at all.
  assert.equal(parseCallEvent({ type: "active", id: "x", call_id: "y" }), null);
});

test("the call id falls back to call.callId when the payload has none", () => {
  const event: any = vendorEvent("active");
  delete event.payload.callId;
  assert.equal(parseCallEvent(event)?.callId, "call-1");
});

test("the customer number is the first participant", () => {
  assert.equal(parseCallEvent(vendorEvent("ringing"))?.number, "+201001234567");
  const bare: any = vendorEvent("ringing");
  bare.call.participants = [];
  bare.payload.remoteNumber = "0501112222";
  assert.equal(parseCallEvent(bare)?.number, "0501112222");
});

test("hangup cause and the primary call id are carried", () => {
  const parsed = parseCallEvent(
    vendorEvent("hangup", { cause: "NORMAL_CLEARING", causeCode: 16 })
  );
  assert.equal(parsed?.cause, "NORMAL_CLEARING");
  assert.equal(parsed?.causeCode, "16");
  assert.equal(parsed?.primaryCallId, "primary-1");
});

test("junk is rejected without throwing", () => {
  for (const junk of [
    null,
    undefined,
    5,
    "x",
    [],
    {},
    { type: "active" },
    { payload: {} },
  ]) {
    assert.equal(parseCallEvent(junk as any), null);
  }
});

test("every documented event type has a category and unknown ones are not guessed", () => {
  const expected: Record<string, string> = {
    ringing: "ringing",
    requesting: "progress",
    trying: "progress",
    early: "progress",
    answering: "progress",
    active: "active",
    attach: "recovery",
    recovering: "recovery",
    hangup: "end",
    destroy: "end",
    mute: "audit",
    held: "audit",
  };
  for (const [type, category] of Object.entries(expected)) {
    assert.equal(classifyEvent(type), category, type);
    assert.equal(classifyEvent(type.toUpperCase()), category, `${type} (case)`);
  }
  assert.equal(classifyEvent("something-new"), "unknown");
  assert.equal(classifyEvent(null), "unknown");
});

test("direction is proven only by the event type, never by call.direction", () => {
  assert.equal(directionHint("ringing"), "Inbound");
  for (const type of ["requesting", "trying", "early", "destroy"]) {
    assert.equal(directionHint(type), "Outbound", type);
  }
  // These occur in both directions, so they prove nothing.
  for (const type of [
    "answering",
    "active",
    "hangup",
    "attach",
    "recovering",
  ]) {
    assert.equal(directionHint(type), "Unknown", type);
  }
  // A recovered call is marked inbound by the vendor whatever it was: ignored.
  const recovered: any = vendorEvent("attach");
  recovered.call.direction = "inbound";
  assert.equal(directionHint(recovered.type), "Unknown");
});

test("dial numbers are cleaned to a string the SDK accepts, or refused", () => {
  assert.equal(sanitizeDialNumber("+971 54 148-2148"), "+971541482148");
  assert.equal(sanitizeDialNumber("+20-01061679185"), "+201061679185");
  assert.equal(sanitizeDialNumber("+971541482148"), "+971541482148");
  assert.equal(sanitizeDialNumber("(0100) 123 4567"), "01001234567");
  assert.equal(sanitizeDialNumber("00201001234567"), "+201001234567");
  for (const bad of ["", "   ", "abc", "12", "+", "1".repeat(30), "+97 1x"]) {
    assert.equal(sanitizeDialNumber(bad), null, JSON.stringify(bad));
  }
  assert.equal(typeof sanitizeDialNumber("+971541482148"), "string");
});

test("dialing is blocked for every state in which another call could result", () => {
  const ready = {
    sdkReady: true,
    signedIn: true,
    intentState: null,
    hasLiveCall: false,
  };
  assert.equal(canDial(ready as any).ok, true);
  assert.equal(canDial({ ...ready, sdkReady: false } as any).ok, false);
  assert.equal(canDial({ ...ready, signedIn: false } as any).ok, false);
  assert.equal(canDial({ ...ready, hasLiveCall: true } as any).ok, false);
  for (const state of ["dispatching", "awaiting-event", "uncertain"]) {
    assert.equal(
      canDial({ ...ready, intentState: state } as any).ok,
      false,
      state
    );
  }
  // A confirmed failure or a bound attempt no longer blocks.
  assert.equal(canDial({ ...ready, intentState: "failed" } as any).ok, true);
});

test("retry delays grow, then repeat the last value", () => {
  assert.deepEqual(
    [1, 2, 3, 4, 5, 9].map(nextRetryDelay),
    [1000, 3000, 10000, 30000, 30000, 30000]
  );
  assert.equal(nextRetryDelay(0), 1000);
});

test("only validation, permission and not-found answers are permanent", () => {
  assert.equal(isPermanentError({ exc_type: "ValidationError" }), true);
  assert.equal(isPermanentError({ exc_type: "PermissionError" }), true);
  assert.equal(isPermanentError({ httpStatus: 403 }), true);
  assert.equal(isPermanentError({ httpStatus: 404 }), true);
  assert.equal(isPermanentError({ httpStatus: 500 }), false);
  assert.equal(isPermanentError({ httpStatus: 503 }), false);
  assert.equal(isPermanentError(new TypeError("Failed to fetch")), false);
  assert.equal(
    isPermanentError({ exc_type: "QueryDeadlockError", httpStatus: 500 }),
    false
  );
});

test("error text is short and has no markup", () => {
  assert.equal(
    errorMessage({ messages: ["<b>Not</b> permitted"] }, "x"),
    "Not permitted"
  );
  assert.equal(errorMessage(new Error("boom"), "x"), "boom");
  assert.equal(errorMessage({}, "fallback"), "fallback");
  assert.ok(errorMessage(new Error("y".repeat(900)), "x").length <= 300);
});

test("the event shape lists key names only, never values", () => {
  const shape = describeShape(vendorEvent("active"));
  assert.match(shape, /type=active/);
  assert.match(shape, /call\[/);
  assert.match(shape, /payload\[/);
  for (const value of [
    "must-not-be-listed-by-value",
    "+201001234567",
    "call-1",
    "agent-login",
  ]) {
    assert.equal(shape.includes(value), false, value);
  }
  assert.ok(shape.length <= 600);
});

test("the opaque connection stream is read conservatively", () => {
  assert.equal(mapConnection("connected"), "connected");
  assert.equal(mapConnection({ status: "notConnected" }), "disconnected");
  assert.equal(mapConnection("reconnecting"), "disconnected");
  assert.equal(mapConnection(undefined), "unknown");
  assert.equal(mapConnection(7), "unknown");
});

test("the plugin's own failure lines are read, and its chatter is ignored", () => {
  const rejected = classifySdkMessage(
    "[3:05:08 PM] Error Code: 401, Message: Http failure response for https://inchaa-api.aswat.co/auth/login: 401 OK"
  );
  assert.deepEqual([rejected?.kind, rejected?.code], ["auth-rejected", 401]);
  const unknown = classifySdkMessage(
    "Error Code: 404, Message: Http failure response for https://nope-api.aswat.co/info: 404 Not Found"
  );
  assert.equal(unknown?.kind, "account-unknown");
  assert.equal(
    classifySdkMessage(
      "Error Code: 503, Message: Http failure response for https://x/y: 503"
    )?.kind,
    "http-error"
  );
  // The plugin's single-sign-on lookup is blocked by CORS on this site. That is not a failed sign-in.
  assert.equal(
    classifySdkMessage(
      "Access to XMLHttpRequest at 'https://directory.ziwo.co/v1/account' has been blocked by CORS policy"
    )?.kind,
    "network"
  );
  assert.equal(
    classifySdkMessage(
      "Error Code: 0, Message: Http failure response for https://directory.ziwo.co/v1/account: 0 Unknown Error"
    )?.kind,
    "network"
  );
  for (const noise of [
    "",
    "   ",
    null,
    undefined,
    "PlatformFactory - Could not build Platform Orchestrator for 'custom'",
    "Failed to load resource: net::ERR_FAILED",
  ]) {
    assert.equal(classifySdkMessage(noise as any), null, String(noise));
  }
  assert.ok(
    (classifySdkMessage("Error Code: 401 " + "x".repeat(900) + " /auth/login")
      ?.text.length ?? 0) <= 240
  );
});

test("a pasted international number keeps its country code", () => {
  const selected = emptyDial("971");
  const pasted = draftFromInput(selected, "+44 7911 123456");
  assert.equal(dialForCall(pasted), "+447911123456");
  assert.equal(dialForCall(setCallingCode(pasted, "966")), "+447911123456");
  const prefixed = draftFromInput(selected, "00442079460958");
  assert.equal(dialForCall(prefixed), "+442079460958");
  const national = draftFromInput(selected, "50 123 4567");
  assert.equal(dialForCall(national), "+971501234567");
  assert.equal(dialForCall(setCallingCode(national, "966")), "+966501234567");
  let typed = emptyDial("971");
  for (const digit of ["5", "0", "1", "2", "3"]) typed = pushDialDigit(typed, digit);
  assert.equal(dialForCall(dialBackspace(typed)), "+9715012");
});

test("availability is Available only when ZIWO says so", () => {
  const base = {
    sdk: "ready" as const,
    session: "signed-in" as const,
    connection: "connected" as const,
    ziwoStatus: "",
  };
  assert.equal(presenceKind({ ...base, ziwoStatus: "Available" }), "available");
  assert.equal(presenceKind({ ...base, ziwoStatus: " available " }), "available");
  assert.equal(presenceKind(base), "unavailable");
  assert.equal(presenceKind({ ...base, ziwoStatus: "On Break" }), "unavailable");
  assert.equal(presenceKind({ ...base, ziwoStatus: "Outgoing" }), "unavailable");
  assert.equal(
    presenceKind({ ...base, session: "signed-out", ziwoStatus: "Available" }),
    "signed-out"
  );
  assert.equal(
    presenceKind({ ...base, sdk: "loading", session: "signed-out" }),
    "connecting"
  );
  assert.equal(
    presenceKind({ ...base, connection: "disconnected", ziwoStatus: "Available" }),
    "reconnecting"
  );
  assert.equal(
    presenceKind({ ...base, ziwoStatus: "Reconnecting" }),
    "reconnecting"
  );
});

test("DTMF accepts keypad symbols and an internal note cannot carry markup", () => {
  assert.equal(dtmfSequence("12*#"), "12*#");
  assert.equal(dtmfSequence("1a2"), "12");
  assert.equal(dtmfSequence(""), null);
  assert.equal(exposesReject({ rejectCall() {} }), true);
  assert.equal(exposesReject({}), false);
  assert.equal(exposesReject(null), false);
  const html = internalNoteHtml("<script>alert(1)</script>\nnext");
  assert.equal(html.includes("<script>"), false);
  assert.match(html, /&lt;script&gt;/);
  assert.match(html, /<br>/);
});
