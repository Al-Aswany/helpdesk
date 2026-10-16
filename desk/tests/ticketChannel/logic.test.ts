import assert from "node:assert/strict";
import { test } from "node:test";
import {
  buildMessageActivities,
  formatWindowLeft,
  hasPendingRows,
  htmlToPlainText,
  isTechnicalIdentity,
  outboundView,
  reasonCopy,
  replyStorageKey,
  resolveReplyChannel,
  sourceLabel,
  type ChannelDescriptor,
  type OutboundRow,
} from "../../src/composables/ticketChannel/logic.ts";

function descriptor(extra: Partial<ChannelDescriptor> = {}): ChannelDescriptor {
  return {
    key: "whatsapp",
    label: "WhatsApp",
    icon: "whatsapp",
    status: "ready",
    reason: null,
    contact: { name: "Ada", identity: "+15550001" },
    account: { label: "Main" },
    reply: { enabled: true, max_length: 4096 },
    window: { open: true, reason: null, seconds_left: 3600 },
    capabilities: { text: true, media: false, templates: false },
    current_ticket: null,
    outbound: [],
    ...extra,
  };
}

function outbound(extra: Partial<OutboundRow> = {}): OutboundRow {
  return {
    name: "OUT-1",
    request_key: "req-1",
    state: "Queued",
    reason: null,
    error_summary: null,
    communication: null,
    body: "Hello",
    requested_by: "agent@example.com",
    creation: "2026-10-17 10:00:00",
    queued_at: null,
    sending_started_at: null,
    accepted_at: null,
    completed_at: null,
    ...extra,
  };
}

const TECHNICAL = "wa-0123@wa.inchaa.invalid";

test("technical identities are never offered the email composer", () => {
  assert.equal(isTechnicalIdentity(TECHNICAL), true);
  assert.equal(isTechnicalIdentity(" A@B.INVALID "), true);
  assert.equal(isTechnicalIdentity("a@invalid.example.com"), false);
  assert.equal(isTechnicalIdentity(undefined), false);

  const loading = resolveReplyChannel({
    descriptor: null,
    raisedBy: TECHNICAL,
    activities: "loading",
  });
  assert.equal(loading.mode, "checking");
  const failed = resolveReplyChannel({
    descriptor: null,
    raisedBy: TECHNICAL,
    activities: "error",
  });
  assert.deepEqual(failed, {
    mode: "unavailable",
    descriptor: null,
    reason: "lookup_failed",
  });
  const absent = resolveReplyChannel({
    descriptor: null,
    raisedBy: TECHNICAL,
    activities: "loaded",
  });
  assert.deepEqual(absent, {
    mode: "unavailable",
    descriptor: null,
    reason: "no_provider",
  });
  for (const state of ["loading", "loaded", "error"] as const) {
    assert.notEqual(
      resolveReplyChannel({
        descriptor: null,
        raisedBy: TECHNICAL,
        activities: state,
      }).mode,
      "email"
    );
  }
});

test("ordinary tickets keep the email composer", () => {
  for (const state of ["loading", "loaded", "error"] as const) {
    assert.deepEqual(
      resolveReplyChannel({
        descriptor: null,
        raisedBy: "customer@example.com",
        activities: state,
      }),
      { mode: "email" }
    );
  }
  assert.deepEqual(
    resolveReplyChannel({
      descriptor: null,
      raisedBy: undefined,
      activities: "loaded",
    }),
    {
      mode: "email",
    }
  );
});

test("a server descriptor decides the composer", () => {
  const ready = resolveReplyChannel({
    descriptor: descriptor(),
    raisedBy: TECHNICAL,
    activities: "loaded",
  });
  assert.equal(ready.mode, "channel");
  assert.equal(ready.mode === "channel" && ready.canSend, true);

  const closed = resolveReplyChannel({
    descriptor: descriptor({
      window: { open: false, reason: "template_required", seconds_left: 0 },
    }),
    raisedBy: TECHNICAL,
    activities: "loaded",
  });
  assert.equal(closed.mode === "channel" && closed.canSend, false);
  assert.equal(
    closed.mode === "channel" && closed.holdReason,
    "template_required"
  );

  const paused = resolveReplyChannel({
    descriptor: descriptor({
      status: "unavailable",
      reason: "account_paused",
      reply: { enabled: false, max_length: 4096 },
    }),
    raisedBy: TECHNICAL,
    activities: "loaded",
  });
  assert.deepEqual(
    paused.mode === "unavailable" && paused.reason,
    "account_paused"
  );

  // The server wins even for an address that looks like email.
  assert.equal(
    resolveReplyChannel({
      descriptor: descriptor(),
      raisedBy: "x@example.com",
      activities: "loaded",
    }).mode,
    "channel"
  );
});

test("outbound states are shown as the backend reports them, never as delivered or read", () => {
  const states = [
    "Queued",
    "Sending",
    "Accepted",
    "Blocked",
    "Failed",
    "Uncertain",
  ];
  const views = states.map((state) =>
    outboundView(
      outbound({
        state,
        reason: state === "Blocked" ? "template_required" : null,
      })
    )
  );
  assert.deepEqual(
    views.map((v) => v.state),
    states
  );
  assert.deepEqual(
    views.map((v) => v.pending),
    [true, true, false, false, false, false]
  );
  for (const v of views) {
    assert.doesNotMatch(
      `${v.label} ${v.detail}`,
      /deliver(ed)?\b(?!y is not)|\bread\b/i,
      v.state
    );
  }
  const accepted = outboundView(outbound({ state: "Accepted" }));
  assert.match(accepted.detail, /not confirmed/i);
  const uncertain = outboundView(outbound({ state: "Uncertain" }));
  assert.match(uncertain.detail, /before sending it again/i);
  assert.equal(
    outboundView(outbound({ state: "Blocked", reason: "template_required" }))
      .kept,
    true
  );
  assert.equal(
    outboundView(
      outbound({ state: "Failed", error_summary: "WhatsApp rejected it" })
    ).detail,
    "WhatsApp rejected it"
  );
  assert.equal(
    hasPendingRows([
      outbound({ state: "Accepted" }),
      outbound({ state: "Sending" }),
    ]),
    true
  );
  assert.equal(hasPendingRows([outbound({ state: "Failed" })]), false);
  assert.equal(hasPendingRows(null), false);
});

test("reason copy is actionable and has no internal wording", () => {
  const reasons = [
    "template_required",
    "account_paused",
    "account_not_enforced",
    "no_connector",
    "stale_thread_mapping",
    "not_permitted",
    "thread_missing",
    "lookup_failed",
    "no_provider",
    "provider_rejected",
    "weird",
  ];
  for (const reason of reasons) {
    const copy = reasonCopy(reason);
    assert.ok(copy.title.length > 3 && copy.detail.length > 10, reason);
    assert.doesNotMatch(
      `${copy.title} ${copy.detail}`,
      /phase|\bP0?\d\b|debug|traceback|_/i,
      reason
    );
  }
  assert.match(
    reasonCopy("template_required").detail,
    /write to you|write again|reply here again/i
  );
});

test("window time left is readable", () => {
  assert.equal(formatWindowLeft(0), "1m");
  assert.equal(formatWindowLeft(59 * 60), "59m");
  assert.equal(formatWindowLeft(3600), "1h");
  assert.equal(formatWindowLeft(5 * 3600 + 12 * 60), "5h 12m");
  assert.equal(formatWindowLeft(-5), "1m");
});

test("customer text is turned into plain text and never into markup", () => {
  assert.equal(
    htmlToPlainText('<div class="x">Hello<br>World</div>'),
    "Hello\nWorld"
  );
  assert.equal(
    htmlToPlainText("&lt;img src=x onerror=alert(1)&gt;"),
    "<img src=x onerror=alert(1)>"
  );
  assert.equal(htmlToPlainText("<script>alert(1)</script>Hi"), "alert(1)Hi");
  assert.equal(htmlToPlainText("a &amp;lt; b"), "a &lt; b");
  assert.equal(htmlToPlainText("Caf&#233; &#x1F600; &#0; &#xD800;"), "Café 😀");
  assert.equal(htmlToPlainText(null), "");
  assert.equal(
    htmlToPlainText("<p>One</p><p>Two</p><p></p><p></p><p>Three</p>"),
    "One\nTwo\n\nThree"
  );
  // Output is a string for interpolation; decoded markup stays inert text.
  assert.equal(typeof htmlToPlainText("<b onmouseover=1>x</b>"), "string");
});

test("messages become chat cards without the technical address", () => {
  const rows = [
    {
      name: "COM-1",
      subject: "s",
      content: '<div class="inchaa-whatsapp-text">hello &lt;b&gt;</div>',
      creation: "2026-10-17 09:00:00",
      communication_medium: "Chat",
      sent_or_received: "Received",
      user: { email: TECHNICAL, name: TECHNICAL },
    },
    {
      name: "COM-2",
      content: "<div>Replying</div>",
      creation: "2026-10-17 09:05:00",
      communication_medium: "Chat",
      sent_or_received: "Sent",
      user: { email: "agent@example.com", name: "Agent A" },
    },
    {
      name: "COM-3",
      subject: "Re: x",
      content: "<p>mail</p>",
      creation: "2026-10-17 09:10:00",
      communication_medium: "Email",
      sent_or_received: "Sent",
      recipients: "a@b.com",
      user: { email: "agent@example.com", name: "Agent A" },
    },
  ];
  const d = descriptor({
    outbound: [
      outbound({
        name: "OUT-A",
        state: "Accepted",
        communication: "COM-2",
        request_key: "k-a",
      }),
      outbound({
        name: "OUT-B",
        state: "Blocked",
        reason: "template_required",
        body: "Later text",
        creation: "2026-10-17 09:20:00",
        request_key: "k-b",
      }),
      outbound({
        name: "OUT-C",
        state: "Accepted",
        communication: "COM-MISSING",
        body: "Not loaded yet",
        creation: "2026-10-17 09:21:00",
        request_key: "k-c",
      }),
    ],
  });
  const activities = buildMessageActivities(rows as any, d);
  assert.deepEqual(
    activities.map((a) => a.key),
    [
      "chat-COM-1",
      "chat-COM-2",
      "2026-10-17 09:10:00",
      "outbound-OUT-B",
      "outbound-OUT-C",
    ]
  );
  const [incoming, outgoing, email, blocked, unloaded] = activities;
  assert.equal(incoming!.type, "chat");
  assert.equal(incoming!.direction, "incoming");
  assert.equal(incoming!.sender.full_name, "Ada");
  assert.equal(incoming!.sender.name, "");
  assert.equal(incoming!.content, "hello <b>");
  assert.doesNotMatch(JSON.stringify(incoming), /invalid/);
  assert.equal(outgoing!.direction, "outgoing");
  assert.equal(outgoing!.sender.full_name, "Agent A");
  assert.equal(outgoing!.outbound.state, "Accepted");
  assert.equal(email!.type, "email");
  assert.equal(email!.isFirstEmail, false);
  assert.equal(blocked!.direction, "outgoing");
  assert.equal(blocked!.outbound.state, "Blocked");
  assert.equal(blocked!.content, "Later text");
  assert.equal(unloaded!.outbound.communication, "COM-MISSING");
  const keys = activities.map((a) => a.key);
  assert.equal(new Set(keys).size, keys.length);
});

test("without a descriptor email communications are unchanged", () => {
  const rows = [
    {
      name: "COM-1",
      subject: "Hello",
      content: "<p>hi</p>",
      creation: "2026-10-17 09:00:00",
      communication_date: "2026-10-17 09:00:01",
      communication_medium: "Email",
      sent_or_received: "Received",
      recipients: "support@x.com",
      cc: "",
      bcc: "",
      delivery_status: "Sent",
      attachments: [],
      user: { email: "c@x.com", name: "Customer" },
    },
  ];
  const [only] = buildMessageActivities(rows as any, null);
  assert.deepEqual(only, {
    subject: "Hello",
    content: "<p>hi</p>",
    sender: { name: "c@x.com", full_name: "Customer" },
    to: "support@x.com",
    type: "email",
    key: "2026-10-17 09:00:00",
    cc: "",
    bcc: "",
    creation: "2026-10-17 09:00:01",
    attachments: [],
    name: "COM-1",
    deliveryStatus: "Sent",
    isFirstEmail: true,
  });
});

test("source label prefers the channel, then the field, then portal or mail", () => {
  const base = { portalLabel: "Portal", emailLabel: "Mail" };
  assert.equal(sourceLabel({ ...base, descriptor: descriptor() }), "WhatsApp");
  assert.equal(
    sourceLabel({ ...base, descriptor: null, channelValue: "WhatsApp" }),
    "WhatsApp"
  );
  assert.equal(
    sourceLabel({ ...base, descriptor: null, viaPortal: 1 }),
    "Portal"
  );
  assert.equal(
    sourceLabel({ ...base, descriptor: null, viaPortal: 0 }),
    "Mail"
  );
});

test("draft storage keys are separated by user, channel and ticket", () => {
  const a = replyStorageKey("a@x.com", "whatsapp", "12");
  assert.notEqual(a, replyStorageKey("b@x.com", "whatsapp", "12"));
  assert.notEqual(a, replyStorageKey("a@x.com", "whatsapp", "13"));
  assert.notEqual(a, replyStorageKey("a@x.com", "other", "12"));
  assert.notEqual(
    replyStorageKey('a","b', "c", "d"),
    replyStorageKey("a", 'b","c', "d")
  );
});
