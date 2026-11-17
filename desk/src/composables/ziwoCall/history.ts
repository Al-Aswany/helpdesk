/**
 * What a ZIWO call-history row says, and how sure it is. Like `logic.ts` and `recording.ts`,
 * nothing here imports Vue, frappe-ui or an alias, so every rule can be tested with
 * `node --test` against plain objects.
 *
 * Two kinds of information sit side by side on a row and are never blended:
 *
 * - **Observed**: what the agent's own browser reported (`status`, `answered`,
 *   `observed_duration_seconds`). It can be wrong or late, and it is all there is until ZIWO's own
 *   call history has been asked.
 * - **Provider-confirmed**: ZIWO's record of the call, attributed to this agent by the server
 *   (`provider_*`, `provider_confirmed`). Only then is an outcome or a duration called confirmed.
 *
 * The server blanks every provider value for a row that is not confirmed, and a provider
 * recording flag or filename is never read at all, so nothing here can mark audio as available:
 * playback stays decided by actually retrieving the recording.
 */

export type ReconciliationStatus =
  | "Not Checked"
  | "Pending"
  | "Verified"
  | "Conflict"
  | "Unattributed"
  | "Failed";

export interface HistoryRow {
  name: string;
  provider_call_id: string;
  direction: string;
  status: string;
  agent?: string;
  /** The agent's full name. Sent only when a manager lists every agent's calls. */
  agent_name?: string | null;
  customer_number_raw?: string;
  /** The linked Contact and its name, which the server sends only if this user may read it. */
  contact?: string | null;
  contact_label?: string | null;
  ticket?: string;
  started_at?: string;
  creation?: string;
  last_event_at?: string;
  observed_duration_seconds?: number | null;
  end_cause?: string;
  answered?: boolean;
  recovered?: boolean;
  not_confirmed_ended?: boolean;
  recording_status?: string;
  // Provider reconciliation (ZIWO call history). All optional: an older server sends none.
  reconciliation_status?: ReconciliationStatus | string | null;
  reconciliation_note?: string | null;
  reconciliation_checked_at?: string | null;
  reconciliation_verified_at?: string | null;
  provider_confirmed?: boolean;
  provider_outcome?: string | null;
  provider_result?: string | null;
  provider_direction?: string | null;
  provider_started_at?: string | null;
  provider_answered_at?: string | null;
  provider_ended_at?: string | null;
  provider_duration_seconds?: number | null;
  provider_talk_seconds?: number | null;
  provider_ring_seconds?: number | null;
  provider_hold_seconds?: number | null;
  can_reconcile?: boolean;
}

/** `m:ss`, or `h:mm:ss` from an hour up. Zero is `0:00`; only a missing value has no text. */
export function formatDuration(seconds: number | null | undefined): string {
  if (seconds === null || seconds === undefined || !Number.isFinite(seconds))
    return "";
  const whole = Math.max(0, Math.floor(seconds));
  const h = Math.floor(whole / 3600);
  const m = Math.floor((whole % 3600) / 60);
  const s = whole % 60;
  const ss = String(s).padStart(2, "0");
  return h > 0 ? `${h}:${String(m).padStart(2, "0")}:${ss}` : `${m}:${ss}`;
}

/** Only a record the server attributed to this agent counts as provider-confirmed. */
export function isProviderConfirmed(row: HistoryRow): boolean {
  return row.provider_confirmed === true;
}

/**
 * Whether a recording may be offered. A call that ZIWO's own record says has ended is finished
 * even if the browser never reported the hangup. This only decides whether the Play control is
 * shown; whether audio exists is learned by retrieving it, never from a provider field.
 */
export function offerRecording(row: HistoryRow): boolean {
  return (
    (row.status === "Ended" && !row.not_confirmed_ended) ||
    isProviderConfirmed(row)
  );
}

const KNOWN_OUTCOMES = new Set(["Answered", "No answer", "Cancelled", "Busy"]);

/**
 * ZIWO's outcome in words, or `null` when the row has none. A value ZIWO sent that is not one of
 * the documented outcomes is shown as received, never guessed into one.
 */
export function providerOutcomeLabel(row: HistoryRow): string | null {
  if (!isProviderConfirmed(row)) return null;
  const outcome = row.provider_outcome || "";
  if (KNOWN_OUTCOMES.has(outcome)) return outcome;
  const raw = (row.provider_result || "").trim();
  return raw ? `ZIWO result: ${raw}` : "Ended";
}

export interface DurationLine {
  key: "total" | "talk" | "ring" | "hold";
  label: string;
  value: string;
}

/**
 * ZIWO's four durations, each under its own name. They are different measurements and are never
 * added, subtracted or relabelled: total is start to end, talk is answered to end, ring is the
 * ringing time, hold is time on hold. A zero is shown as `0:00`; a number ZIWO did not send is
 * left out. Nothing is called billable. The recording's length is never used.
 */
export function providerDurations(row: HistoryRow): DurationLine[] {
  if (!isProviderConfirmed(row)) return [];
  const lines: DurationLine[] = [];
  const add = (
    key: DurationLine["key"],
    label: string,
    value: number | null | undefined
  ) => {
    const text = formatDuration(value);
    if (text) lines.push({ key, label, value: text });
  };
  add("total", "Total", row.provider_duration_seconds);
  add("talk", "Talk", row.provider_talk_seconds);
  add("ring", "Ring", row.provider_ring_seconds);
  add("hold", "Hold", row.provider_hold_seconds);
  return lines;
}

export type BadgeKind =
  | "observed"
  | "confirmed"
  | "pending"
  | "conflict"
  | "unattributed"
  | "failed";

export interface Badge {
  kind: BadgeKind;
  label: string;
  title: string;
}

const PENDING_TITLES: Record<string, string> = {
  cdr_not_found:
    "ZIWO has no record of this call yet. It will be checked again.",
  primary_call_id_missing:
    "This inbound call has no primary call id yet, so ZIWO has not been asked about it.",
  record_incomplete:
    "ZIWO's record of this call is not finished yet. It will be checked again.",
  record_invalid:
    "ZIWO's record had values that could not be used. It will be checked again.",
};

const CONFLICT_TITLES: Record<string, [string, string]> = {
  answer_mismatch: [
    "Differs from browser",
    "ZIWO and the agent's browser disagree about whether the call was answered. ZIWO's values are shown.",
  ],
  direction_mismatch: [
    "Differs from browser",
    "ZIWO and the agent's browser disagree about the call's direction. ZIWO's values are shown.",
  ],
  provider_inconsistent: [
    "ZIWO record unreliable",
    "ZIWO's record contradicts itself, so none of its numbers is shown.",
  ],
  ambiguous_provider_records: [
    "ZIWO record ambiguous",
    "ZIWO has several records that could be this agent's, so none was chosen.",
  ],
  call_id_mismatch: [
    "ZIWO record not applied",
    "ZIWO's answer was for a different call id, so it was not applied.",
  ],
};

const UNATTRIBUTED_TITLES: Record<string, string> = {
  agent_unmapped:
    "ZIWO has a record, but this agent's ZIWO Agent ID is not set on the connector.",
  agent_not_in_record:
    "ZIWO's record is about another agent, for example one who answered a queue call.",
  answerer_unknown:
    "ZIWO has a record, but it does not say which agent answered.",
};

/** The one short statement of how far this row's information can be trusted, with a longer title. */
export function reconciliationBadge(row: HistoryRow): Badge {
  const status = row.reconciliation_status || "Not Checked";
  const note = row.reconciliation_note || "";
  if (status === "Verified") {
    return {
      kind: "confirmed",
      label: "Confirmed by ZIWO",
      title: "ZIWO's call history confirmed this call.",
    };
  }
  if (status === "Conflict") {
    const [label, title] = CONFLICT_TITLES[note] ?? [
      "ZIWO record differs",
      "ZIWO's record differs from what the browser reported.",
    ];
    return { kind: "conflict", label, title };
  }
  if (status === "Pending") {
    return {
      kind: "pending",
      label: "Waiting for ZIWO",
      title:
        PENDING_TITLES[note] ??
        "ZIWO's record of this call is awaited. It will be checked again.",
    };
  }
  if (status === "Unattributed") {
    return {
      kind: "unattributed",
      label: "ZIWO record not tied to this agent",
      title:
        UNATTRIBUTED_TITLES[note] ??
        "ZIWO has a record, but it cannot be tied to this agent.",
    };
  }
  if (status === "Failed") {
    const failedTitles: Record<string, string> = {
      primary_call_id_invalid:
        "This inbound call's primary call id cannot be used, so ZIWO was not asked.",
      primary_call_id_conflict:
        "The browser reported two different primary call ids, so ZIWO's record was not applied.",
      call_id_invalid: "This call's id cannot be used for a ZIWO request.",
    };
    return {
      kind: "failed",
      label: "ZIWO check failed",
      title:
        failedTitles[note] ??
        "ZIWO produced no usable record for this call within the retry window.",
    };
  }
  return {
    kind: "observed",
    label: "Observed",
    title: "Reported by the agent's browser. Not confirmed by ZIWO.",
  };
}

/** Whether the "Check with ZIWO" action is offered. The server decides and enforces it. */
export function canCheck(row: HistoryRow): boolean {
  return row.can_reconcile === true;
}

/** What to show after the manual check: the server's own fixed text, or a plain fallback. */
export function checkResultText(result: any): { ok: boolean; text: string } {
  const text =
    typeof result?.message === "string" && result.message.trim()
      ? result.message
          .replace(/<[^>]*>/g, "")
          .trim()
          .slice(0, 300)
      : "";
  const ok = result?.ok === true;
  return {
    ok,
    text: text || (ok ? "Checked." : "The check could not be done."),
  };
}

/** What the settings say about recordings and call-history checking. */
export interface RestStatus {
  history?: boolean;
  recordings?: boolean;
  configured?: boolean;
  verified?: boolean;
}

export const REST_TEXT = {
  recordingsOn: "Recording playback is on.",
  recordingsUnconfirmed:
    "Recording playback is set up, but ZIWO has not confirmed the connection yet.",
  recordingsOff: "Recording playback is not set up.",
  historyOn:
    "Calls are recorded from the browser and checked against ZIWO's call history when it has a complete record; until then they are labelled Observed.",
  historyOff:
    "Call-history reconciliation is off or has not been verified. Calls are recorded from the browser only and are labelled Observed.",
} as const;

/**
 * The Details lines about recordings and call-history checking, from the server's own flags
 * instead of its sentence. A line that states reconciliation is off can then never appear while
 * the server reports it active, whatever wording the server uses. Nothing is said without a
 * server answer.
 */
export function restStatusLines(rest: RestStatus | null | undefined): string[] {
  if (!rest) return [];
  const recordings = rest.recordings
    ? rest.verified === false
      ? REST_TEXT.recordingsUnconfirmed
      : REST_TEXT.recordingsOn
    : REST_TEXT.recordingsOff;
  return [
    recordings,
    rest.history ? REST_TEXT.historyOn : REST_TEXT.historyOff,
  ];
}

/** One page of the Call Logs list, as the server returns it. */
export interface CallLogPage {
  rows: HistoryRow[];
  total: number;
  page: number;
  page_size: number;
  pages: number;
  scope: "mine" | "all";
}

export const PAGE_SIZES = [20, 50, 100] as const;

/** `1–20 of 134`, `0` for an empty list. */
export function pageSummary(
  total: number,
  page: number,
  pageSize: number,
  shown: number
): { from: number; to: number; total: number } {
  if (!total || !shown)
    return { from: 0, to: 0, total: Math.max(0, total || 0) };
  const from = (page - 1) * pageSize + 1;
  return { from, to: from + shown - 1, total };
}

/** The call's own time for the list: when it started, else when it was first recorded. */
export function callTime(row: HistoryRow): string {
  return row.started_at || row.creation || row.last_event_at || "";
}

/** The agent's browser's account of the call, in words. Never ZIWO's. */
export function observedStatus(row: HistoryRow): {
  key:
    | "not-confirmed-ended"
    | "ringing"
    | "active"
    | "answered"
    | "not-answered"
    | "unknown";
  seconds: number | null;
} {
  if (row.not_confirmed_ended)
    return { key: "not-confirmed-ended", seconds: null };
  if (row.status === "Ringing") return { key: "ringing", seconds: null };
  if (row.status === "Active") return { key: "active", seconds: null };
  if (row.status === "Ended") {
    if (row.answered)
      return {
        key: "answered",
        seconds: row.observed_duration_seconds ?? null,
      };
    return { key: "not-answered", seconds: null };
  }
  return { key: "unknown", seconds: null };
}

/** Whether a call has finished, so a recording could exist. Learned by playing, never assumed. */
export function hasEnded(row: HistoryRow): boolean {
  return offerRecording(row);
}

export type RecentFilter = "all" | "incoming" | "outgoing" | "missed";

/**
 * A missed call is an inbound call this agent did not answer, and that has finished.
 * An outbound call that was not answered is not missed. A call that is still ringing
 * is not missed yet.
 */
export function isMissedCall(row: HistoryRow): boolean {
  if (row.direction !== "Inbound") return false;
  if (row.answered) return false;
  if (row.status === "Ringing" || row.status === "Active") return false;
  return row.status === "Ended" || Boolean(row.not_confirmed_ended);
}

/** The short outcome for the recent-calls list. Unanswered outbound stays "no-answer". */
export function recentOutcome(
  row: HistoryRow
): "missed" | "no-answer" | "answered" | "live" | "other" {
  if (row.status === "Ringing" || row.status === "Active") return "live";
  if (isMissedCall(row)) return "missed";
  if (row.direction === "Outbound" && !row.answered) return "no-answer";
  if (row.answered) return "answered";
  return "other";
}

/**
 * One row per call identity. Identity is the call-log name (the server's call key).
 * A repeated page row for that same name is dropped. A different name is a different
 * call and stays, even when the number and the displayed minute are the same.
 */
export function distinctCallRows(rows: HistoryRow[]): HistoryRow[] {
  const seen = new Set<string>();
  const kept: HistoryRow[] = [];
  for (const row of rows) {
    const id = (row?.name || "").trim();
    if (id) {
      if (seen.has(id)) continue;
      seen.add(id);
    }
    kept.push(row);
  }
  return kept;
}
