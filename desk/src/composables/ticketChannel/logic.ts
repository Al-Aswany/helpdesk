/**
 * Pure helpers for tickets that are answered outside email (see
 * `helpdesk.api.channel`). Nothing in this file imports Vue, frappe-ui or an
 * alias, so it can be exercised with `node --test` on its own.
 *
 * Text that reaches the UI from a customer, a provider error or the backend is
 * always rendered through interpolation. These helpers never produce HTML.
 */

export type OutboundState =
  | "Queued"
  | "Sending"
  | "Accepted"
  | "Sent"
  | "Delivered"
  | "Read"
  | "Blocked"
  | "Failed"
  | "Uncertain";

export interface OutboundRow {
  name: string;
  request_key: string | null;
  state: OutboundState | string;
  reason: string | null;
  error_summary: string | null;
  communication: string | null;
  body: string | null;
  requested_by: string | null;
  creation: string | null;
  queued_at: string | null;
  sending_started_at: string | null;
  accepted_at: string | null;
  completed_at: string | null;
  intent_kind?: string | null;
  attachment_name?: string | null;
  template_name?: string | null;
  template_language?: string | null;
}

export interface ChannelDescriptor {
  key: string;
  label: string;
  icon: string | null;
  status: "ready" | "unavailable";
  reason: string | null;
  contact: { name: string; identity: string };
  account: { label: string };
  reply: { enabled: boolean; max_length: number | null };
  window: { open: boolean; reason: string | null; seconds_left: number };
  capabilities: {
    text: boolean;
    media: boolean;
    templates: boolean;
    media_limits?: Record<"image" | "audio" | "video" | "document", number>;
    accept?: string[];
  };
  templates?: {
    name: string;
    language: string;
    label: string;
    body: string;
    parameter_count: number;
  }[];
  current_ticket: string | null;
  outbound: OutboundRow[];
}

export interface SendResult {
  ok: boolean;
  state: string;
  reason: string | null;
  outbox: string | null;
  error: string | null;
  communication: string | null;
  request_id: string | null;
  message: string | null;
}

export type ActivitiesState = "loading" | "loaded" | "error";

export type ReplyMode =
  | { mode: "email" }
  | { mode: "checking" }
  | {
      mode: "channel";
      descriptor: ChannelDescriptor;
      canSend: boolean;
      /** Why sending is off even though the composer is shown. */
      holdReason: string | null;
    }
  | {
      mode: "unavailable";
      descriptor: ChannelDescriptor | null;
      reason: string;
    };

/** ".invalid" can never receive mail (RFC 2606), so it marks a technical identity. */
export function isTechnicalIdentity(address: string | null | undefined) {
  return (
    typeof address === "string" &&
    address.trim().toLowerCase().endsWith(".invalid")
  );
}

/**
 * Decide how a ticket is answered.
 *
 * Fails closed: a ticket whose address is technical never gets the email
 * composer, whether the channel lookup is still loading, failed or found no
 * provider. A descriptor from the server always wins.
 */
export function resolveReplyChannel(input: {
  descriptor: ChannelDescriptor | null | undefined;
  raisedBy: string | null | undefined;
  activities: ActivitiesState;
}): ReplyMode {
  const { descriptor, raisedBy, activities } = input;
  if (descriptor) {
    if (descriptor.status === "ready") {
      const holdReason =
        descriptor.reply.enabled === false
          ? descriptor.reason || "not_permitted"
          : descriptor.window.open
          ? null
          : descriptor.window.reason || "template_required";
      return {
        mode: "channel",
        descriptor,
        canSend: descriptor.reply.enabled && descriptor.window.open,
        holdReason,
      };
    }
    return {
      mode: "unavailable",
      descriptor,
      reason: descriptor.reason || "lookup_failed",
    };
  }
  if (isTechnicalIdentity(raisedBy)) {
    if (activities === "loading") return { mode: "checking" };
    return {
      mode: "unavailable",
      descriptor: null,
      reason: activities === "error" ? "lookup_failed" : "no_provider",
    };
  }
  return { mode: "email" };
}

export const PENDING_STATES = ["Queued", "Sending"];

export function isPendingState(state: string | null | undefined) {
  return PENDING_STATES.includes(state || "");
}

export function hasPendingRows(rows: OutboundRow[] | null | undefined) {
  return Boolean(rows?.some((row) => isPendingState(row.state)));
}

export function findRowByRequestKey(
  rows: OutboundRow[] | null | undefined,
  requestKey: string | null | undefined
) {
  if (!rows || !requestKey) return undefined;
  return rows.find((row) => row.request_key === requestKey);
}

export type Tone = "gray" | "blue" | "green" | "orange" | "red";

export interface OutboundView {
  state: string;
  label: string;
  tone: Tone;
  detail: string;
  /** Still moving through the queue. */
  pending: boolean;
  /** The text is kept on a row that was not sent. */
  kept: boolean;
}

/**
 * What the agent sees for one outbound row. "Accepted" means the provider took
 * the message. It does not claim delivery or a read receipt, which the backend
 * does not report.
 */
export function outboundView(
  row: OutboundRow,
  providerLabel = "WhatsApp"
): OutboundView {
  switch (row.state) {
    case "Queued":
      return view(row, "Queued", "gray", "Waiting to be sent.", true, false);
    case "Sending":
      return view(
        row,
        "Sending",
        "gray",
        `Being handed to ${providerLabel}.`,
        true,
        false
      );
    case "Accepted":
      return view(
        row,
        "Accepted",
        "blue",
        `${providerLabel} accepted this message. Delivery is not confirmed yet.`,
        false,
        false
      );
    case "Sent":
      return view(
        row,
        "Sent",
        "blue",
        `${providerLabel} has sent this message. It is not confirmed as delivered.`,
        false,
        false
      );
    case "Delivered":
      return view(
        row,
        "Delivered",
        "green",
        "Delivered to the customer's phone.",
        false,
        false
      );
    case "Read":
      return view(
        row,
        "Read",
        "green",
        "The customer has read this message.",
        false,
        false
      );
    case "Blocked":
      return view(
        row,
        "Not sent",
        "orange",
        reasonCopy(row.reason, providerLabel).detail,
        false,
        true
      );
    case "Failed":
      return view(
        row,
        "Failed",
        "red",
        row.error_summary || reasonCopy(row.reason, providerLabel).detail,
        false,
        true
      );
    case "Uncertain":
      return view(
        row,
        "Uncertain",
        "orange",
        `We could not confirm whether ${providerLabel} received this. Check with the customer before sending it again.`,
        false,
        false
      );
    default:
      return view(
        row,
        String(row.state || "Unknown"),
        "gray",
        "",
        false,
        false
      );
  }
}

function view(
  row: OutboundRow,
  label: string,
  tone: Tone,
  detail: string,
  pending: boolean,
  kept: boolean
): OutboundView {
  return { state: String(row.state), label, tone, detail, pending, kept };
}

export interface ReasonCopy {
  title: string;
  detail: string;
}

/** English copy. Callers pass it through `__()`. The default label keeps WhatsApp wording. */
export function reasonCopy(
  reason: string | null | undefined,
  providerLabel = "WhatsApp"
): ReasonCopy {
  switch (reason) {
    case "template_required":
      return {
        title: "The reply window has closed",
        detail:
          "Free-form WhatsApp replies are closed. Send an approved template, or wait until the customer writes again.",
      };
    case "window_closed":
      return {
        title: "The reply window has closed",
        detail: `Free-form ${providerLabel} replies are closed until the customer writes again. This conversation uses the standard 24-hour window.`,
      };
    case "no_approved_template":
      return {
        title: "No approved template is available",
        detail:
          "The reply window has closed and this account has no approved text template to send.",
      };
    case "account_paused":
      return {
        title: `${providerLabel} replies are paused`,
        detail: `This ${providerLabel} account is paused, so nothing can be sent until it is resumed.`,
      };
    case "outbound_disabled":
      return {
        title: `${providerLabel} replies are turned off`,
        detail: `Outbound ${providerLabel} replies are switched off. An administrator can enable them when this Page is ready.`,
      };
    case "account_not_enforced":
    case "no_connector":
    case "connector_missing":
      return {
        title: `${providerLabel} replies are not turned on`,
        detail: `This ${providerLabel} account is not ready to send replies yet. Ask an administrator to finish setting it up.`,
      };
    case "stale_thread_mapping":
      return {
        title: "This conversation continues in a newer ticket",
        detail:
          "The customer's newer messages are in another ticket, so replies from this one are turned off.",
      };
    case "not_permitted":
      return {
        title: `You cannot reply on ${providerLabel}`,
        detail:
          "Only active support agents with access to this ticket can reply. You can still add internal comments.",
      };
    case "provider_rejected":
    case "token_invalid":
      return {
        title: `${providerLabel} rejected the message`,
        detail: `${providerLabel} did not accept this message.`,
      };
    case "unsupported_media":
      return {
        title: "This file cannot be sent",
        detail: `Only a small JPEG or PNG image can be sent on ${providerLabel}.`,
      };
    case "thread_missing":
    case "lookup_failed":
    case "no_provider":
      return {
        title: `${providerLabel} replies are unavailable`,
        detail: `The details of this ${providerLabel} conversation could not be loaded, so replies are turned off instead of emailing a placeholder address. Reload the page to try again.`,
      };
    default:
      return {
        title: "This message was not sent",
        detail: "It was kept so you can try again.",
      };
  }
}

/** "5h 12m" style text for the time left in the reply window. */
export function formatWindowLeft(seconds: number) {
  const total = Math.max(0, Math.floor(seconds));
  const hours = Math.floor(total / 3600);
  const minutes = Math.floor((total % 3600) / 60);
  if (hours > 0) return minutes ? `${hours}h ${minutes}m` : `${hours}h`;
  return `${Math.max(minutes, 1)}m`;
}

const NAMED_ENTITIES: Record<string, string> = {
  amp: "&",
  lt: "<",
  gt: ">",
  quot: '"',
  apos: "'",
  nbsp: " ",
};

function decodeEntities(text: string) {
  return text.replace(
    /&(#x[0-9a-f]+|#\d+|[a-z]+);/gi,
    (match, body: string) => {
      if (body[0] === "#") {
        const hex = body[1] === "x" || body[1] === "X";
        const code = parseInt(body.slice(hex ? 2 : 1), hex ? 16 : 10);
        if (!Number.isFinite(code) || code < 32 || code > 0x10ffff) {
          return code === 10 || code === 9 ? String.fromCodePoint(code) : "";
        }
        if (code >= 0xd800 && code <= 0xdfff) return "";
        return String.fromCodePoint(code);
      }
      return NAMED_ENTITIES[body.toLowerCase()] ?? match;
    }
  );
}

/**
 * Plain text from the escaped HTML the backend stores for a chat message.
 * Tags are removed first and entities decoded afterwards, so text such as
 * `&lt;script&gt;` ends up as visible characters. The result is only ever
 * rendered by interpolation, never as markup.
 */
export function htmlToPlainText(html: string | null | undefined) {
  if (!html) return "";
  const withBreaks = String(html)
    .replace(/<\s*br\s*\/?\s*>/gi, "\n")
    .replace(/<\/\s*(?:p|div|li|tr|h[1-6])\s*>/gi, "\n")
    .replace(/<[^>]*>/g, "");
  return decodeEntities(withBreaks)
    .replace(/\r\n?/g, "\n")
    .replace(/\n{3,}/g, "\n\n")
    .trim();
}

export interface CommunicationRow {
  name: string;
  subject?: string;
  content?: string;
  creation: string;
  communication_date?: string | null;
  communication_medium?: string | null;
  sent_or_received?: string;
  recipients?: string;
  cc?: string;
  bcc?: string;
  delivery_status?: string;
  attachments?: unknown;
  user: { email?: string; name?: string };
}

export const CHAT_MEDIUM = "Chat";

/**
 * Turn communications plus unanswered outbound rows into timeline activities.
 *
 * Email communications keep their existing shape. Chat communications become
 * `chat` activities, carrying the outbound row that created them. Outbound rows
 * without a visible communication (queued, blocked, failed, uncertain, or
 * accepted but not loaded yet) get their own card, so a reply never vanishes
 * between the click and the native Communication.
 */
export function buildMessageActivities(
  communications: CommunicationRow[],
  descriptor: ChannelDescriptor | null | undefined
): Record<string, any>[] {
  const outbound = descriptor?.outbound ?? [];
  const byCommunication = new Map<string, OutboundRow>();
  for (const row of outbound) {
    if (row.communication) byCommunication.set(row.communication, row);
  }
  const channel = {
    key: descriptor?.key ?? "",
    label: descriptor?.label || "Chat",
    icon: descriptor?.icon ?? null,
  };
  const customer = descriptor?.contact?.name || "";
  const shown = new Set<string>();
  const activities: Record<string, any>[] = [];

  communications.forEach((communication, idx) => {
    const creation = communication.communication_date || communication.creation;
    if (communication.communication_medium === CHAT_MEDIUM) {
      shown.add(communication.name);
      const incoming = communication.sent_or_received !== "Sent";
      activities.push({
        type: "chat",
        key: `chat-${communication.name}`,
        name: communication.name,
        direction: incoming ? "incoming" : "outgoing",
        creation,
        content: htmlToPlainText(communication.content),
        channel,
        sender: incoming
          ? { name: "", full_name: customer }
          : {
              name: communication.user?.email ?? "",
              full_name: communication.user?.name ?? "",
            },
        outbound: byCommunication.get(communication.name) ?? null,
        attachments: communication.attachments ?? [],
      });
      return;
    }
    activities.push({
      subject: communication.subject,
      content: communication.content,
      sender: {
        name: communication.user?.email,
        full_name: communication.user?.name,
      },
      to: communication.recipients,
      type: "email",
      key: communication.creation,
      cc: communication.cc,
      bcc: communication.bcc,
      creation,
      attachments: communication.attachments,
      name: communication.name,
      deliveryStatus: communication.delivery_status,
      isFirstEmail: idx === 0,
    });
  });

  for (const row of outbound) {
    if (row.communication && shown.has(row.communication)) continue;
    activities.push({
      type: "chat",
      key: `outbound-${row.name}`,
      name: row.name,
      direction: "outgoing",
      creation: row.creation || row.queued_at || "",
      content: row.body || "",
      channel,
      sender: { name: row.requested_by ?? "", full_name: "" },
      outbound: row,
      attachments: [],
      attachmentName: row.attachment_name || "",
    });
  }
  return activities;
}

/** Label for the ticket's source in details panels and lists. */
export function sourceLabel(input: {
  descriptor: ChannelDescriptor | null | undefined;
  channelValue?: string | null;
  viaPortal?: boolean | number | string | null;
  portalLabel: string;
  emailLabel: string;
}) {
  if (input.descriptor?.label) return input.descriptor.label;
  if (input.channelValue) return input.channelValue;
  return input.viaPortal ? input.portalLabel : input.emailLabel;
}

/**
 * Storage key for one agent's draft on one ticket and channel. Encoded as a JSON
 * array, so no value can run into another and a different user never shares a key.
 */
export function replyStorageKey(user: string, channel: string, ticket: string) {
  return `helpdesk:channel-reply:${JSON.stringify([user, channel, ticket])}`;
}
