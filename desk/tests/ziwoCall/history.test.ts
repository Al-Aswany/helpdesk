import assert from "node:assert/strict";
import { test } from "node:test";
import {
  PAGE_SIZES,
  REST_TEXT,
  callTime,
  canCheck,
  checkResultText,
  formatDuration,
  hasEnded,
  isMissedCall,
  isProviderConfirmed,
  observedStatus,
  offerRecording,
  distinctCallRows,
  recentOutcome,
  pageSummary,
  providerDurations,
  providerOutcomeLabel,
  reconciliationBadge,
  restStatusLines,
  showsAsMissed,
  type HistoryRow,
} from "../../src/composables/ziwoCall/history.ts";

function row(overrides: Partial<HistoryRow> = {}): HistoryRow {
  return {
    name: "abc",
    provider_call_id: "27da0fb0-5ca4-4f7c-b21b-c0fbc6ab80f0",
    direction: "Outbound",
    status: "Ended",
    answered: true,
    observed_duration_seconds: 10,
    ...overrides,
  };
}

function confirmed(overrides: Partial<HistoryRow> = {}): HistoryRow {
  return row({
    reconciliation_status: "Verified",
    reconciliation_note: "",
    provider_confirmed: true,
    provider_outcome: "Answered",
    provider_result: "answered",
    provider_duration_seconds: 10,
    provider_talk_seconds: 8,
    provider_ring_seconds: 2,
    provider_hold_seconds: 0,
    reconciliation_verified_at: "2026-11-12 14:02:00",
    ...overrides,
  });
}

test("durations read as m:ss and h:mm:ss, and zero is a value", () => {
  assert.equal(formatDuration(0), "0:00");
  assert.equal(formatDuration(5), "0:05");
  assert.equal(formatDuration(65), "1:05");
  assert.equal(formatDuration(3599), "59:59");
  assert.equal(formatDuration(3600), "1:00:00");
  assert.equal(formatDuration(3725), "1:02:05");
  assert.equal(formatDuration(59.9), "0:59");
});

test("a missing duration has no text at all, so it can be told from zero", () => {
  for (const missing of [null, undefined, Number.NaN, Infinity]) {
    assert.equal(formatDuration(missing as any), "");
  }
  assert.equal(formatDuration(0) === "", false);
});

test("only a record the server attributed to this agent is provider-confirmed", () => {
  assert.equal(isProviderConfirmed(confirmed()), true);
  assert.equal(isProviderConfirmed(row()), false);
  // Provider-looking values on a row that is not confirmed prove nothing.
  assert.equal(
    isProviderConfirmed(
      row({ provider_outcome: "Answered", provider_talk_seconds: 8 })
    ),
    false
  );
  assert.equal(
    isProviderConfirmed(row({ provider_confirmed: "true" as any })),
    false
  );
});

test("the four durations stay under their own names and are never combined", () => {
  const lines = providerDurations(confirmed());
  assert.deepEqual(
    lines.map((l) => [l.key, l.label, l.value]),
    [
      ["total", "Total", "0:10"],
      ["talk", "Talk", "0:08"],
      ["ring", "Ring", "0:02"],
      ["hold", "Hold", "0:00"],
    ]
  );
  // 8 + 2 happens to be 10, but nothing derives one number from another.
  const odd = providerDurations(
    confirmed({
      provider_duration_seconds: 100,
      provider_talk_seconds: 30,
      provider_ring_seconds: 6,
      provider_hold_seconds: 4,
    })
  );
  assert.deepEqual(
    odd.map((l) => l.value),
    ["1:40", "0:30", "0:06", "0:04"]
  );
  assert.equal(JSON.stringify(lines).toLowerCase().includes("billable"), false);
});

test("a zero is shown and a number ZIWO did not send is left out", () => {
  const ringOut = providerDurations(
    confirmed({
      provider_outcome: "Cancelled",
      provider_result: "cancel",
      provider_duration_seconds: 0,
      provider_talk_seconds: 0,
      provider_ring_seconds: 0,
      provider_hold_seconds: 0,
    })
  );
  assert.deepEqual(
    ringOut.map((l) => l.value),
    ["0:00", "0:00", "0:00", "0:00"]
  );
  const partial = providerDurations(
    confirmed({ provider_talk_seconds: null, provider_hold_seconds: undefined })
  );
  assert.deepEqual(
    partial.map((l) => l.key),
    ["total", "ring"]
  );
});

test("an unconfirmed row shows no provider durations whatever it carries", () => {
  assert.deepEqual(
    providerDurations(
      row({ provider_duration_seconds: 9, provider_talk_seconds: 4 })
    ),
    []
  );
  assert.deepEqual(
    providerDurations(
      row({ reconciliation_status: "Pending", provider_talk_seconds: 4 })
    ),
    []
  );
});

test("zero talk time alone does not make an answered call look missed", () => {
  const answeredNoTalk = confirmed({
    provider_talk_seconds: 0,
    provider_duration_seconds: 2,
  });
  assert.equal(providerOutcomeLabel(answeredNoTalk), "Answered");
  assert.deepEqual(
    providerDurations(answeredNoTalk).map((l) => l.key),
    ["total", "talk", "ring", "hold"]
  );
});

test("ZIWO's outcome is shown only where its meaning is documented", () => {
  for (const outcome of ["Answered", "No answer", "Cancelled", "Busy"]) {
    assert.equal(
      providerOutcomeLabel(confirmed({ provider_outcome: outcome })),
      outcome
    );
  }
  // An unfamiliar result is kept as received, not guessed into an outcome.
  assert.equal(
    providerOutcomeLabel(
      confirmed({ provider_outcome: "", provider_result: "voicemail" })
    ),
    "ZIWO result: voicemail"
  );
  assert.equal(
    providerOutcomeLabel(
      confirmed({ provider_outcome: "Missed", provider_result: "weird" })
    ),
    "ZIWO result: weird"
  );
  assert.equal(
    providerOutcomeLabel(
      confirmed({ provider_outcome: "", provider_result: "" })
    ),
    "Ended"
  );
  // Not confirmed: no outcome of ZIWO's, even if a stale one is present.
  assert.equal(
    providerOutcomeLabel(row({ provider_outcome: "Answered" })),
    null
  );
});

test("each reconciliation state says what it is and how far to trust it", () => {
  assert.deepEqual(
    [
      row(),
      row({ reconciliation_status: "Not Checked" }),
      row({ reconciliation_status: null }),
    ].map((r) => reconciliationBadge(r).kind),
    ["observed", "observed", "observed"]
  );
  assert.equal(
    reconciliationBadge(row()).title,
    "Reported by the agent's browser. Not confirmed by ZIWO."
  );
  assert.equal(reconciliationBadge(confirmed()).label, "Confirmed by ZIWO");
  assert.equal(reconciliationBadge(confirmed()).kind, "confirmed");
  assert.equal(
    reconciliationBadge(row({ reconciliation_status: "Failed" })).kind,
    "failed"
  );
  assert.equal(
    reconciliationBadge(row({ reconciliation_status: "Nonsense" })).kind,
    "observed"
  );
});

test("pending explains what it is waiting for", () => {
  const titles = [
    "cdr_not_found",
    "record_incomplete",
    "record_invalid",
    "other",
  ].map((note) =>
    reconciliationBadge(
      row({ reconciliation_status: "Pending", reconciliation_note: note })
    )
  );
  for (const badge of titles) {
    assert.equal(badge.kind, "pending");
    assert.equal(badge.label, "Waiting for ZIWO");
    assert.match(badge.title, /checked again/);
  }
  assert.equal(new Set(titles.map((b) => b.title)).size >= 3, true);
});

test("a conflict is named for what differs and ZIWO's values are the ones shown", () => {
  const answer = reconciliationBadge(
    confirmed({
      reconciliation_status: "Conflict",
      reconciliation_note: "answer_mismatch",
    })
  );
  assert.equal(answer.kind, "conflict");
  assert.equal(answer.label, "Differs from browser");
  assert.match(answer.title, /answered/);
  const direction = reconciliationBadge(
    confirmed({
      reconciliation_status: "Conflict",
      reconciliation_note: "direction_mismatch",
    })
  );
  assert.match(direction.title, /direction/);
  const inconsistent = reconciliationBadge(
    row({
      reconciliation_status: "Conflict",
      reconciliation_note: "provider_inconsistent",
    })
  );
  assert.match(inconsistent.title, /no.*numbers|none of its numbers/);
  const ambiguous = reconciliationBadge(
    row({
      reconciliation_status: "Conflict",
      reconciliation_note: "ambiguous_provider_records",
    })
  );
  assert.match(ambiguous.title, /none was chosen/);
  assert.equal(
    reconciliationBadge(
      row({ reconciliation_status: "Conflict", reconciliation_note: "x" })
    ).kind,
    "conflict"
  );
});

test("an unattributed row never claims ZIWO's answer for this agent", () => {
  for (const note of [
    "agent_unmapped",
    "agent_not_in_record",
    "answerer_unknown",
    "other",
  ]) {
    const unattributed = row({
      reconciliation_status: "Unattributed",
      reconciliation_note: note,
    });
    assert.equal(reconciliationBadge(unattributed).kind, "unattributed");
    assert.equal(isProviderConfirmed(unattributed), false);
    assert.equal(providerOutcomeLabel(unattributed), null);
    assert.deepEqual(providerDurations(unattributed), []);
  }
  assert.match(
    reconciliationBadge(
      row({
        reconciliation_status: "Unattributed",
        reconciliation_note: "agent_unmapped",
      })
    ).title,
    /ZIWO Agent ID/
  );
  assert.match(
    reconciliationBadge(
      row({
        reconciliation_status: "Unattributed",
        reconciliation_note: "agent_not_in_record",
      })
    ).title,
    /another agent/
  );
});

test("a recording is offered for a finished call, and a provider flag never decides audio", () => {
  assert.equal(offerRecording(row()), true);
  assert.equal(offerRecording(row({ status: "Active" })), false);
  assert.equal(offerRecording(row({ status: "Ringing" })), false);
  assert.equal(offerRecording(row({ not_confirmed_ended: true })), false);
  // ZIWO's own record says it ended even though the browser never reported the hangup.
  assert.equal(offerRecording(confirmed({ status: "Active" })), true);
  // Nothing about a recording, a filename or availability changes the answer.
  assert.equal(
    offerRecording(
      row({
        status: "Active",
        recording_status: "Available",
        provider_result: "answered",
      })
    ),
    false
  );
  assert.equal(offerRecording(row({ recording_status: "Unavailable" })), true);
});

test("the manual check is offered only when the server says it would accept it", () => {
  assert.equal(canCheck(row({ can_reconcile: true })), true);
  for (const value of [false, undefined, null, "true", 1] as any[]) {
    assert.equal(canCheck(row({ can_reconcile: value })), false);
  }
});

test("the result of a manual check is the server's fixed text, cleaned and short", () => {
  assert.deepEqual(
    checkResultText({ ok: true, message: "ZIWO confirmed this call." }),
    {
      ok: true,
      text: "ZIWO confirmed this call.",
    }
  );
  assert.deepEqual(
    checkResultText({ ok: false, message: "<b>Paused</b> now" }),
    {
      ok: false,
      text: "Paused now",
    }
  );
  assert.equal(
    checkResultText({ ok: true, message: "x".repeat(900) }).text.length,
    300
  );
  assert.deepEqual(checkResultText(null), {
    ok: false,
    text: "The check could not be done.",
  });
  assert.deepEqual(checkResultText({ ok: true }), {
    ok: true,
    text: "Checked.",
  });
});

test("Details never say reconciliation is off while the server reports it active", () => {
  const on = restStatusLines({
    history: true,
    recordings: true,
    verified: true,
  });
  assert.deepEqual(on, [REST_TEXT.recordingsOn, REST_TEXT.historyOn]);
  assert.equal(on.join(" ").includes("off"), false);
  assert.match(on[1], /checked against ZIWO's call history/);
  const off = restStatusLines({
    history: false,
    recordings: true,
    verified: true,
  });
  assert.deepEqual(off, [REST_TEXT.recordingsOn, REST_TEXT.historyOff]);
  assert.match(off[1], /reconciliation is off or has not been verified/);
});

test("the recording line follows the server's flags", () => {
  assert.equal(
    restStatusLines({ recordings: false, history: true })[0],
    REST_TEXT.recordingsOff
  );
  assert.equal(
    restStatusLines({ recordings: true, verified: false, history: false })[0],
    REST_TEXT.recordingsUnconfirmed
  );
  // An older server that sends no `verified` flag is not described as unconfirmed.
  assert.equal(
    restStatusLines({ recordings: true, history: false })[0],
    REST_TEXT.recordingsOn
  );
});

test("nothing is said about reconciliation without a server answer", () => {
  assert.deepEqual(restStatusLines(null), []);
  assert.deepEqual(restStatusLines(undefined), []);
});

test("the page summary counts from the page, and an empty list has no range", () => {
  assert.deepEqual(pageSummary(134, 1, 20, 20), {
    from: 1,
    to: 20,
    total: 134,
  });
  assert.deepEqual(pageSummary(134, 7, 20, 14), {
    from: 121,
    to: 134,
    total: 134,
  });
  assert.deepEqual(pageSummary(134, 2, 50, 50), {
    from: 51,
    to: 100,
    total: 134,
  });
  assert.deepEqual(pageSummary(0, 1, 20, 0), { from: 0, to: 0, total: 0 });
  assert.deepEqual(pageSummary(5, 3, 20, 0), { from: 0, to: 0, total: 5 });
  assert.deepEqual([...PAGE_SIZES], [20, 50, 100]);
});

test("a call's time is when it started, else when it was recorded", () => {
  assert.equal(
    callTime(row({ started_at: "2026-11-16 17:44:26", creation: "x" })),
    "2026-11-16 17:44:26"
  );
  assert.equal(
    callTime(row({ creation: "2026-11-16 17:00:00" })),
    "2026-11-16 17:00:00"
  );
  assert.equal(
    callTime(row({ last_event_at: "2026-11-16 16:00:00" })),
    "2026-11-16 16:00:00"
  );
  assert.equal(callTime(row()), "");
});

test("the browser's account of a call is its own, and a missed call stays unanswered", () => {
  assert.deepEqual(
    observedStatus(row({ answered: true, observed_duration_seconds: 11 })),
    {
      key: "answered",
      seconds: 11,
    }
  );
  assert.deepEqual(
    observedStatus(row({ answered: false, observed_duration_seconds: 0 })),
    {
      key: "not-answered",
      seconds: null,
    }
  );
  assert.equal(
    observedStatus(row({ status: "Ringing", answered: false })).key,
    "ringing"
  );
  assert.equal(observedStatus(row({ status: "Active" })).key, "active");
  assert.equal(
    observedStatus(row({ not_confirmed_ended: true, status: "Active" })).key,
    "not-confirmed-ended"
  );
  assert.equal(observedStatus(row({ status: "Unknown" })).key, "unknown");
});

test("an inbound id problem is stated, and a mismatched answer is not called a disagreement", () => {
  assert.match(
    reconciliationBadge(
      row({
        reconciliation_status: "Pending",
        reconciliation_note: "primary_call_id_missing",
      })
    ).title,
    /no primary call id/
  );
  assert.match(
    reconciliationBadge(
      row({
        reconciliation_status: "Failed",
        reconciliation_note: "primary_call_id_conflict",
      })
    ).title,
    /two different primary call ids/
  );
  const mismatched = reconciliationBadge(
    row({
      reconciliation_status: "Conflict",
      reconciliation_note: "call_id_mismatch",
    })
  );
  assert.equal(mismatched.label, "ZIWO record not applied");
  assert.equal(mismatched.kind, "conflict");
});

test("a recording is offered only for a finished call", () => {
  assert.equal(hasEnded(row()), true);
  assert.equal(hasEnded(row({ status: "Ringing", answered: false })), false);
  assert.equal(
    hasEnded(row({ status: "Active", not_confirmed_ended: true })),
    false
  );
  // ZIWO's own record can end a call the browser never reported ending.
  assert.equal(hasEnded(confirmed({ status: "Active" })), true);
});

test("a missed call is an unanswered inbound call, not an unanswered outbound call", () => {
  const missed = row({
    direction: "Inbound",
    status: "Ended",
    answered: false,
  });
  const stillRinging = row({
    direction: "Inbound",
    status: "Ringing",
    answered: false,
  });
  const answered = row({
    direction: "Inbound",
    status: "Ended",
    answered: true,
  });
  const outbound = row({
    direction: "Outbound",
    status: "Ended",
    answered: false,
  });
  assert.equal(isMissedCall(missed), true);
  assert.equal(recentOutcome(missed), "missed");
  assert.equal(isMissedCall(stillRinging), false);
  assert.equal(isMissedCall(answered), false);
  assert.equal(isMissedCall(outbound), false);
  assert.equal(recentOutcome(outbound), "no-answer");
});

test("a missed incoming call reads Missed even when ZIWO calls it Cancelled", () => {
  const missed = row({
    direction: "Inbound",
    status: "Ended",
    answered: false,
    provider_outcome: "Cancelled",
  });
  assert.equal(showsAsMissed(missed), true);
  // ZIWO saw an answer the browser missed: the call was not missed.
  assert.equal(showsAsMissed({ ...missed, provider_outcome: "Answered" }), false);
  assert.equal(
    showsAsMissed(row({ direction: "Outbound", status: "Ended", answered: false })),
    false
  );
});

test("recents keep distinct calls that share a number and a minute", () => {
  const shared = {
    customer_number_raw: "+971500000123",
    started_at: "2026-11-17 13:02:00",
    direction: "Inbound",
    status: "Ended",
    answered: false,
  };
  const first = row({ ...shared, name: "call-a", provider_call_id: "leg-a" });
  const second = row({
    ...shared,
    name: "call-b",
    provider_call_id: "leg-b",
    started_at: "2026-11-17 13:02:47",
  });
  const repeat = row({ ...shared, name: "call-a", provider_call_id: "leg-a" });
  const kept = distinctCallRows([first, second, repeat]);
  assert.deepEqual(
    kept.map((item) => item.name),
    ["call-a", "call-b"]
  );
});
