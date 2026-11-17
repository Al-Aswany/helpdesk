/**
 * Recording playback for the ZIWO call history. Like `logic.ts`, nothing here imports Vue,
 * frappe-ui or an alias, so every rule can be tested with `node --test` against plain objects.
 *
 * The browser never sees a provider address or credential. It asks Helpdesk for one recording
 * by the local call-log name; Helpdesk checks that this user may open that call, fetches the
 * audio from ZIWO with its own server-side credential, and answers `audio/mpeg` with private,
 * non-cacheable headers. The audio is held in memory as a Blob for as long as the row is
 * on screen and is never written to browser storage.
 */

/** The same-origin Helpdesk endpoint. The `call` argument is a local call-log name. */
export const RECORDING_ENDPOINT =
  "/api/method/inchaa_custmization.integrations.ziwo.api.get_recording_audio";

export type FailureKind =
  | "not-found"
  | "not-configured"
  | "denied"
  | "session"
  | "busy"
  | "error";

export class RecordingFetchError extends Error {
  status: number;
  kind: FailureKind;

  constructor(message: string, status: number, kind: FailureKind) {
    super(message);
    this.name = "RecordingFetchError";
    this.status = status;
    this.kind = kind;
  }
}

export function recordingUrl(call: string): string {
  return `${RECORDING_ENDPOINT}?call=${encodeURIComponent(call)}`;
}

/** Server messages are shown only for the errors this feature raises on purpose. */
const KNOWN_ERRORS = new Set([
  "RecordingNotConfigured",
  "RecordingNotFound",
  "RecordingCredentialRejected",
  "RecordingPermissionDenied",
  "RecordingLoginPaused",
  "RecordingTimeout",
  "RecordingUpstreamError",
  "ZiwoDisabled",
  "PermissionError",
  "DoesNotExistError",
  "RateLimitExceededError",
]);

function stripTags(text: string): string {
  return text
    .replace(/<[^>]*>/g, "")
    .replace(/\s+/g, " ")
    .trim()
    .slice(0, 300);
}

/** The first readable message in a Frappe error body, or "". */
export function serverMessage(body: any): string {
  const raw = body?._server_messages;
  if (typeof raw !== "string") return "";
  try {
    const list = JSON.parse(raw);
    if (!Array.isArray(list)) return "";
    for (const item of list) {
      const entry = typeof item === "string" ? JSON.parse(item) : item;
      if (entry && typeof entry.message === "string") {
        const text = stripTags(entry.message);
        if (text) return text;
      }
    }
  } catch {
    // Not the shape Frappe sends. Fall back to the status.
  }
  return "";
}

/** The plain-language reason for an HTTP status, when the body carries nothing usable. */
export function statusMessage(status: number): string {
  if (status === 401)
    return "Your session has ended. Reload the page and sign in again.";
  if (status === 403) return "You are not permitted to play this recording.";
  if (status === 404) return "No recording is available for this call.";
  if (status === 429)
    return "Too many recording requests. Wait a moment and try again.";
  if (status === 503) return "Recording playback is not set up.";
  if (status === 504) return "The recording took too long to load. Try again.";
  if (status >= 500) return "The recording could not be loaded right now.";
  return "The recording could not be loaded.";
}

function kindFor(status: number, exc: string): FailureKind {
  if (exc === "RecordingNotConfigured" || status === 503)
    return "not-configured";
  if (
    exc === "RecordingNotFound" ||
    exc === "DoesNotExistError" ||
    status === 404
  )
    return "not-found";
  if (status === 401) return "session";
  if (exc === "PermissionError" || exc === "ZiwoDisabled" || status === 403)
    return "denied";
  if (exc === "RateLimitExceededError" || status === 429) return "busy";
  return "error";
}

/** Turns a failed response into the error the agent sees. Never includes raw server text. */
export function failureFrom(status: number, body: any): RecordingFetchError {
  const exc = typeof body?.exc_type === "string" ? body.exc_type : "";
  const fromServer = KNOWN_ERRORS.has(exc) ? serverMessage(body) : "";
  return new RecordingFetchError(
    fromServer || statusMessage(status),
    status,
    kindFor(status, exc)
  );
}

export interface FetchLike {
  (
    url: string,
    init: {
      method: string;
      credentials: "same-origin";
      cache: "no-store";
      headers: Record<string, string>;
      signal?: AbortSignal;
    }
  ): Promise<{
    ok: boolean;
    status: number;
    headers: { get(name: string): string | null };
    blob(): Promise<Blob>;
    text(): Promise<string>;
  }>;
}

/**
 * Downloads one recording as an `audio/mpeg` Blob through the Helpdesk endpoint. Throws a
 * `RecordingFetchError` with a sanitized message for every failure; an aborted request rethrows
 * the abort so the caller can ignore it.
 */
export async function loadRecording(
  call: string,
  deps: { fetch: FetchLike; signal?: AbortSignal }
): Promise<Blob> {
  let response;
  try {
    response = await deps.fetch(recordingUrl(call), {
      method: "GET",
      credentials: "same-origin",
      cache: "no-store",
      headers: { Accept: "audio/mpeg, application/json;q=0.5" },
      signal: deps.signal,
    });
  } catch (error: any) {
    if (error?.name === "AbortError") throw error;
    throw new RecordingFetchError(
      "Helpdesk could not be reached. Check the connection and try again.",
      0,
      "error"
    );
  }

  if (!response.ok) {
    let body: any = null;
    try {
      body = JSON.parse(await response.text());
    } catch {
      body = null;
    }
    throw failureFrom(response.status, body);
  }

  const type = (response.headers.get("content-type") || "")
    .split(";")[0]
    .trim()
    .toLowerCase();
  if (type !== "audio/mpeg") {
    throw new RecordingFetchError(
      "Helpdesk did not return audio for this recording.",
      response.status,
      "error"
    );
  }

  let blob: Blob;
  try {
    blob = await response.blob();
  } catch (error: any) {
    if (error?.name === "AbortError") throw error;
    throw new RecordingFetchError(
      "The recording download was interrupted. Try again.",
      0,
      "error"
    );
  }
  if (!blob.size) {
    throw new RecordingFetchError(
      "The recording was empty.",
      response.status,
      "error"
    );
  }
  // Declare the type ourselves so playback never depends on how the browser labelled the bytes.
  return new Blob([blob], { type: "audio/mpeg" });
}

/** m:ss for the player's own position readout. It is not a call duration. */
export function clock(seconds: number): string {
  const whole =
    Number.isFinite(seconds) && seconds > 0 ? Math.floor(seconds) : 0;
  return `${Math.floor(whole / 60)}:${String(whole % 60).padStart(2, "0")}`;
}

/**
 * At most one recording plays at a time. A player that starts claims playback and the one that
 * had it is paused; releasing never pauses anyone else.
 */
export class PlaybackSlot {
  private holder: { pause: () => void } | null = null;

  claim(player: { pause: () => void }): void {
    if (this.holder && this.holder !== player) this.holder.pause();
    this.holder = player;
  }

  release(player: { pause: () => void }): void {
    if (this.holder === player) this.holder = null;
  }

  get current() {
    return this.holder;
  }
}

export const playbackSlot = new PlaybackSlot();
