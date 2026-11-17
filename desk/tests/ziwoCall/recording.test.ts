import assert from "node:assert/strict";
import { test } from "node:test";
import {
  PlaybackSlot,
  RECORDING_ENDPOINT,
  RecordingFetchError,
  clock,
  failureFrom,
  loadRecording,
  recordingUrl,
  serverMessage,
  statusMessage,
} from "../../src/composables/ziwoCall/recording.ts";

const CALL = "0f8f45452669f7e1792ed9c01b1bdec00cf1e552";

function audio(bytes = 15840) {
  return new Blob([new Uint8Array(bytes).fill(0xff)], { type: "audio/mpeg" });
}

function reply(
  status: number,
  options: { type?: string; blob?: Blob; text?: string } = {}
) {
  const type = options.type ?? "audio/mpeg";
  return {
    ok: status >= 200 && status < 300,
    status,
    headers: {
      get: (name: string) =>
        name.toLowerCase() === "content-type" ? type : null,
    },
    blob: async () => options.blob ?? audio(),
    text: async () => options.text ?? "",
  };
}

function frappeError(exc: string, message: string) {
  return JSON.stringify({
    exc_type: exc,
    _server_messages: JSON.stringify([
      JSON.stringify({ message, title: "Message" }),
    ]),
  });
}

function recorder(response: any) {
  const calls: any[] = [];
  const fetch = async (url: string, init: any) => {
    calls.push({ url, init });
    if (response instanceof Error) throw response;
    return response;
  };
  return { fetch: fetch as any, calls };
}

test("the request goes to the same-origin Helpdesk endpoint with only the local call name", async () => {
  const { fetch, calls } = recorder(reply(200));
  await loadRecording(CALL, { fetch });
  assert.equal(calls.length, 1);
  assert.equal(calls[0].url, `${RECORDING_ENDPOINT}?call=${CALL}`);
  assert.equal(
    RECORDING_ENDPOINT,
    "/api/method/inchaa_custmization.integrations.ziwo.api.get_recording_audio"
  );
  // A relative address cannot reach another host.
  assert.equal(/^[a-z]+:/i.test(calls[0].url), false);
  assert.equal(calls[0].url.startsWith("/"), true);
});

test("the call name is encoded, so it can never add a parameter or change the path", () => {
  assert.equal(
    recordingUrl("a&call=evil#x?y"),
    `${RECORDING_ENDPOINT}?call=a%26call%3Devil%23x%3Fy`
  );
});

test("the fetch uses the agent's own session, never caches, and carries no credential", async () => {
  const { fetch, calls } = recorder(reply(200));
  await loadRecording(CALL, { fetch });
  const init = calls[0].init;
  assert.equal(init.method, "GET");
  assert.equal(init.credentials, "same-origin");
  assert.equal(init.cache, "no-store");
  assert.match(init.headers.Accept, /^audio\/mpeg/);
  const names = Object.keys(init.headers).map((n) => n.toLowerCase());
  assert.deepEqual(names, ["accept"]);
});

test("the audio comes back as an audio/mpeg Blob of the same size", async () => {
  const { fetch } = recorder(reply(200, { blob: audio(15840) }));
  const blob = await loadRecording(CALL, { fetch });
  assert.equal(blob.type, "audio/mpeg");
  assert.equal(blob.size, 15840);
});

test("the Blob is typed audio/mpeg even if the browser labelled the bytes otherwise", async () => {
  const odd = new Blob([new Uint8Array(10)], {
    type: "application/octet-stream",
  });
  const { fetch } = recorder(reply(200, { blob: odd }));
  assert.equal((await loadRecording(CALL, { fetch })).type, "audio/mpeg");
});

test("an answer that is not audio is refused, whatever its status", async () => {
  for (const type of ["text/html", "application/json", "", "audio/wav"]) {
    const { fetch } = recorder(reply(200, { type }));
    await assert.rejects(loadRecording(CALL, { fetch }), (e: any) => {
      assert.ok(e instanceof RecordingFetchError);
      assert.match(e.message, /did not return audio/);
      return true;
    });
  }
  const { fetch } = recorder(
    reply(200, { type: "audio/mpeg; charset=binary" })
  );
  await loadRecording(CALL, { fetch });
});

test("an empty body is refused", async () => {
  const { fetch } = recorder(reply(200, { blob: new Blob([]) }));
  await assert.rejects(loadRecording(CALL, { fetch }), /empty/);
});

test("the server's own readable message is shown for the errors the feature raises", async () => {
  const cases: Array<[number, string, string, string]> = [
    [
      404,
      "RecordingNotFound",
      "No recording is available for this call.",
      "not-found",
    ],
    [
      503,
      "RecordingNotConfigured",
      "Recording playback is not set up. A system manager must enter the ZIWO recording credential in the ZIWO connector.",
      "not-configured",
    ],
    [
      502,
      "RecordingCredentialRejected",
      "ZIWO did not accept the recording credential. It may have expired.",
      "error",
    ],
    [
      504,
      "RecordingTimeout",
      "ZIWO did not return the recording in time.",
      "error",
    ],
    [
      502,
      "RecordingPermissionDenied",
      "ZIWO accepted the recording credential, but its account is not allowed to read this recording.",
      "error",
    ],
    [
      502,
      "RecordingLoginPaused",
      "Automatic sign-in to ZIWO is paused after a failed attempt and will be tried again later.",
      "error",
    ],
    [
      502,
      "RecordingUpstreamError",
      "Another sign-in to ZIWO is in progress. Try again in a moment.",
      "error",
    ],
    [
      403,
      "PermissionError",
      "You are not permitted to access this call's recording.",
      "denied",
    ],
    [
      403,
      "ZiwoDisabled",
      "ZIWO calling is not enabled for this call's account.",
      "denied",
    ],
    [404, "DoesNotExistError", "Call not found.", "not-found"],
    [429, "RateLimitExceededError", "You hit the rate limit.", "busy"],
  ];
  for (const [status, exc, message, kind] of cases) {
    const { fetch } = recorder(
      reply(status, { text: frappeError(exc, message) })
    );
    await assert.rejects(loadRecording(CALL, { fetch }), (e: any) => {
      assert.equal(e.message, message, exc);
      assert.equal(e.kind, kind, exc);
      assert.equal(e.status, status);
      return true;
    });
  }
});

test("a failure from an unexpected place never shows raw server text", () => {
  const body = JSON.parse(
    frappeError("OperationalError", "SELECT * FROM tabUser WHERE secret = 'x'")
  );
  const error = failureFrom(500, body);
  assert.equal(error.message, statusMessage(500));
  assert.equal(/SELECT|secret/.test(error.message), false);
  // HTML pages from a proxy are not shown either.
  const page = failureFrom(502, null);
  assert.equal(page.message, statusMessage(502));
});

test("server messages are stripped of markup and kept short", () => {
  const long = "x".repeat(900);
  const text = serverMessage(
    JSON.parse(
      frappeError("RecordingNotFound", `<b>Gone</b> <script>1</script>${long}`)
    )
  );
  assert.equal(text.includes("<"), false);
  assert.ok(text.length <= 300);
  assert.equal(serverMessage({ _server_messages: "not json" }), "");
  assert.equal(serverMessage({ _server_messages: "{}" }), "");
  assert.equal(serverMessage(null), "");
});

test("each status has a plain fallback, and a rejected credential never looks like a lost session", () => {
  for (const status of [401, 403, 404, 429, 500, 502, 503, 504, 400]) {
    assert.ok(statusMessage(status).length > 10, String(status));
  }
  // 502 is how the server reports a rejected provider credential.
  const rejected = failureFrom(
    502,
    JSON.parse(frappeError("RecordingCredentialRejected", "Expired"))
  );
  assert.equal(rejected.kind, "error");
  assert.notEqual(rejected.kind, "session");
  assert.equal(failureFrom(401, null).kind, "session");
});

test("a network failure is reported plainly; an abort is passed through untouched", async () => {
  const down = recorder(new TypeError("Failed to fetch"));
  await assert.rejects(loadRecording(CALL, { fetch: down.fetch }), (e: any) => {
    assert.ok(e instanceof RecordingFetchError);
    assert.match(e.message, /could not be reached/);
    assert.equal(/Failed to fetch/.test(e.message), false);
    return true;
  });
  const aborted = Object.assign(new Error("aborted"), { name: "AbortError" });
  const stop = recorder(aborted);
  await assert.rejects(
    loadRecording(CALL, { fetch: stop.fetch }),
    (e: any) => e === aborted
  );
});

test("a download cut off while reading the body is reported, an abort is not swallowed", async () => {
  const broken = reply(200);
  broken.blob = async () => {
    throw new TypeError("network error");
  };
  await assert.rejects(
    loadRecording(CALL, { fetch: recorder(broken).fetch }),
    /interrupted/
  );
  const aborted = Object.assign(new Error("aborted"), { name: "AbortError" });
  const cancelled = reply(200);
  cancelled.blob = async () => {
    throw aborted;
  };
  await assert.rejects(
    loadRecording(CALL, { fetch: recorder(cancelled).fetch }),
    (e: any) => e === aborted
  );
});

test("the abort signal is handed to the request", async () => {
  const controller = new AbortController();
  const { fetch, calls } = recorder(reply(200));
  await loadRecording(CALL, { fetch, signal: controller.signal });
  assert.equal(calls[0].init.signal, controller.signal);
});

test("the player's own position readout is m:ss and tolerates bad values", () => {
  assert.equal(clock(0), "0:00");
  assert.equal(clock(7.92), "0:07");
  assert.equal(clock(65), "1:05");
  assert.equal(clock(NaN), "0:00");
  assert.equal(clock(-3), "0:00");
  assert.equal(clock(Infinity), "0:00");
});

test("only one recording plays at a time", () => {
  const slot = new PlaybackSlot();
  const log: string[] = [];
  const a = { pause: () => log.push("a") };
  const b = { pause: () => log.push("b") };
  slot.claim(a);
  slot.claim(a); // the same player starting again pauses nobody
  assert.deepEqual(log, []);
  slot.claim(b); // a new player pauses the one that had it
  assert.deepEqual(log, ["a"]);
  slot.release(a); // a stale release changes nothing
  assert.equal(slot.current, b);
  slot.release(b);
  assert.equal(slot.current, null);
  slot.claim(a);
  assert.deepEqual(log, ["a"]);
});
