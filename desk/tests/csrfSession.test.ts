import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { test } from "node:test";
import {
  CSRF_RELOAD_MESSAGE,
  CSRF_RELOAD_STORAGE_KEY,
  CSRF_RELOAD_THROTTLE_MS,
  CSRF_THROTTLED_MESSAGE,
  errorFromFrappeResponse,
  isCsrfTokenError,
  recoverFromStaleCsrf,
  resetCsrfRecoveryState,
  type CsrfRecoveryDeps,
} from "../src/csrfSession.ts";

function memoryStorage(initial: Record<string, string> = {}) {
  const data = { ...initial };
  return {
    getItem: (key: string) => (Object.prototype.hasOwnProperty.call(data, key) ? data[key] : null),
    setItem: (key: string, value: string) => {
      data[key] = String(value);
    },
    data,
  };
}

function deps(storage = memoryStorage(), now = 1_700_000_000_000) {
  const notes: string[] = [];
  const reloads: number[] = [];
  const logins: number[] = [];
  const api: CsrfRecoveryDeps = {
    now: () => now,
    storage,
    notify: (message) => notes.push(message),
    reload: () => reloads.push(1),
    redirectToLogin: () => logins.push(1),
    isGuest: () => false,
  };
  return { api, notes, reloads, logins, storage };
}

const csrfError = {
  exc_type: "CSRFTokenError",
  status: 400,
  messages: ["Invalid Request"],
};

test("CSRFTokenError is a session failure and a validation 400 is not", () => {
  assert.equal(isCsrfTokenError(csrfError), true);
  assert.equal(
    isCsrfTokenError({
      status: 400,
      message: "Invalid Request",
      messages: ["Invalid Request"],
    }),
    true
  );
  assert.equal(
    isCsrfTokenError(
      errorFromFrappeResponse(400, {
        exc_type: "CSRFTokenError",
        _server_messages: JSON.stringify([
          JSON.stringify({ message: "Invalid Request" }),
        ]),
      })
    ),
    true
  );

  const validation = {
    exc_type: "ValidationError",
    status: 400,
    message: "Subject is required",
    messages: ["Subject is required"],
  };
  assert.equal(isCsrfTokenError(validation), false);
  assert.equal(
    isCsrfTokenError({
      exc_type: "ValidationError",
      status: 400,
      message: "Invalid Request",
      messages: ["Invalid Request"],
    }),
    false
  );
  assert.equal(isCsrfTokenError({ status: 500, message: "Invalid Request" }), false);
  assert.equal(isCsrfTokenError(null), false);
});

test("parallel CSRF failures reload once and do not stack messages", () => {
  resetCsrfRecoveryState();
  const { api, notes, reloads, logins } = deps();
  assert.equal(recoverFromStaleCsrf(csrfError, api), "reloading");
  assert.equal(recoverFromStaleCsrf(csrfError, api), "reloading");
  assert.equal(recoverFromStaleCsrf(csrfError, api), "reloading");
  assert.equal(reloads.length, 1);
  assert.deepEqual(notes, [CSRF_RELOAD_MESSAGE]);
  assert.equal(logins.length, 0);
});

test("a validation 400 does not reload", () => {
  resetCsrfRecoveryState();
  const { api, notes, reloads } = deps();
  const outcome = recoverFromStaleCsrf(
    {
      exc_type: "ValidationError",
      status: 400,
      messages: ["Subject is required"],
    },
    api
  );
  assert.equal(outcome, "ignored");
  assert.equal(reloads.length, 0);
  assert.equal(notes.length, 0);
});

test("a reload inside the throttle does not loop", () => {
  resetCsrfRecoveryState();
  const now = 1_700_000_000_000;
  const storage = memoryStorage({
    [CSRF_RELOAD_STORAGE_KEY]: String(now - 1000),
  });
  const { api, notes, reloads } = deps(storage, now);
  assert.ok(CSRF_RELOAD_THROTTLE_MS > 1000);
  assert.equal(recoverFromStaleCsrf(csrfError, api), "throttled");
  assert.equal(recoverFromStaleCsrf(csrfError, api), "throttled");
  assert.equal(reloads.length, 0);
  assert.deepEqual(notes, [CSRF_THROTTLED_MESSAGE]);
});

test("a guest session is sent to login instead of reloading the desk", () => {
  resetCsrfRecoveryState();
  const { api, reloads, logins, notes } = deps();
  api.isGuest = () => true;
  assert.equal(recoverFromStaleCsrf(csrfError, api), "reloading");
  assert.equal(reloads.length, 0);
  assert.equal(logins.length, 1);
  assert.deepEqual(notes, [CSRF_RELOAD_MESSAGE]);
});

test("desk login stays a full page load and logout recovers a stale token", () => {
  const auth = readFileSync(
    new URL("../src/stores/auth.ts", import.meta.url),
    "utf8"
  );
  const main = readFileSync(new URL("../src/main.js", import.meta.url), "utf8");
  assert.match(auth, /No in-SPA login/);
  assert.match(auth, /recoverDeskCsrf\(error\)/);
  assert.match(auth, /window\.location\.href = LOGIN_PAGE/);
  assert.match(main, /installCsrfFetchGuard\(\)/);
  assert.match(main, /recoverDeskCsrf\(error\) === "reloading"/);
  assert.match(main, /new Promise\(\(\) => \{\}\)/);
  assert.match(main, /recoverDeskCsrf\(error\) !== "ignored"/);
});
