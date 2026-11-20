/**
 * Framework-free controller for the embedded ZIWO softphone.
 *
 * It owns everything that has a rule: SDK attachment, sign-in readiness, one outbound
 * dispatch per action, call-id based controls, the per-call registry that keeps direction,
 * number and originating ticket for the whole call, and the visible outbox of events that
 * have not been saved yet. It never touches Vue, the DOM or the network directly, and it
 * receives the SDK window, the server call and the timers from its caller, so the whole
 * thing is exercised in tests with plain fakes.
 *
 * Secrets: the password is only ever a function argument here. It is passed to the SDK
 * and not stored, logged or sent anywhere else. The SDK's session token is never read:
 * `session.info$` is used for the presence of a session and the agent's name only.
 */
import {
  CALL_EVENT_NAME,
  PERSISTED_CATEGORIES,
  canDial,
  classifyEvent,
  classifySdkMessage,
  describeShape,
  directionHint,
  errorMessage,
  isPermanentError,
  mapConnection,
  MAX_UNSAVED_AGE_MS,
  nextRetryDelay,
  dtmfSequence,
  exposesReject,
  parseCallEvent,
  sanitizeDialNumber,
  type Direction,
  type IntentState,
  type ParsedEvent,
} from "./logic.ts";

export const LOGIN_TIMEOUT_MS = 25000;
/** After an outbound dispatch that returned no call id, how long to wait for an event. */
export const DISPATCH_WAIT_MS = 15000;
/** After a rejected dispatch, how long to wait to be sure no call was placed anyway. */
export const REJECT_CONFIRM_MS = 8000;
/** How long End call waits for ZIWO to confirm before the agent may try again. */
export const HANGUP_CONFIRM_MS = 15000;
const ACCOUNT_NAME = /^[A-Za-z0-9][A-Za-z0-9-]{0,62}$/;
const MAX_CALLS_KEPT = 12;

interface Subscribable {
  subscribe(next: (value: any) => void): { unsubscribe(): void };
}

export interface ZiwoSdk {
  session?: {
    info$?: Subscribable;
    login?: (account: string, email: string, password: string) => unknown;
    logout?: () => unknown;
  };
  calls?: {
    startCall?: (phoneNumber: string) => Promise<any> | any;
    answerCall?: (callId: string) => unknown;
    rejectCall?: (callId: string) => unknown;
    hangUpCall?: (callId: string) => unknown;
    muteCall?: (callId: string) => unknown;
    unMuteCall?: (callId: string) => unknown;
    holdCall?: (callId: string) => unknown;
    unHoldCall?: (callId: string) => unknown;
    /** Tones for the agent leg named by `callId`. Not the primary call id. */
    sendDtmfCall?: (callId: string, sequence: string) => unknown;
    reconnect?: () => unknown;
    connectionStatus$?: Subscribable;
  };
  /** Agent availability. `status$` is a string such as "Available". Never a token. */
  status?: {
    status$?: Subscribable;
  };
}

export interface ZiwoWindowLike {
  ZIWO?: ZiwoSdk;
  /** The plugin writes its failure reasons here. Observed, never replaced. */
  console?: { error?: (...args: any[]) => unknown };
  addEventListener(name: string, handler: (event: any) => void): void;
  removeEventListener(name: string, handler: (event: any) => void): void;
}

export interface ControllerDeps {
  /** Calls `inchaa_custmization.integrations.ziwo.api.<method>`. Rejects on failure. */
  post(method: string, args: Record<string, unknown>): Promise<any>;
  now?: () => number;
  uuid?: () => string;
  setTimeout?: (fn: () => void, ms: number) => any;
  clearTimeout?: (handle: any) => void;
  /** Called after any state change. */
  onChange?: () => void;
  /** Called after a call or a link has been saved on the server (refresh history). */
  onPersisted?: () => void;
}

export interface Lookup {
  contacts: { name: string; label: string; phone?: string }[];
  tickets: {
    name: string;
    subject: string;
    status?: string;
    contact?: string;
  }[];
  requires_selection: boolean;
}

export interface TicketChoice {
  name: string;
  subject?: string;
  status?: string;
  contact?: string;
}

export interface TicketField {
  fieldname: string;
  label: string;
  fieldtype: string;
  options?: string;
  reqd?: number;
}

/** What the server says the agent may do with one saved call. Read-only. */
export interface TicketPanel {
  call_log: string;
  status?: string;
  linked: boolean;
  link_source?: string;
  ticket: TicketChoice | null;
  contact: { name: string; label: string } | null;
  contacts: { name: string; label: string; phone?: string }[];
  needs_contact: boolean;
  unknown_caller: boolean;
  tickets: TicketChoice[];
  fields: TicketField[];
}

export interface CallView {
  callId: string;
  direction: Direction;
  number: string;
  status: "ringing" | "active" | "ended";
  answered: boolean;
  muted: boolean;
  held: boolean;
  /** The ticket the agent dialed from. Set once, never changed by navigation. */
  originTicket: string;
  /** Why the originating ticket was not linked, when the server refused. */
  originError: string;
  /** The Contact the agent dialed. Set once, from the Contact page. */
  originContact: string;
  /** Why that Contact was not linked, when the server refused. */
  originContactError: string;
  /** What the server holds. */
  ticket: string;
  contact: string;
  /** Local Inchaa Ziwo Call Log name. Server actions for linking use this, not the provider id. */
  logName: string;
  /** Open tickets and the create form for this saved call. */
  panel: TicketPanel | null;
  panelError: string;
  saved: boolean;
  recovered: boolean;
  /** The session ended while this call was live, so its end was never seen. */
  endUnconfirmed: boolean;
  /** End call was sent and ZIWO has not confirmed the call ended yet. */
  ending: boolean;
  /** Set when ZIWO does not confirm the end, so the agent can try again explicitly. */
  endError: string;
  startedAt: number;
  /** When the first `active` event was seen. Drives the on-call timer. */
  answeredAt: number | null;
  endedAt: number | null;
  endCause: string;
  lookup: Lookup | null;
  lookupError: string;
}

interface OutboxItem {
  id: string;
  callId: string;
  payload: Record<string, unknown>;
  attempts: number;
  firstAt: number;
  nextAt: number;
  dead: boolean;
  error: string;
}

interface Intent {
  state: IntentState;
  number: string;
  ticket: string;
  contact: string;
  error: string;
  timer: any;
}

export interface ControllerSnapshot {
  sdk: "idle" | "loading" | "ready" | "failed";
  sdkError: string;
  session: "signed-out" | "authenticating" | "signed-in";
  authError: string;
  expired: boolean;
  agentName: string;
  connection: "connected" | "disconnected" | "unknown";
  /** The availability string ZIWO last reported. Empty until it does. */
  ziwoStatus: string;
  /** True only when this SDK build exposes `rejectCall`. */
  canReject: boolean;
  calls: CallView[];
  liveCall: CallView | null;
  ringingCall: CallView | null;
  intent: {
    state: IntentState;
    number: string;
    ticket: string;
    contact: string;
    error: string;
  } | null;
  dialError: string;
  unsaved: { count: number; permanent: number; error: string };
  unparsedEvents: number;
  lastEventShape: string;
  /** The plugin's own recent failure lines (vendor text, no credentials). */
  sdkMessages: string[];
}

export interface ActionResult {
  ok: boolean;
  error?: string;
  pending?: boolean;
  tickets?: TicketChoice[];
}

const fail = (error: string): ActionResult => ({ ok: false, error });

function lastDigits(value: string, count = 8): string {
  return value.replace(/\D/g, "").slice(-count);
}

export class ZiwoController {
  deps: ControllerDeps;
  private sdkState: ControllerSnapshot["sdk"] = "idle";
  private sdkError = "";
  private session: ControllerSnapshot["session"] = "signed-out";
  private authError = "";
  private expired = false;
  private agentName = "";
  private connection: ControllerSnapshot["connection"] = "unknown";
  private ziwoStatus = "";
  private calls = new Map<string, CallView>();
  private seen = new Map<string, Set<string>>();
  private lookingUp = new Set<string>();
  private panelTokens = new Map<string, number>();
  private intent: Intent | null = null;
  private dialError = "";
  private outbox: OutboxItem[] = [];
  private unparsedEvents = 0;
  private lastEventShape = "";
  private sdkMessages: string[] = [];
  private consoleTap: { target: any; original: any; tap: any } | null = null;
  private win: ZiwoWindowLike | null = null;
  private infoSub: { unsubscribe(): void } | null = null;
  private connSub: { unsubscribe(): void } | null = null;
  private statusSub: { unsubscribe(): void } | null = null;
  /** Swallows a second click of the same call control before the first has settled. */
  private acting = new Set<string>();
  /** Call whose ticket draft is open. Trim must not drop it. */
  private pinnedCallId = "";
  private hangupTimers = new Map<string, any>();
  private authTimer: any = null;
  private retryTimer: any = null;
  private flushing = false;
  private flushAgain = false;
  private intentionalLogout = false;
  private disposed = false;
  private handler: (event: any) => void;
  private statusHandler: (event: any) => void;

  constructor(deps: ControllerDeps) {
    this.deps = deps;
    this.handler = (event: any) => this.handleEvent(event);
    this.statusHandler = (event: any) => this.onStatusEvent(event);
  }

  // --- time, ids, notifications ---------------------------------------------------

  private now(): number {
    return (this.deps.now ?? Date.now)();
  }

  private uuid(): string {
    return (this.deps.uuid ?? (() => globalThis.crypto.randomUUID()))();
  }

  private later(fn: () => void, ms: number): any {
    return (this.deps.setTimeout ?? setTimeout)(fn, ms);
  }

  private cancel(handle: any): void {
    if (handle !== null && handle !== undefined) {
      (this.deps.clearTimeout ?? clearTimeout)(handle);
    }
  }

  private notify(): void {
    if (this.disposed) return;
    try {
      this.deps.onChange?.();
    } catch {
      // A fault in the screen must never stop an event being handled or saved.
    }
  }

  // --- SDK and session ------------------------------------------------------------

  setSdkLoading(): void {
    this.sdkState = "loading";
    this.sdkError = "";
    this.notify();
  }

  setSdkFailed(message: string): void {
    this.sdkState = "failed";
    this.sdkError = message;
    this.notify();
  }

  private sdk(): ZiwoSdk | null {
    return this.win?.ZIWO ?? null;
  }

  /**
   * Bind to the SDK window. Safe to call again: the previous binding is removed first, so
   * a reloaded frame can never leave two listeners behind.
   */
  attach(win: ZiwoWindowLike): void {
    if (this.disposed) return;
    this.detach();
    this.win = win;
    this.sdkState = "ready";
    this.sdkError = "";
    win.addEventListener(CALL_EVENT_NAME, this.handler);
    win.addEventListener("ziwo-status-update", this.statusHandler);
    this.tapConsole(win);
    this.subscribeStatus();
    const info = win.ZIWO?.session?.info$;
    if (info) {
      this.infoSub = info.subscribe((value: any) => this.onSessionInfo(value));
    }
    this.notify();
  }

  /**
   * The plugin reports a failed sign-in only through its console. Forward each error line to
   * `noteSdkMessage`, and still to the original console so nothing is hidden from DevTools.
   */
  private tapConsole(win: ZiwoWindowLike): void {
    const target: any = win.console;
    const original = target?.error;
    if (!target || typeof original !== "function") return;
    const tap = (...args: any[]) => {
      try {
        this.noteSdkMessage(args.map((arg) => String(arg)).join(" "));
      } catch {
        // Reading a log line must never break the plugin's own logging.
      }
      return original.apply(target, args);
    };
    target.error = tap;
    this.consoleTap = { target, original, tap };
  }

  private untapConsole(): void {
    const held = this.consoleTap;
    this.consoleTap = null;
    // Put the original back, unless something else has wrapped it since.
    if (held && held.target.error === held.tap)
      held.target.error = held.original;
  }

  /** One failure line from the plugin. A rejected sign-in is reported at once, not after 25 s. */
  noteSdkMessage(raw: unknown): void {
    const message = classifySdkMessage(raw);
    if (!message) return;
    this.sdkMessages = [...this.sdkMessages, message.text].slice(-5);
    if (this.session === "authenticating") {
      if (message.kind === "auth-rejected") {
        this.failAuth(
          "ZIWO rejected this email or password (HTTP " +
            message.code +
            "). Check both. If you normally sign in to ZIWO with Google, Microsoft or another single sign-on, use ZIWO's own panel below instead."
        );
        return;
      }
      if (message.kind === "account-unknown") {
        this.failAuth(
          "ZIWO does not recognise this account name (HTTP " +
            message.code +
            "). The account name is the instance name only, for example inchaa."
        );
        return;
      }
    }
    this.notify();
  }

  private failAuth(message: string): void {
    this.cancel(this.authTimer);
    this.authTimer = null;
    this.session = "signed-out";
    this.authError = message;
    this.notify();
  }

  detach(): void {
    this.untapConsole();
    if (this.win) {
      this.win.removeEventListener(CALL_EVENT_NAME, this.handler);
      this.win.removeEventListener("ziwo-status-update", this.statusHandler);
    }
    this.infoSub?.unsubscribe();
    this.connSub?.unsubscribe();
    this.statusSub?.unsubscribe();
    this.infoSub = null;
    this.connSub = null;
    this.statusSub = null;
    this.win = null;
  }

  dispose(): void {
    this.detach();
    this.cancel(this.authTimer);
    this.cancel(this.retryTimer);
    this.cancel(this.intent?.timer);
    for (const handle of this.hangupTimers.values()) this.cancel(handle);
    this.hangupTimers.clear();
    this.authTimer = null;
    this.retryTimer = null;
    this.disposed = true;
  }

  /** Keep this call while a ticket draft is open, even after it ends. */
  pin(callId: string | null): void {
    this.pinnedCallId = String(callId ?? "");
  }

  /**
   * `session.info$` is the only reliable sign that a session exists. `session.login()`
   * returns nothing and reports a failed sign-in only in the plugin's own log, so the
   * session is signed in when this emits a name, and a timeout covers the failure case.
   */
  private onSessionInfo(value: any): void {
    const name =
      value && typeof value === "object" ? String(value.name ?? "").trim() : "";
    if (name) {
      this.cancel(this.authTimer);
      this.authTimer = null;
      this.session = "signed-in";
      this.agentName = name;
      this.authError = "";
      this.expired = false;
      this.intentionalLogout = false;
      this.subscribeConnection();
      this.subscribeStatus();
      this.notify();
      return;
    }
    if (this.session === "signed-in") {
      this.connSub?.unsubscribe();
      this.connSub = null;
      this.statusSub?.unsubscribe();
      this.statusSub = null;
      this.connection = "unknown";
      this.ziwoStatus = "";
      this.agentName = "";
      this.session = "signed-out";
      this.markLiveCallsUnconfirmed();
      if (!this.intentionalLogout) {
        this.expired = true;
        this.authError = "Your ZIWO session ended. Sign in again.";
      }
      this.intentionalLogout = false;
      this.notify();
    }
    // An empty value while signing in, or before any session, is the stream's start.
  }

  private subscribeConnection(): void {
    this.connSub?.unsubscribe();
    this.connSub = null;
    try {
      const stream = this.sdk()?.calls?.connectionStatus$;
      if (stream) {
        this.connSub = stream.subscribe((value: any) => {
          this.connection = mapConnection(value);
          this.notify();
        });
      }
    } catch {
      this.connection = "unknown";
    }
  }

  /**
   * `status$` is documented as a string ("Available", "On Break", …). Only a string is
   * stored. An object is ignored so a session payload cannot be copied into the panel.
   */
  private subscribeStatus(): void {
    this.statusSub?.unsubscribe();
    this.statusSub = null;
    try {
      const stream = this.sdk()?.status?.status$;
      if (!stream) return;
      this.statusSub = stream.subscribe((value: unknown) => {
        if (typeof value !== "string") return;
        this.applyStatus(value);
      });
    } catch {
      this.statusSub = null;
    }
  }

  private onStatusEvent(event: any): void {
    const detail = event?.detail;
    if (typeof detail !== "string") return;
    this.applyStatus(detail);
  }

  private applyStatus(raw: string): void {
    const next = raw.trim().slice(0, 40);
    if (next === this.ziwoStatus) return;
    this.ziwoStatus = next;
    this.notify();
  }

  private markLiveCallsUnconfirmed(): void {
    for (const call of this.calls.values()) {
      if (call.status !== "ended") {
        call.status = "ended";
        call.endUnconfirmed = true;
        call.endedAt = call.endedAt ?? this.now();
      }
    }
  }

  async login(
    account: string,
    email: string,
    password: string
  ): Promise<ActionResult> {
    const name = String(account ?? "").trim();
    const user = String(email ?? "").trim();
    if (!ACCOUNT_NAME.test(name)) {
      return fail(
        "Enter the ZIWO account name only, for example inchaa. It is not a host name."
      );
    }
    if (!user || !password) return fail("Enter your ZIWO email and password.");
    if (this.session === "signed-in") return { ok: true };
    if (this.session === "authenticating")
      return fail("Sign-in is already in progress.");
    const login = this.sdk()?.session?.login;
    if (typeof login !== "function")
      return fail("The ZIWO softphone is not ready yet.");

    this.session = "authenticating";
    this.authError = "";
    this.expired = false;
    this.cancel(this.authTimer);
    this.authTimer = this.later(() => {
      this.authTimer = null;
      if (this.session === "authenticating") {
        this.session = "signed-out";
        this.authError =
          "ZIWO did not confirm the sign-in within 25 seconds. Check the account name, email and password and try again. The ZIWO panel shows the provider's exact message.";
        this.notify();
      }
    }, LOGIN_TIMEOUT_MS);
    this.notify();
    try {
      // login() returns nothing and fails silently; info$ and the timeout decide the outcome.
      const returned: any = login.call(
        this.sdk()!.session,
        name,
        user,
        password
      );
      if (returned && typeof returned.then === "function") await returned;
    } catch (error) {
      this.cancel(this.authTimer);
      this.authTimer = null;
      this.session = "signed-out";
      this.authError = errorMessage(error, "ZIWO sign-in failed.");
      this.notify();
      return fail(this.authError);
    }
    return { ok: true, pending: true };
  }

  logout(): ActionResult {
    const logout = this.sdk()?.session?.logout;
    if (typeof logout !== "function")
      return fail("The ZIWO softphone is not ready.");
    this.intentionalLogout = true;
    this.cancel(this.authTimer);
    this.authTimer = null;
    try {
      logout.call(this.sdk()!.session);
    } catch (error) {
      this.intentionalLogout = false;
      return fail(errorMessage(error, "Sign-out failed."));
    }
    return { ok: true };
  }

  reconnect(): ActionResult {
    try {
      this.sdk()?.calls?.reconnect?.();
      return { ok: true };
    } catch (error) {
      return fail(errorMessage(error, "Reconnect failed."));
    }
  }

  // --- dialing --------------------------------------------------------------------

  private hasLiveCall(): boolean {
    for (const call of this.calls.values())
      if (call.status !== "ended") return true;
    return false;
  }

  /**
   * Place one outbound call. The number goes to `startCall` as a string, exactly once. A
   * failure or an unconfirmed result never falls back to another calling method: that could
   * place a second real call.
   */
  async dial(
    rawNumber: string,
    options: { ticket?: string; contact?: string } = {}
  ): Promise<ActionResult> {
    const number = sanitizeDialNumber(rawNumber);
    if (!number)
      return fail("Enter a valid phone number, with the country code.");
    const guard = canDial({
      sdkReady: this.sdkState === "ready",
      signedIn: this.session === "signed-in",
      intentState: this.intent?.state ?? null,
      hasLiveCall: this.hasLiveCall(),
    });
    if (!guard.ok) return fail(guard.reason);
    const start = this.sdk()?.calls?.startCall;
    if (typeof start !== "function")
      return fail("The ZIWO softphone cannot place calls.");

    const intent: Intent = {
      state: "dispatching",
      number,
      ticket: String(options.ticket ?? "").trim(),
      contact: String(options.contact ?? "").trim(),
      error: "",
      timer: null,
    };
    this.intent = intent;
    this.dialError = "";
    this.notify();

    let result: any;
    try {
      result = await start.call(this.sdk()!.calls, number);
    } catch (error) {
      if (this.intent !== intent || intent.state !== "dispatching")
        return { ok: true };
      // The plugin rejected, which usually means no call was placed. Be sure before
      // allowing another attempt: wait briefly for an outbound event.
      intent.state = "awaiting-event";
      intent.error = errorMessage(error, "ZIWO could not place the call.");
      this.cancel(intent.timer);
      intent.timer = this.later(() => {
        if (this.intent === intent) {
          this.intent = null;
          this.dialError = intent.error;
          this.notify();
        }
      }, REJECT_CONFIRM_MS);
      this.notify();
      return fail(intent.error);
    }

    if (this.intent !== intent) return { ok: true }; // an event already bound this attempt
    const callId = String(result?.callId ?? "").trim();
    if (callId) {
      this.bindOutbound(intent, callId);
      return { ok: true };
    }
    intent.state = "awaiting-event";
    this.cancel(intent.timer);
    intent.timer = this.later(() => {
      if (this.intent === intent && intent.state === "awaiting-event") {
        intent.state = "uncertain";
        this.notify();
      }
    }, DISPATCH_WAIT_MS);
    this.notify();
    return { ok: true, pending: true };
  }

  /** The agent has checked ZIWO and confirms no call was placed. */
  acknowledgeUncertain(): void {
    if (this.intent?.state === "uncertain") {
      this.cancel(this.intent.timer);
      this.intent = null;
      this.notify();
    }
  }

  private bindOutbound(intent: Intent, callId: string): CallView {
    this.cancel(intent.timer);
    if (this.intent === intent) this.intent = null;
    let call = this.calls.get(callId);
    if (!call) {
      call = this.newCall(callId, "Outbound", intent.number);
      call.originTicket = intent.ticket;
      call.originContact = intent.contact;
      call.status = "ringing";
      this.calls.set(callId, call);
      this.trim();
      void this.runLookup(call);
    } else {
      // The first SDK event can arrive before startCall returns, with no number on it.
      if (!call.number) call.number = intent.number;
      if (!call.originTicket) call.originTicket = intent.ticket;
      if (!call.originContact) call.originContact = intent.contact;
    }
    this.notify();
    return call;
  }

  // --- events ---------------------------------------------------------------------

  private newCall(
    callId: string,
    direction: Direction,
    number: string
  ): CallView {
    return {
      callId,
      direction,
      number,
      status: "ringing",
      answered: false,
      muted: false,
      held: false,
      originTicket: "",
      originError: "",
      originContact: "",
      originContactError: "",
      ticket: "",
      contact: "",
      logName: "",
      panel: null,
      panelError: "",
      saved: false,
      recovered: false,
      endUnconfirmed: false,
      ending: false,
      endError: "",
      startedAt: this.now(),
      answeredAt: null,
      endedAt: null,
      endCause: "",
      lookup: null,
      lookupError: "",
    };
  }

  private seenFor(callId: string): Set<string> {
    let seen = this.seen.get(callId);
    if (!seen) {
      seen = new Set();
      this.seen.set(callId, seen);
    }
    return seen;
  }

  private trim(): void {
    if (this.calls.size <= MAX_CALLS_KEPT) return;
    const ended = [...this.calls.values()].filter(
      (c) => c.status === "ended" && c.saved
    );
    ended.sort((a, b) => a.startedAt - b.startedAt);
    while (this.calls.size > MAX_CALLS_KEPT && ended.length) {
      const gone = ended.shift()!;
      if (gone.callId === this.pinnedCallId) continue;
      this.calls.delete(gone.callId);
      this.seen.delete(gone.callId);
      this.clearHangupTimer(gone.callId);
    }
  }

  /**
   * Whether an unknown outbound call is our own pending dispatch. Even an attempt already
   * marked uncertain is matched by a late event, which settles the uncertainty. When the
   * event carries the destination it must be the number we dialed, so a call placed some
   * other way (the vendor panel) is never attributed to a ticket by mistake.
   */
  private intentMatches(parsed: ParsedEvent): boolean {
    const intent = this.intent;
    if (!intent) return false;
    if (parsed.number && intent.number) {
      return lastDigits(parsed.number) === lastDigits(intent.number);
    }
    return true;
  }

  private handleEvent(event: any): void {
    const detail = event?.detail;
    this.lastEventShape = describeShape(detail);
    const parsed = parseCallEvent(detail);
    if (!parsed) {
      // Only a lifecycle event without an id is a problem worth showing. Events that carry
      // no call at all (such as the SDK's own "ready") are normal.
      if (PERSISTED_CATEGORIES.has(classifyEvent(detail?.type))) {
        this.unparsedEvents += 1;
        this.notify();
      }
      return;
    }
    const hint = directionHint(parsed.type);
    let call = this.calls.get(parsed.callId);

    if (!call) {
      let originTicket = "";
      let originContact = "";
      let dialed = "";
      if (hint === "Outbound" && this.intentMatches(parsed)) {
        // The first outbound event after our own dispatch is that dispatch. Its first events
        // carry no number, so the number we dialed is kept for the call record.
        originTicket = this.intent!.ticket;
        originContact = this.intent!.contact;
        dialed = this.intent!.number;
        this.cancel(this.intent!.timer);
        this.intent = null;
      }
      call = this.newCall(parsed.callId, hint, parsed.number || dialed);
      call.originTicket = originTicket;
      call.originContact = originContact;
      this.calls.set(parsed.callId, call);
      this.trim();
    } else if (call.direction === "Unknown" && hint !== "Unknown") {
      call.direction = hint;
    }
    if (!call.number && parsed.number) call.number = parsed.number;

    this.applyLocal(call, parsed);
    if (PERSISTED_CATEGORIES.has(parsed.category)) {
      // A lifecycle event happens once per call, so a repeat from the SDK is not sent again
      // (the server also collapses it). Recovery markers can legitimately repeat.
      const seen = this.seenFor(call.callId);
      if (parsed.category === "recovery" || !seen.has(parsed.type)) {
        seen.add(parsed.type);
        this.enqueue(call, parsed);
      }
    }
    if (call.number && !call.lookup && !call.lookupError)
      void this.runLookup(call);
    this.notify();
  }

  private applyLocal(call: CallView, parsed: ParsedEvent): void {
    const type = parsed.type;
    if (type === "mute") call.muted = true;
    else if (type === "unmute") call.muted = false;
    else if (type === "held") call.held = true;
    else if (type === "unheld") call.held = false;

    switch (parsed.category) {
      case "ringing":
      case "progress":
        break; // never moves a call backwards
      case "recovery":
        call.recovered = true;
        if (call.status !== "ended") call.status = "active";
        break;
      case "active":
        call.answered = true;
        call.answeredAt = call.answeredAt ?? this.now();
        if (call.status !== "ended") call.status = "active";
        break;
      case "end":
        call.status = "ended";
        call.endedAt = call.endedAt ?? this.now();
        call.ending = false;
        call.endError = "";
        this.clearHangupTimer(call.callId);
        if (parsed.cause && !call.endCause) call.endCause = parsed.cause;
        break;
      default:
        break;
    }
  }

  // --- saving events (visible outbox) ---------------------------------------------

  private enqueue(call: CallView, parsed: ParsedEvent): void {
    const payload: Record<string, unknown> = {
      call_id: call.callId,
      event_type: parsed.type,
      direction: call.direction,
      customer_number: call.number,
      primary_call_id: parsed.primaryCallId,
      cause: parsed.cause,
      cause_code: parsed.causeCode,
      client_event_id: this.uuid(),
      occurred_at_ms: this.now(),
    };
    // Keep offering the originating ticket until the server holds a link, so a lost first
    // event cannot lose it. Stop once the server has refused it.
    if (call.originTicket && !call.ticket && !call.originError)
      payload.ticket = call.originTicket;
    if (call.originContact && !call.contact && !call.originContactError)
      payload.contact = call.originContact;
    const now = this.now();
    this.outbox.push({
      id: String(payload.client_event_id),
      callId: call.callId,
      payload,
      attempts: 0,
      firstAt: now,
      nextAt: now,
      dead: false,
      error: "",
    });
    void this.flush();
  }

  /** Save pending events in order, one at a time. Retries on its own; failures stay visible. */
  async flush(): Promise<void> {
    if (this.disposed) return;
    if (this.flushing) {
      // An event arrived while saving: the running pass will take it before it returns.
      this.flushAgain = true;
      return;
    }
    this.flushing = true;
    let saved = 0;
    try {
      do {
        this.flushAgain = false;
        for (const item of [...this.outbox]) {
          if (item.dead || item.nextAt > this.now()) continue;
          const call = this.calls.get(item.callId);
          // Re-evaluate the hint against current knowledge before each attempt.
          if (call) {
            item.payload.direction = call.direction;
            if (call.originTicket && !call.ticket && !call.originError) {
              item.payload.ticket = call.originTicket;
            } else {
              delete item.payload.ticket;
            }
            if (call.originContact && !call.contact && !call.originContactError) {
              item.payload.contact = call.originContact;
            } else {
              delete item.payload.contact;
            }
          }
          try {
            const result = await this.deps.post(
              "record_call_event",
              item.payload
            );
            this.outbox = this.outbox.filter((entry) => entry !== item);
            if (call && result?.call) this.applyServer(call, result);
            saved += 1;
          } catch (error) {
            item.attempts += 1;
            item.error = errorMessage(error, "The event could not be saved.");
            const tooOld = this.now() - item.firstAt > MAX_UNSAVED_AGE_MS;
            if (isPermanentError(error) || tooOld) {
              item.dead = true;
            } else {
              item.nextAt = this.now() + nextRetryDelay(item.attempts);
            }
          }
        }
      } while (this.flushAgain && !this.disposed);
    } finally {
      this.flushing = false;
      this.scheduleRetry();
      this.notify();
    }
    if (saved) this.deps.onPersisted?.();
  }

  private scheduleRetry(): void {
    this.cancel(this.retryTimer);
    this.retryTimer = null;
    const pending = this.outbox.filter((item) => !item.dead);
    if (!pending.length || this.disposed) return;
    const wait = Math.max(
      Math.min(...pending.map((item) => item.nextAt)) - this.now(),
      250
    );
    this.retryTimer = this.later(() => {
      this.retryTimer = null;
      void this.flush();
    }, wait);
  }

  /** Manual retry, including events that stopped retrying on their own. */
  retryUnsaved(): void {
    for (const item of this.outbox) {
      item.dead = false;
      item.attempts = 0;
      item.nextAt = this.now();
      item.firstAt = this.now();
    }
    void this.flush();
  }

  private applyServer(call: CallView, result: any): void {
    const server = result.call;
    const hadLog = Boolean(call.logName);
    call.saved = true;
    call.logName = String(server.name || call.logName || "");
    call.ticket = String(server.ticket ?? "");
    call.contact = String(server.contact ?? "");
    // The server's stored direction is the canonical one for the rest of the call.
    if (server.direction === "Inbound" || server.direction === "Outbound") {
      call.direction = server.direction;
    }
    const origin = String(result.origin_link ?? "");
    if (origin && origin !== "linked" && origin !== "already_linked") {
      call.originError = origin;
    }
    const originContact = String(result.origin_contact_link ?? "");
    if (
      originContact &&
      originContact !== "linked" &&
      originContact !== "already_linked"
    ) {
      call.originContactError = originContact;
    }
    if (!hadLog && call.logName) void this.refreshPanel(call);
  }

  /** Reload the ticket choices for a call that has been saved. Failures stay on the call. */
  async refreshPanel(call: CallView): Promise<void> {
    if (!call.logName) return;
    const token = (this.panelTokens.get(call.callId) ?? 0) + 1;
    this.panelTokens.set(call.callId, token);
    try {
      const panel = (await this.deps.post("get_call_ticket_panel", {
        call_log: call.logName,
      })) as TicketPanel;
      if (this.panelTokens.get(call.callId) !== token) return;
      if (panel?.call_log) {
        call.panel = panel;
        call.panelError = "";
        if (panel.ticket?.name) call.ticket = panel.ticket.name;
      }
    } catch (error) {
      if (this.panelTokens.get(call.callId) !== token) return;
      call.panelError = errorMessage(
        error,
        "Tickets for this call could not be loaded."
      );
    }
    this.notify();
  }

  // --- controls: always by call id ------------------------------------------------

  private control(
    callId: string,
    name: string,
    allowed: (call: CallView) => string
  ): ActionResult {
    const call = this.calls.get(callId);
    if (!call) return fail("That call is no longer tracked.");
    const refusal = allowed(call);
    if (refusal) return fail(refusal);
    const fn: any = (this.sdk()?.calls as any)?.[name];
    if (typeof fn !== "function")
      return fail("The ZIWO softphone cannot do that.");
    const key = `${callId}:${name}`;
    if (this.acting.has(key))
      return fail("That action is already in progress.");
    this.acting.add(key);
    this.later(() => this.acting.delete(key), 400);
    try {
      // Controls always name the agent leg (`call.callId`), never the primary call id.
      fn.call(this.sdk()!.calls, call.callId);
      return { ok: true };
    } catch (error) {
      this.acting.delete(key);
      return fail(errorMessage(error, "ZIWO could not do that."));
    }
  }

  /**
   * Send one DTMF sequence to the active agent leg. A repeated digit is a real tone,
   * so this is not debounced; answer, mute and hang-up are.
   */
  sendDtmf(callId: string, sequence: string): ActionResult {
    const tone = dtmfSequence(sequence);
    if (!tone) return fail("Enter a keypad tone.");
    const call = this.calls.get(callId);
    if (!call) return fail("That call is no longer tracked.");
    if (call.status !== "active")
      return fail("The keypad is available on an active call.");
    const fn = this.sdk()?.calls?.sendDtmfCall;
    if (typeof fn !== "function")
      return fail("The ZIWO softphone cannot send keypad tones.");
    try {
      fn.call(this.sdk()!.calls, call.callId, tone);
      return { ok: true };
    } catch (error) {
      return fail(errorMessage(error, "ZIWO could not send the tone."));
    }
  }

  answer(callId: string): ActionResult {
    return this.control(callId, "answerCall", (call) =>
      call.direction === "Outbound" || call.status !== "ringing"
        ? "Only a ringing incoming call can be answered."
        : ""
    );
  }

  reject(callId: string): ActionResult {
    return this.control(callId, "rejectCall", (call) =>
      call.direction === "Outbound" || call.status !== "ringing"
        ? "Only a ringing incoming call can be rejected."
        : ""
    );
  }

  hangup(callId: string): ActionResult {
    const call = this.calls.get(callId);
    if (!call) return fail("That call is no longer tracked.");
    if (call.status === "ended") return fail("That call has already ended.");
    if (call.ending) return fail("Ending is already requested.");
    const fn: any = this.sdk()?.calls?.hangUpCall;
    if (typeof fn !== "function")
      return fail("The ZIWO softphone cannot do that.");
    try {
      fn.call(this.sdk()!.calls, call.callId);
    } catch (error) {
      return fail(errorMessage(error, "ZIWO could not do that."));
    }
    call.ending = true;
    call.endError = "";
    this.clearHangupTimer(callId);
    const timer = this.later(() => {
      this.hangupTimers.delete(callId);
      const current = this.calls.get(callId);
      if (!current || current.status === "ended" || !current.ending) return;
      current.ending = false;
      current.endError =
        "ZIWO has not confirmed the call ended. Check the ZIWO panel.";
      this.notify();
    }, HANGUP_CONFIRM_MS);
    this.hangupTimers.set(callId, timer);
    this.notify();
    return { ok: true };
  }

  private clearHangupTimer(callId: string): void {
    this.cancel(this.hangupTimers.get(callId));
    this.hangupTimers.delete(callId);
  }

  toggleMute(callId: string): ActionResult {
    const muted = this.calls.get(callId)?.muted;
    return this.control(callId, muted ? "unMuteCall" : "muteCall", (call) =>
      call.status !== "active" ? "Mute is available on an active call." : ""
    );
  }

  toggleHold(callId: string): ActionResult {
    const held = this.calls.get(callId)?.held;
    return this.control(callId, held ? "unHoldCall" : "holdCall", (call) =>
      call.status !== "active" ? "Hold is available on an active call." : ""
    );
  }

  // --- customer lookup and explicit links -----------------------------------------

  private async runLookup(call: CallView): Promise<void> {
    // One lookup per call: not again while one is running, and not after it has answered.
    if (!call.number || call.lookup || this.lookingUp.has(call.callId)) return;
    this.lookingUp.add(call.callId);
    try {
      call.lookup = (await this.deps.post("lookup_customer", {
        phone_number: call.number,
      })) as Lookup;
      call.lookupError = "";
    } catch (error) {
      call.lookupError = errorMessage(error, "Customer lookup failed.");
    } finally {
      this.lookingUp.delete(call.callId);
    }
    this.notify();
  }

  private async whenSaved(call: CallView): Promise<string> {
    if (!call.saved) await this.flush();
    return call.saved
      ? ""
      : "This call is not saved in Helpdesk yet. Retry once the unsaved events are saved.";
  }

  /** The call log named by the click must be the one this tracked call was saved as. */
  private ownedCallLog(call: CallView, callLog: string | undefined): string {
    const given = String(callLog ?? "").trim();
    if (!given || given !== call.logName)
      return "This action belongs to a different saved call.";
    return "";
  }

  private async savedCall(callId: string): Promise<
    { call: CallView } | { error: string }
  > {
    const call = this.calls.get(callId);
    if (!call) return { error: "That call is no longer tracked." };
    const unsaved = await this.whenSaved(call);
    if (unsaved) return { error: unsaved };
    if (!call.logName)
      return {
        error:
          "This call is not saved in Helpdesk yet. Retry once the unsaved events are saved.",
      };
    return { call };
  }

  async linkTicket(
    callId: string,
    ticket: string,
    options: { callLog?: string } = {}
  ): Promise<ActionResult> {
    const ready = await this.savedCall(callId);
    if ("error" in ready) return fail(ready.error);
    const call = ready.call;
    const owned = this.ownedCallLog(call, options.callLog);
    if (owned) return fail(owned);
    try {
      const result = await this.deps.post("link_saved_call", {
        call_log: String(options.callLog).trim(),
        ticket,
      });
      const server = result?.call ?? {};
      call.ticket = String(server.ticket ?? ticket);
      call.contact = String(server.contact ?? call.contact);
      this.notify();
      this.deps.onPersisted?.();
      await this.refreshPanel(call);
      return { ok: true };
    } catch (error) {
      return fail(
        errorMessage(error, "The call could not be linked to that ticket.")
      );
    }
  }

  async chooseContact(
    callId: string,
    contact: string,
    options: { callLog?: string } = {}
  ): Promise<ActionResult> {
    const ready = await this.savedCall(callId);
    if ("error" in ready) return fail(ready.error);
    const call = ready.call;
    const owned = this.ownedCallLog(call, options.callLog);
    if (owned) return fail(owned);
    try {
      const snapshot = await this.deps.post("set_saved_contact", {
        call_log: String(options.callLog).trim(),
        contact,
      });
      call.contact = String(snapshot?.contact ?? contact);
      this.notify();
      this.deps.onPersisted?.();
      await this.refreshPanel(call);
      return { ok: true };
    } catch (error) {
      return fail(
        errorMessage(error, "The contact could not be saved on the call.")
      );
    }
  }

  async searchTickets(
    callId: string,
    query: string,
    options: { callLog?: string } = {}
  ): Promise<ActionResult> {
    const ready = await this.savedCall(callId);
    if ("error" in ready) return fail(ready.error);
    const owned = this.ownedCallLog(ready.call, options.callLog);
    if (owned) return fail(owned);
    try {
      const result = await this.deps.post("search_call_tickets", {
        call_log: String(options.callLog).trim(),
        query,
      });
      return { ok: true, tickets: result?.tickets ?? [] };
    } catch (error) {
      return fail(errorMessage(error, "Tickets could not be searched."));
    }
  }

  async createTicket(
    callId: string,
    fields: { subject: string; description: string; values?: Record<string, string> },
    options: { callLog?: string } = {}
  ): Promise<ActionResult> {
    const ready = await this.savedCall(callId);
    if ("error" in ready) return fail(ready.error);
    const call = ready.call;
    const owned = this.ownedCallLog(call, options.callLog);
    if (owned) return fail(owned);
    try {
      const result = await this.deps.post("create_call_ticket", {
        call_log: String(options.callLog).trim(),
        subject: fields.subject,
        description: fields.description,
        values: fields.values ?? {},
      });
      const server = result?.call ?? {};
      call.ticket = String(server.ticket ?? result?.ticket?.name ?? "");
      call.contact = String(server.contact ?? call.contact);
      this.notify();
      this.deps.onPersisted?.();
      await this.refreshPanel(call);
      return { ok: true };
    } catch (error) {
      return fail(
        errorMessage(error, "The ticket could not be created from this call.")
      );
    }
  }

  // --- view -----------------------------------------------------------------------

  snapshot(): ControllerSnapshot {
    const calls = [...this.calls.values()]
      .sort((a, b) => b.startedAt - a.startedAt)
      .map((call) => ({
        ...call,
        lookup: call.lookup ? { ...call.lookup } : null,
        panel: call.panel ? { ...call.panel } : null,
      }));
    const live = calls.filter((call) => call.status !== "ended");
    const ringing = live.find(
      (call) => call.status === "ringing" && call.direction !== "Outbound"
    );
    return {
      sdk: this.sdkState,
      sdkError: this.sdkError,
      session: this.session,
      authError: this.authError,
      expired: this.expired,
      agentName: this.agentName,
      connection: this.connection,
      ziwoStatus: this.ziwoStatus,
      canReject: exposesReject(this.sdk()?.calls),
      calls,
      liveCall: live[0] ?? null,
      ringingCall: ringing ?? null,
      intent: this.intent
        ? {
            state: this.intent.state,
            number: this.intent.number,
            ticket: this.intent.ticket,
            contact: this.intent.contact,
            error: this.intent.error,
          }
        : null,
      dialError: this.dialError,
      unsaved: {
        count: this.outbox.length,
        permanent: this.outbox.filter((item) => item.dead).length,
        error: this.outbox.find((item) => item.error)?.error ?? "",
      },
      unparsedEvents: this.unparsedEvents,
      lastEventShape: this.lastEventShape,
      sdkMessages: [...this.sdkMessages],
    };
  }
}
