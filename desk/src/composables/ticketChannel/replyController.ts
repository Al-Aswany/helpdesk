/**
 * Draft and idempotency state for one agent replying on one ticket channel.
 *
 * Rules this class enforces (they are what the backend's request key relies on):
 *
 * - One logical submission has one request id. A double click joins the request
 *   already in flight, and a retry of a request that was never answered reuses
 *   its id, so the backend returns the original result instead of sending twice.
 * - Only an answer from the backend ends a request: a stored row (any state), a
 *   conflict, or a definite rejection. A timeout, a lost response or a server
 *   error leaves the id and the text in place and is reported as unconfirmed.
 * - The draft is cleared only after the backend's own row for that request is
 *   visible, because the row is what keeps the text. A blocked reply keeps the
 *   draft, and its next attempt is a new submission with a new id.
 * - Reading never sends. `observe` and `discardPending` only compare rows.
 *
 * No Vue, no frappe-ui and no alias imports: it runs under `node --test`.
 */
import type { OutboundRow, SendResult } from "./logic";

export const DRAFT_MAX_AGE_MS = 7 * 24 * 60 * 60 * 1000;
export const SEND_TIMEOUT_MS = 30_000;

export interface PendingRequest {
  requestId: string;
  message: string;
  /** The backend answered with a stored row; only its visibility is awaited. */
  acknowledged: boolean;
  file?: string | null;
  template?: string | null;
  language?: string | null;
  parameters?: string[] | null;
}

export interface StoredReply {
  draft: string;
  pending: PendingRequest | null;
  savedAt: number;
}

export type Phase = "idle" | "sending" | "unconfirmed" | "confirming";

export type Notice =
  | { kind: "blocked"; reason: string | null; message: string | null }
  | { kind: "conflict" }
  | { kind: "rejected"; messages: string[] }
  | { kind: "unconfirmed" }
  | { kind: "saved_unconfirmed" }
  | null;

export interface ReplySnapshot {
  draft: string;
  pending: PendingRequest | null;
  phase: Phase;
  notice: Notice;
}

export type SubmitOutcome =
  | { kind: "empty" }
  | { kind: "needs_resolution" }
  | { kind: "stale" }
  | { kind: "conflict" }
  | { kind: "blocked"; reason: string | null }
  | { kind: "rejected" }
  | { kind: "unconfirmed" }
  | { kind: "saved" }
  | { kind: "confirmed" };

export interface ReplyDeps {
  load(): StoredReply | null;
  save(value: StoredReply | null): void;
  send(args: {
    message: string;
    requestId: string;
    file?: string | null;
    template?: string | null;
    language?: string | null;
    parameters?: string[] | null;
  }): Promise<SendResult>;
  /** Read-only: the current outbound rows, or null when they could not be read. */
  refresh(): Promise<OutboundRow[] | null>;
  newId(): string;
  now(): number;
  onChange(): void;
  timeoutMs?: number;
  setTimer?: (fn: () => void, ms: number) => unknown;
  clearTimer?: (handle: unknown) => void;
}

class SendTimeout extends Error {
  constructor() {
    super("The reply request timed out");
  }
}

/**
 * True when the server answered that it did not take the request: HTTP 4xx
 * (Frappe uses 417 for validation, 403 for permission). A missing status means
 * the network failed and a 5xx or 408 means the outcome is unknown.
 */
export function isDefinitiveRejection(error: unknown) {
  const status = (error as { status?: unknown } | null | undefined)?.status;
  return (
    typeof status === "number" &&
    status >= 400 &&
    status < 500 &&
    status !== 408
  );
}

export function errorMessages(error: unknown): string[] {
  const source = error as { messages?: unknown; message?: unknown } | null;
  const raw = Array.isArray(source?.messages)
    ? (source?.messages as unknown[])
    : source?.message
    ? [source.message]
    : [];
  // Server messages may carry markup. They are shown as text, so drop the tags.
  return raw
    .filter((item): item is string => typeof item === "string")
    .map((item) => item.replace(/<[^>]*>/g, "").trim())
    .filter(Boolean)
    .slice(0, 3)
    .map((item) => item.slice(0, 300));
}

export class ReplyController {
  private deps: ReplyDeps;
  private draft = "";
  private pending: PendingRequest | null = null;
  private phase: Phase = "idle";
  private notice: Notice = null;
  private inFlight: Promise<SubmitOutcome> | null = null;

  constructor(deps: ReplyDeps) {
    this.deps = deps;
    const stored = deps.load();
    if (!stored) return;
    if (deps.now() - (stored.savedAt || 0) > DRAFT_MAX_AGE_MS) {
      deps.save(null);
      return;
    }
    this.draft = typeof stored.draft === "string" ? stored.draft : "";
    const pending = stored.pending;
    if (
      pending &&
      typeof pending.requestId === "string" &&
      typeof pending.message === "string"
    ) {
      this.pending = {
        requestId: pending.requestId,
        message: pending.message,
        acknowledged: Boolean(pending.acknowledged),
        file: pending.file ?? null,
        template: pending.template ?? null,
        language: pending.language ?? null,
        parameters: Array.isArray(pending.parameters)
          ? pending.parameters
          : null,
      };
      // A request that was in flight when the page went away is unanswered.
      // Nothing is sent here: observe() or the agent's retry settles it.
      this.phase = this.pending.acknowledged ? "confirming" : "unconfirmed";
      this.notice = this.pending.acknowledged
        ? { kind: "saved_unconfirmed" }
        : { kind: "unconfirmed" };
    }
  }

  snapshot(): ReplySnapshot {
    return {
      draft: this.draft,
      pending: this.pending ? { ...this.pending } : null,
      phase: this.phase,
      notice: this.notice,
    };
  }

  setDraft(text: string) {
    this.draft = text;
    if (this.notice?.kind === "rejected" || this.notice?.kind === "conflict") {
      this.notice = null;
    }
    this.persist();
    this.changed();
  }

  /** Put the text of the unanswered request back in the composer. */
  restorePendingText() {
    if (!this.pending) return;
    this.draft = this.pending.message;
    this.persist();
    this.changed();
  }

  submit(): Promise<SubmitOutcome> {
    if (this.pending?.file) {
      return this.submitPrepared(this.draft, { file: this.pending.file }, true);
    }
    return this.submitPrepared(this.draft, {});
  }

  /** Explicit template send. Does not invent a template when the list is empty. */
  submitTemplate(
    template: string,
    language: string,
    parameters: string[]
  ): Promise<SubmitOutcome> {
    const label = template;
    return this.submitPrepared(label, { template, language, parameters });
  }

  /**
   * Queue one media reply. `caption` is the agent's text and may be empty.
   * `file` is the uploaded File name; it is never copied into the caption.
   */
  submitFile(file: string, caption: string): Promise<SubmitOutcome> {
    return this.submitPrepared(caption, { file }, true);
  }

  private submitPrepared(
    text: string,
    extra: {
      file?: string;
      template?: string;
      language?: string;
      parameters?: string[];
    },
    allowEmpty = false
  ): Promise<SubmitOutcome> {
    if (this.inFlight) return this.inFlight;
    if (this.pending && this.pending.message !== text) {
      // Editing while a request is unanswered would start a second logical
      // message next to one that may already be queued.
      return Promise.resolve({ kind: "needs_resolution" });
    }
    if (!this.pending && !text.trim() && !(allowEmpty && extra.file)) {
      return Promise.resolve({ kind: "empty" });
    }
    if (this.pending?.acknowledged) {
      // The backend already stored this request. Only its row is awaited.
      return this.refreshQuietly().then(
        () => ({ kind: this.pending ? "saved" : "confirmed" } as const)
      );
    }
    if (!this.pending) {
      this.pending = {
        requestId: this.deps.newId(),
        message: text,
        acknowledged: false,
        file: extra.file ?? null,
        template: extra.template ?? null,
        language: extra.language ?? null,
        parameters: extra.parameters ?? null,
      };
    }
    this.phase = "sending";
    this.notice = null;
    this.persist();
    this.changed();
    const attempt = this.run(this.pending).finally(() => {
      this.inFlight = null;
    });
    this.inFlight = attempt;
    return attempt;
  }

  /**
   * Compare the backend's rows with the unanswered request. Call it with every
   * fresh descriptor. Returns true when the request was found and settled.
   */
  observe(rows: OutboundRow[] | null | undefined) {
    const pending = this.pending;
    if (!pending || !rows) return false;
    const row = rows.find((item) => item.request_key === pending.requestId);
    if (!row) return false;
    this.pending = null;
    this.phase = "idle";
    if (row.state === "Blocked") {
      this.notice = {
        kind: "blocked",
        reason: row.reason ?? null,
        message: row.body ?? null,
      };
    } else {
      if (this.draft === pending.message) this.draft = "";
      this.notice = null;
    }
    this.persist();
    this.changed();
    return true;
  }

  /** Give up an unanswered request after checking the backend did not store it. */
  async discardPending() {
    if (!this.pending || this.inFlight) return;
    const rows = await this.deps.refresh().catch(() => null);
    if (rows && this.observe(rows)) return;
    if (!this.pending || this.inFlight) return;
    this.pending = null;
    this.phase = "idle";
    this.notice = null;
    this.persist();
    this.changed();
  }

  async discardDraft() {
    this.draft = "";
    if (this.pending && !this.inFlight) {
      await this.discardPending();
    } else if (!this.pending) {
      this.notice = null;
    }
    this.persist();
    this.changed();
  }

  private async run(request: PendingRequest): Promise<SubmitOutcome> {
    const requestId = request.requestId;
    const sent = this.deps.send({
      message: request.message,
      requestId,
      file: request.file,
      template: request.template,
      language: request.language,
      parameters: request.parameters,
    });
    let result: SendResult;
    try {
      result = await this.withTimeout(sent);
    } catch (error) {
      if (error instanceof SendTimeout) {
        // The call may still finish. Take its answer if it arrives late.
        sent.then(
          (late) => {
            if (this.pending?.requestId === requestId && !this.inFlight) {
              void this.answered(requestId, late);
            }
          },
          () => undefined
        );
      }
      return this.failed(requestId, error);
    }
    return this.answered(requestId, result);
  }

  private withTimeout(promise: Promise<SendResult>): Promise<SendResult> {
    const ms = this.deps.timeoutMs ?? SEND_TIMEOUT_MS;
    const setTimer =
      this.deps.setTimer ??
      ((fn: () => void, delay: number) => setTimeout(fn, delay));
    const clearTimer =
      this.deps.clearTimer ??
      ((handle: unknown) =>
        clearTimeout(handle as ReturnType<typeof setTimeout>));
    return new Promise<SendResult>((resolve, reject) => {
      const handle = setTimer(() => reject(new SendTimeout()), ms);
      promise.then(
        (value) => {
          clearTimer(handle);
          resolve(value);
        },
        (error) => {
          clearTimer(handle);
          reject(error);
        }
      );
    });
  }

  private async answered(
    requestId: string,
    result: SendResult | null | undefined
  ): Promise<SubmitOutcome> {
    if (!this.pending || this.pending.requestId !== requestId) {
      return { kind: "stale" };
    }
    if (!result || result.request_id !== requestId) {
      return this.unconfirmed(requestId);
    }
    if (result.state === "Conflict") {
      // The server already owns this key for a different immutable intent.
      // Keep the unresolved request and UUID until the agent checks status and
      // explicitly discards it; silently creating a new UUID could duplicate a
      // send whose response was lost.
      this.phase = "unconfirmed";
      this.notice = { kind: "conflict" };
      this.persist();
      this.changed();
      return { kind: "conflict" };
    }
    if (result.state === "Blocked") {
      this.pending = null;
      this.phase = "idle";
      this.notice = {
        kind: "blocked",
        reason: result.reason ?? null,
        message: result.message ?? null,
      };
      this.persist();
      this.changed();
      await this.refreshQuietly();
      return { kind: "blocked", reason: result.reason ?? null };
    }
    // The backend stored a row for this request. Keep the text until that row
    // is visible, but remember that the request itself is settled.
    this.pending = { ...this.pending, acknowledged: true };
    this.phase = "confirming";
    this.notice = { kind: "saved_unconfirmed" };
    this.persist();
    this.changed();
    await this.refreshQuietly();
    return { kind: this.pending ? "saved" : "confirmed" };
  }

  private failed(requestId: string, error: unknown): Promise<SubmitOutcome> {
    if (!this.pending || this.pending.requestId !== requestId) {
      return Promise.resolve({ kind: "stale" });
    }
    if (isDefinitiveRejection(error)) {
      this.pending = null;
      this.phase = "idle";
      this.notice = { kind: "rejected", messages: errorMessages(error) };
      this.persist();
      this.changed();
      return this.refreshQuietly().then(() => ({ kind: "rejected" } as const));
    }
    return this.unconfirmed(requestId);
  }

  private async unconfirmed(requestId: string): Promise<SubmitOutcome> {
    if (!this.pending || this.pending.requestId !== requestId) {
      return { kind: "stale" };
    }
    this.phase = "unconfirmed";
    this.notice = { kind: "unconfirmed" };
    this.persist();
    this.changed();
    await this.refreshQuietly();
    return { kind: "unconfirmed" };
  }

  private async refreshQuietly() {
    const rows = await this.deps.refresh().catch(() => null);
    if (rows) this.observe(rows);
  }

  private persist() {
    if (this.draft === "" && !this.pending) {
      this.deps.save(null);
      return;
    }
    this.deps.save({
      draft: this.draft,
      pending: this.pending ? { ...this.pending } : null,
      savedAt: this.deps.now(),
    });
  }

  private changed() {
    this.deps.onChange();
  }
}
