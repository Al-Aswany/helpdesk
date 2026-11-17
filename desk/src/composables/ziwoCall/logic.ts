/**
 * Pure helpers for the embedded ZIWO softphone. Nothing here imports Vue, frappe-ui
 * or an alias, and nothing touches `window` or the network, so every rule can be tested
 * with `node --test` against plain objects.
 *
 * What these rules rest on (read from the vendor plugin, https://docs.ziwo.io/ and the
 * `ziwo.plugin.js` bundle the loader fetches):
 *
 * - Call events reach `window` as `CustomEvent`s named `ziwo-call-all` (every event) and
 *   `ziwo-call-<type>`. `detail` is `{ type, cause?, causeCode?, call, payload }`.
 *   The call id is `detail.payload.callId` (also `detail.call.callId`). It is NOT a
 *   top-level `detail.callId`; code that reads that never sees an id.
 * - The customer's number is `detail.call.participants[0].number`.
 * - `ringing` is inbound only; `requesting`, `trying` and `early` are outbound only.
 *   The `call.direction` field is not trusted: the plugin marks every recovered call
 *   inbound, and derives it from a display flag that is absent on a plain inbound ring.
 * - `session.info$` is `undefined` until a session exists, then `{ tenant, token, name,
 *   ccLogin }`. The token is a credential. Nothing in this file reads it.
 */

export type Direction = "Inbound" | "Outbound" | "Unknown";

export type EventCategory =
  | "ringing"
  | "progress"
  | "active"
  | "recovery"
  | "end"
  | "audit"
  | "unknown";

/** The one window event that carries every call event. */
export const CALL_EVENT_NAME = "ziwo-call-all";

const CATEGORY_BY_TYPE: Record<string, EventCategory> = {
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
  ready: "audit",
  mute: "audit",
  unmute: "audit",
  held: "audit",
  unheld: "audit",
  "consent-in": "audit",
  "consent-back": "audit",
  purge: "audit",
  send: "audit",
};

/** Events that are saved on the server. Mute/hold and other audit events are not. */
export const PERSISTED_CATEGORIES: ReadonlySet<EventCategory> = new Set([
  "ringing",
  "progress",
  "active",
  "recovery",
  "end",
]);

const OUTBOUND_ONLY = new Set(["requesting", "trying", "early", "destroy"]);

export function classifyEvent(type: unknown): EventCategory {
  const key = String(type ?? "")
    .trim()
    .toLowerCase();
  return CATEGORY_BY_TYPE[key] ?? "unknown";
}

/** A direction only when the event type itself proves it. Never from `call.direction`. */
export function directionHint(type: unknown): Direction {
  const key = String(type ?? "")
    .trim()
    .toLowerCase();
  if (key === "ringing") return "Inbound";
  if (OUTBOUND_ONLY.has(key)) return "Outbound";
  return "Unknown";
}

export interface ParsedEvent {
  type: string;
  category: EventCategory;
  callId: string;
  primaryCallId: string;
  number: string;
  cause: string;
  causeCode: string;
}

function text(value: unknown): string {
  if (value === null || value === undefined) return "";
  if (typeof value === "string") return value.trim();
  if (typeof value === "number" && Number.isFinite(value)) return String(value);
  return "";
}

/**
 * Read one event. Returns null when there is no call id, because an event that cannot
 * be keyed cannot be saved; the caller counts it as unparsed so it is visible.
 */
export function parseCallEvent(detail: any): ParsedEvent | null {
  if (!detail || typeof detail !== "object") return null;
  const callId =
    text(detail.payload?.callId) ||
    text(detail.call?.callId) ||
    text(detail.callId);
  if (!callId) return null;
  const type = text(detail.type).toLowerCase();
  const first = Array.isArray(detail.call?.participants)
    ? detail.call.participants[0]
    : undefined;
  return {
    type,
    category: classifyEvent(type),
    callId,
    primaryCallId: text(detail.call?.primaryCallId),
    number:
      text(first?.number) ||
      text(detail.call?.origin?.number) ||
      text(detail.payload?.remoteNumber),
    cause: text(detail.cause),
    causeCode: text(detail.causeCode),
  };
}

/**
 * The shape of an event as key names only, never values, so it is safe to show in the
 * panel and to paste into a bug report. Capped so a large object cannot flood the UI.
 */
export function describeShape(detail: any): string {
  if (!detail || typeof detail !== "object") return typeof detail;
  const keys = (value: unknown) =>
    value && typeof value === "object"
      ? Object.keys(value as object)
          .sort()
          .slice(0, 24)
          .join(",")
      : typeof value;
  const parts = [`type=${text(detail.type) || "?"}`, `detail[${keys(detail)}]`];
  if (detail.call) parts.push(`call[${keys(detail.call)}]`);
  if (detail.payload) parts.push(`payload[${keys(detail.payload)}]`);
  return parts.join(" ").slice(0, 600);
}

/** A string safe to pass to `startCall`, or null when it cannot be a phone number. */
export function sanitizeDialNumber(raw: unknown): string | null {
  let value = String(raw ?? "")
    .replace(/[\s().-]/g, "")
    .trim();
  if (value.startsWith("00")) value = `+${value.slice(2)}`;
  return /^\+?[0-9]{5,20}$/.test(value) ? value : null;
}

// --- one outbound call per action -------------------------------------------------

export type IntentState =
  | "dispatching"
  | "awaiting-event"
  | "uncertain"
  | "failed"
  | "bound";

export interface DialGuardInput {
  sdkReady: boolean;
  signedIn: boolean;
  intentState: IntentState | null;
  hasLiveCall: boolean;
}

/**
 * Whether a new outbound call may be dispatched right now. An attempt that is still in
 * flight, waiting for its first event, or of unknown outcome blocks another, so a double
 * click, a second ticket button or an impatient retry cannot place two real calls.
 */
export function canDial(input: DialGuardInput): {
  ok: boolean;
  reason: string;
} {
  if (!input.sdkReady)
    return { ok: false, reason: "The softphone is not ready." };
  if (!input.signedIn) return { ok: false, reason: "Sign in to ZIWO first." };
  if (input.hasLiveCall)
    return { ok: false, reason: "A call is already in progress." };
  if (
    input.intentState === "dispatching" ||
    input.intentState === "awaiting-event"
  )
    return { ok: false, reason: "A call is already being placed." };
  if (input.intentState === "uncertain")
    return {
      ok: false,
      reason:
        "The last call attempt was not confirmed. Check the ZIWO panel, then confirm before dialing again.",
    };
  return { ok: true, reason: "" };
}

// --- saving events ------------------------------------------------------------------

/** Waits before each automatic retry of an unsaved event. The last value repeats. */
export const RETRY_DELAYS_MS = [1000, 3000, 10000, 30000];

/** An event that has failed this long is no longer retried automatically. */
export const MAX_UNSAVED_AGE_MS = 30 * 60 * 1000;

export function nextRetryDelay(attempts: number): number {
  const index = Math.min(Math.max(attempts - 1, 0), RETRY_DELAYS_MS.length - 1);
  return RETRY_DELAYS_MS[index] ?? 30000;
}

/**
 * A server answer that retrying cannot fix (validation or permission). Network failures,
 * timeouts and 5xx are retryable. A permanent failure is kept visible and not retried.
 */
export function isPermanentError(error: any): boolean {
  const status = Number(error?.httpStatus ?? error?.status ?? 0);
  const kind = String(error?.exc_type ?? error?.exception ?? "");
  if (/ValidationError|PermissionError|DoesNotExistError/.test(kind))
    return true;
  return status === 400 || status === 401 || status === 403 || status === 404;
}

export function errorMessage(error: any, fallback: string): string {
  const messages = error?.messages;
  if (Array.isArray(messages) && messages.length) {
    return String(messages[0])
      .replace(/<[^>]*>/g, "")
      .slice(0, 300);
  }
  const message = String(error?.message ?? "").trim();
  return (message || fallback).slice(0, 300);
}

/**
 * Best-effort reading of `calls.connectionStatus$`. The vendor documents the stream but
 * not its values, so this is informational only and is labelled unverified in the panel.
 */
export function mapConnection(
  value: unknown
): "connected" | "disconnected" | "unknown" {
  const raw =
    typeof value === "string"
      ? value
      : value && typeof value === "object"
      ? String((value as any).status ?? (value as any).state ?? "")
      : "";
  const key = raw.toLowerCase();
  if (!key) return "unknown";
  if (/(not|dis|lost|offline|reconnect|fail|error)/.test(key))
    return "disconnected";
  if (/connect|online|ready|open/.test(key)) return "connected";
  return "unknown";
}

// --- reading the plugin's own failure reports ------------------------------------------------

export type SdkMessageKind =
  | "auth-rejected"
  | "account-unknown"
  | "http-error"
  | "network";

export interface SdkMessage {
  kind: SdkMessageKind;
  code: number | null;
  text: string;
}

/**
 * `session.login()` fails silently: the plugin only writes the reason to its console, for
 * example `Error Code: 401, Message: Http failure response for https://<account>-api.aswat.co/
 * auth/login: 401 OK`. This turns such a line into something the panel can act on, and returns
 * null for the plugin's ordinary chatter. The text is the vendor's own and is cut short; it
 * contains a URL and a status, never the credentials that were typed.
 */
// --- dialpad -------------------------------------------------------------------------

/** Calling codes the dialpad offers. The agent's pasted number can still name another country. */
export const CALLING_CODES: ReadonlyArray<{
  region: string;
  code: string;
  name: string;
}> = [
  { region: "AE", code: "971", name: "United Arab Emirates" },
  { region: "SA", code: "966", name: "Saudi Arabia" },
  { region: "QA", code: "974", name: "Qatar" },
  { region: "KW", code: "965", name: "Kuwait" },
  { region: "BH", code: "973", name: "Bahrain" },
  { region: "OM", code: "968", name: "Oman" },
  { region: "EG", code: "20", name: "Egypt" },
  { region: "JO", code: "962", name: "Jordan" },
  { region: "LB", code: "961", name: "Lebanon" },
  { region: "IN", code: "91", name: "India" },
  { region: "PK", code: "92", name: "Pakistan" },
  { region: "PH", code: "63", name: "Philippines" },
  { region: "GB", code: "44", name: "United Kingdom" },
  { region: "US", code: "1", name: "United States" },
];

export function callingCodeForRegion(region: unknown): string {
  const key = String(region ?? "")
    .trim()
    .toUpperCase();
  return CALLING_CODES.find((item) => item.region === key)?.code ?? "971";
}

export interface DialDraft {
  /** Selected calling code, digits only. Ignored while `international` is set. */
  callingCode: string;
  /** Digits typed under the selected country. */
  national: string;
  /**
   * A number that already names its country (`+…` or `00…`). The selected calling
   * code must not be prefixed onto it.
   */
  international: string;
}

export function emptyDial(callingCode = "971"): DialDraft {
  return { callingCode, national: "", international: "" };
}

function compactNumber(raw: string): string {
  return raw.replace(/[\s().-]/g, "");
}

/** True when the text already carries a country code. */
export function hasCountryCode(raw: unknown): boolean {
  const compact = compactNumber(String(raw ?? "").trim());
  return compact.startsWith("+") || compact.startsWith("00");
}

/** What the number field shows. An international number is shown with its own code. */
export function dialDisplay(draft: DialDraft): string {
  return draft.international || draft.national;
}

/**
 * The string passed to the existing outbound path. A pasted international number is
 * returned with its own country code; a typed national number is prefixed with the
 * selected calling code. `sanitizeDialNumber` still has the last word.
 */
export function dialForCall(draft: DialDraft): string | null {
  if (draft.international) return sanitizeDialNumber(draft.international);
  const digits = draft.national.replace(/\D/g, "");
  if (!digits) return null;
  return sanitizeDialNumber(`+${draft.callingCode}${digits}`);
}

/** Replace the draft from the number field, including a paste. */
export function draftFromInput(draft: DialDraft, raw: unknown): DialDraft {
  const text = String(raw ?? "");
  if (!text.trim()) return { ...draft, national: "", international: "" };
  if (hasCountryCode(text)) {
    const compact = compactNumber(text.trim());
    const international = compact.startsWith("00")
      ? `+${compact.slice(2).replace(/[^\d*#]/g, "")}`
      : `+${compact.slice(1).replace(/[^\d*#]/g, "")}`;
    return { ...draft, national: "", international };
  }
  return {
    ...draft,
    international: "",
    national: text.replace(/[^\d*#]/g, ""),
  };
}

export function pushDialDigit(draft: DialDraft, digit: string): DialDraft {
  if (!/^[0-9*#]$/.test(digit)) return draft;
  if (draft.international)
    return { ...draft, international: draft.international + digit };
  return { ...draft, national: draft.national + digit };
}

export function dialBackspace(draft: DialDraft): DialDraft {
  if (draft.international) {
    const next = draft.international.slice(0, -1);
    if (next === "+" || !next) return { ...draft, international: "" };
    return { ...draft, international: next };
  }
  return { ...draft, national: draft.national.slice(0, -1) };
}

/** Changing the selector never rewrites a number that already has a country code. */
export function setCallingCode(draft: DialDraft, code: unknown): DialDraft {
  const digits = String(code ?? "").replace(/\D/g, "");
  if (!digits) return draft;
  return { ...draft, callingCode: digits };
}

/** One DTMF sequence for `sendDtmfCall`. Anything else is refused. */
export function dtmfSequence(raw: unknown): string | null {
  const value = String(raw ?? "").replace(/[^0-9*#]/g, "");
  if (!value || value.length > 32) return null;
  return value;
}

/** The softphone exposes reject only when that SDK method is actually present. */
export function exposesReject(calls: { rejectCall?: unknown } | null | undefined): boolean {
  return typeof calls?.rejectCall === "function";
}

export type PresenceKind =
  | "signed-out"
  | "connecting"
  | "reconnecting"
  | "unavailable"
  | "available";

/**
 * What the header dot may say. "Available" is only the string ZIWO reported.
 * An empty status, or any other status (On Break, Meeting, Outgoing), is unavailable.
 */
export function presenceKind(input: {
  sdk: "idle" | "loading" | "ready" | "failed";
  session: "signed-out" | "authenticating" | "signed-in";
  connection: "connected" | "disconnected" | "unknown";
  ziwoStatus: string;
}): PresenceKind {
  if (input.session === "authenticating") return "connecting";
  if (input.sdk === "loading" || input.sdk === "idle") return "connecting";
  if (input.session !== "signed-in") return "signed-out";
  const status = input.ziwoStatus.trim().toLowerCase();
  if (input.connection === "disconnected" || status.includes("reconnect"))
    return "reconnecting";
  if (status === "available") return "available";
  return "unavailable";
}

/** Escape an internal note so it is stored as text, never as markup the timeline runs. */
export function internalNoteHtml(raw: unknown): string {
  const text = String(raw ?? "")
    .replace(/\r\n/g, "\n")
    .slice(0, 8000);
  const escaped = text
    .replace(/&/g, "&amp;")
    .replace(/</g, "&lt;")
    .replace(/>/g, "&gt;");
  return `<p>${escaped.replace(/\n/g, "<br>")}</p>`;
}

export function classifySdkMessage(raw: unknown): SdkMessage | null {
  const text = String(raw ?? "")
    .replace(/\s+/g, " ")
    .trim()
    .slice(0, 240);
  if (!text) return null;
  const code = /Error Code:\s*(\d+)/.exec(text);
  const status = code ? Number(code[1]) : null;
  if (status !== null && status >= 400 && /\/auth\/login/.test(text)) {
    return { kind: "auth-rejected", code: status, text };
  }
  if (status !== null && status >= 400 && /\/info\b/.test(text)) {
    return { kind: "account-unknown", code: status, text };
  }
  if (status !== null && status >= 400)
    return { kind: "http-error", code: status, text };
  // Code 0 and CORS lines come from the plugin's own single-sign-on lookup as well, so they
  // are shown for diagnosis but are never treated as a failed sign-in.
  if (status === 0 || /blocked by CORS policy/.test(text)) {
    return { kind: "network", code: status, text };
  }
  return null;
}
