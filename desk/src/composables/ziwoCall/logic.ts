/**
 * Pure helpers for the ZIWO calling panel (`ZiwoCallUI.vue`). Nothing in this
 * file imports Vue, frappe-ui or an alias, so it can be exercised with
 * `node --test` on its own, the same way `ticketChannel/logic.ts` is.
 *
 * These functions never touch `window.ZIWO` or the network directly; the
 * component passes in whatever it already has (SDK handle, current state,
 * a `post` function) so the decision logic itself stays deterministic and
 * testable without a real SDK or backend.
 */

// --- Call event classification -------------------------------------------

export type ZiwoEventCategory =
  | "ringing"
  | "outbound-progress"
  | "active"
  | "hangup"
  | "unknown";

const RINGING_EVENTS = new Set(["ringing"]);
const OUTBOUND_PROGRESS_EVENTS = new Set(["requesting", "trying", "early"]);
const ACTIVE_EVENTS = new Set(["active", "answering"]);
const HANGUP_EVENTS = new Set(["hangup", "destroy"]);

export function classifyZiwoEvent(eventType: string | null | undefined): ZiwoEventCategory {
  const type = String(eventType || "").toLowerCase();
  if (RINGING_EVENTS.has(type)) return "ringing";
  if (OUTBOUND_PROGRESS_EVENTS.has(type)) return "outbound-progress";
  if (ACTIVE_EVENTS.has(type)) return "active";
  if (HANGUP_EVENTS.has(type)) return "hangup";
  return "unknown";
}

export function inferDirection(outboundInFlight: boolean): "Outbound" | "Inbound" {
  return outboundInFlight ? "Outbound" : "Inbound";
}

// --- Duplicate outbound call guard ----------------------------------------

export type ZiwoCallStatus = "" | "ringing" | "active" | "ended";

export interface OutboundGuardState {
  outboundInFlight: boolean;
  callStatus: ZiwoCallStatus;
}

/**
 * Whether a *new* outbound call may be started right now. A call already in
 * flight, ringing or active must block a second attempt from the same
 * agent action (e.g. a double click on "Call", or the dialog's "Call"
 * button firing while a ticket-contact "Call" button is also mid-attempt) —
 * ZIWO itself is not asked to deduplicate this for us.
 */
export function canStartOutboundCall(state: OutboundGuardState): boolean {
  if (state.outboundInFlight) return false;
  if (state.callStatus === "ringing" || state.callStatus === "active") return false;
  return true;
}

// --- Call method selection --------------------------------------------------

export interface ZiwoCallsSdk {
  clickToCall?: (...args: unknown[]) => unknown;
  startCall?: (...args: unknown[]) => unknown;
}

export type ZiwoCallMethod = "clickToCall" | "startCall" | null;

/**
 * Decide which ZIWO calling method to use, purely from what the SDK exposes
 * *before* any invocation happens. This must never be re-decided based on a
 * runtime outcome (a rejected promise, an undefined return value, or any
 * other "uncertain outcome" from the first attempt) — doing so risks placing
 * a second real call against the provider for one agent action. If the
 * chosen method's single attempt fails, the caller reports the failure; it
 * must not silently retry with the other method.
 */
export function chooseCallMethod(sdkCalls: ZiwoCallsSdk | null | undefined): ZiwoCallMethod {
  if (!sdkCalls) return null;
  if (typeof sdkCalls.clickToCall === "function") return "clickToCall";
  if (typeof sdkCalls.startCall === "function") return "startCall";
  return null;
}

// --- Bounded retry for posting one observed call event ---------------------

export interface RetryOptions {
  /** Additional attempts after the first. Total attempts = retries + 1. */
  retries?: number;
  baseDelayMs?: number;
  wait?: (ms: number) => Promise<void>;
}

export interface RetryResult {
  ok: boolean;
  attempts: number;
}

const defaultWait = (ms: number) => new Promise<void>((resolve) => setTimeout(resolve, ms));

/**
 * Posts one observed call event with a small bounded retry and exponential
 * backoff. This reduces, but does not eliminate, the chance that a transient
 * network failure loses the client's only report of one event: if every
 * attempt fails, the event is NOT queued for a later retry — it is reported
 * as lost (the caller must surface this, never claim success). A later event
 * for the same call (e.g. the eventual hangup) is unaffected and is posted
 * independently; only the specific failed observation's audit trail has a
 * gap. There is no backend reconciliation for this class of loss: the
 * scheduled `recover_pending_enrichment` job only recovers *enrichment* of
 * calls that already reached "Ended" in the Call Log, not events that never
 * reached the backend at all.
 */
export async function postWithRetry<T>(
  post: () => Promise<T>,
  { retries = 2, baseDelayMs = 500, wait = defaultWait }: RetryOptions = {}
): Promise<RetryResult> {
  let attempts = 0;
  for (;;) {
    attempts += 1;
    try {
      await post();
      return { ok: true, attempts };
    } catch {
      if (attempts > retries) {
        return { ok: false, attempts };
      }
      await wait(baseDelayMs * 2 ** (attempts - 1));
    }
  }
}

// --- Listener lifecycle guard ------------------------------------------------

export interface ListenerRegistry {
  install: () => void;
  remove: () => void;
  isInstalled: () => boolean;
}

/**
 * Wraps window event (un)registration so repeated `install()` calls (e.g. if
 * a parent watcher calls `setup()` more than once) never register the same
 * handler twice, and `remove()` is a no-op when nothing is installed. The
 * target's `addEventListener`/`removeEventListener` are injected so this is
 * testable without a real `window`.
 */
export function createListenerRegistry(
  target: { addEventListener: Function; removeEventListener: Function },
  eventNames: string[],
  handler: (e: Event) => void
): ListenerRegistry {
  let installed = false;
  return {
    install() {
      if (installed) return;
      eventNames.forEach((name) => target.addEventListener(name, handler));
      installed = true;
    },
    remove() {
      if (!installed) return;
      eventNames.forEach((name) => target.removeEventListener(name, handler));
      installed = false;
    },
    isInstalled: () => installed,
  };
}

export const ZIWO_WINDOW_EVENTS = [
  "ziwo-call-ringing",
  "ziwo-call-requesting",
  "ziwo-call-trying",
  "ziwo-call-early",
  "ziwo-call-attach",
  "ziwo-call-answering",
  "ziwo-call-active",
  "ziwo-call-recovering",
  "ziwo-call-hangup",
  "ziwo-call-destroy",
];
