/** Stale desk CSRF (another tab rotated `sid`, or the session expired). */

export const CSRF_RELOAD_STORAGE_KEY = "helpdesk.csrfReloadAt";
/** A failed reload must not immediately reload again. */
export const CSRF_RELOAD_THROTTLE_MS = 10_000;

export const CSRF_RELOAD_MESSAGE =
  "Your session changed or expired. Reloading...";
export const CSRF_THROTTLED_MESSAGE =
  "Your session changed or expired. Reload the page to continue.";

export type CsrfRecovery = "ignored" | "reloading" | "throttled";

export interface CsrfRecoveryDeps {
  now: () => number;
  storage: {
    getItem: (key: string) => string | null;
    setItem: (key: string, value: string) => void;
  };
  notify: (message: string) => void;
  reload: () => void;
  redirectToLogin: () => void;
  isGuest: () => boolean;
}

interface CsrfErrorShape {
  exc_type?: unknown;
  status?: unknown;
  message?: unknown;
  messages?: unknown;
  response?: { status?: unknown };
}

let recovery: "idle" | "reloading" | "throttled" = "idle";

/** Tests start from a fresh page. Production resets this on reload. */
export function resetCsrfRecoveryState(): void {
  recovery = "idle";
}

function statusOf(error: CsrfErrorShape): number | undefined {
  if (typeof error.status === "number") return error.status;
  const responseStatus = error.response?.status;
  return typeof responseStatus === "number" ? responseStatus : undefined;
}

function textParts(error: CsrfErrorShape): string[] {
  const parts: string[] = [];
  if (typeof error.message === "string") parts.push(error.message);
  if (typeof error.messages === "string") parts.push(error.messages);
  else if (Array.isArray(error.messages)) {
    for (const message of error.messages) {
      if (typeof message === "string") parts.push(message);
    }
  }
  return parts;
}

function isInvalidRequest(value: string): boolean {
  return value.trim() === "Invalid Request";
}

/**
 * Frappe's stale-token failure is HTTP 400 `CSRFTokenError`, whose message is
 * "Invalid Request". A validation 400 keeps its own `exc_type` and must not
 * match, even when the text happens to say "Invalid Request".
 */
export function isCsrfTokenError(error: unknown): boolean {
  if (!error || typeof error !== "object") return false;
  const body = error as CsrfErrorShape;
  if (body.exc_type === "CSRFTokenError") return true;
  if (body.exc_type) return false;
  if (statusOf(body) !== 400) return false;
  return textParts(body).some(isInvalidRequest);
}

/** Shape `frappeRequest` builds, taken from a raw API error body. */
export function errorFromFrappeResponse(status: number, body: unknown) {
  const data =
    body && typeof body === "object"
      ? (body as Record<string, unknown>)
      : {};
  const messages: string[] = [];
  if (typeof data.message === "string") messages.push(data.message);
  if (typeof data._server_messages === "string") {
    try {
      const parsed = JSON.parse(data._server_messages);
      if (Array.isArray(parsed)) {
        for (const item of parsed) {
          if (typeof item !== "string") continue;
          try {
            const decoded = JSON.parse(item) as { message?: unknown };
            if (typeof decoded?.message === "string") messages.push(decoded.message);
            else messages.push(item);
          } catch {
            messages.push(item);
          }
        }
      }
    } catch {
      // Malformed server messages are not a CSRF signal on their own.
    }
  }
  return {
    exc_type: typeof data.exc_type === "string" ? data.exc_type : undefined,
    status,
    message: messages[0],
    messages,
  };
}

/**
 * One recovery for every parallel failure. The storage stamp survives the
 * reload, so a persistent server error cannot reload forever.
 */
export function recoverFromStaleCsrf(
  error: unknown,
  deps: CsrfRecoveryDeps
): CsrfRecovery {
  if (!isCsrfTokenError(error)) return "ignored";
  if (recovery !== "idle") return recovery;

  const last = Number(deps.storage.getItem(CSRF_RELOAD_STORAGE_KEY) || 0);
  const now = deps.now();
  if (last && now - last < CSRF_RELOAD_THROTTLE_MS) {
    recovery = "throttled";
    deps.notify(CSRF_THROTTLED_MESSAGE);
    return "throttled";
  }

  try {
    deps.storage.setItem(CSRF_RELOAD_STORAGE_KEY, String(now));
  } catch {
    // A blocked sessionStorage still gets the in-memory guard for this page.
  }
  recovery = "reloading";
  try {
    deps.notify(CSRF_RELOAD_MESSAGE);
  } catch {
    // Leaving the page matters more than the toast.
  }
  if (deps.isGuest()) deps.redirectToLogin();
  else deps.reload();
  return "reloading";
}
