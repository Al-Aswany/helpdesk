/**
 * Vue wiring for tickets that are answered outside email.
 *
 * The backend decides everything (`helpdesk.api.channel`): this file only reads
 * the descriptor that arrives with the ticket's activities, posts a reply
 * through `send_channel_reply`, and keeps one draft controller and one bounded
 * poller per ticket. Nothing here talks to a provider or names an installed app.
 */
import { sessionUserId } from "@/composables/userStorage";
import { useTicket } from "@/composables/useTicket";
import { call } from "frappe-ui";
import {
  computed,
  getCurrentScope,
  onScopeDispose,
  shallowRef,
  watch,
  type ComputedRef,
  type ShallowRef,
} from "vue";
import {
  hasPendingRows,
  replyStorageKey,
  resolveReplyChannel,
  type ActivitiesState,
  type ChannelDescriptor,
  type OutboundRow,
  type ReplyMode,
  type SendResult,
} from "./logic";
import { BoundedPoller } from "./poller";
import {
  ReplyController,
  type ReplySnapshot,
  type StoredReply,
  type SubmitOutcome,
} from "./replyController";

export * from "./logic";
export {
  AttachmentComposer,
  type StagedAttachment,
} from "./attachmentComposer";
export type { Notice, ReplySnapshot, SubmitOutcome } from "./replyController";

const EMPTY_SNAPSHOT: ReplySnapshot = {
  draft: "",
  pending: null,
  phase: "idle",
  notice: null,
};

interface Live {
  descriptor: ChannelDescriptor;
  /** The activities payload this was read after; a newer payload replaces it. */
  base: unknown;
}

interface Entry {
  user: string;
  ticketId: string;
  live: ShallowRef<Live | null>;
  snapshot: ShallowRef<ReplySnapshot>;
  controller: ReplyController | null;
  controllerKey: string | null;
  poller: BoundedPoller;
}

const entries = new Map<string, Entry>();

function uuid() {
  if (typeof crypto !== "undefined" && "randomUUID" in crypto) {
    return crypto.randomUUID();
  }
  // Insecure-context fallback (plain http on a LAN host).
  const bytes = new Uint8Array(16);
  crypto.getRandomValues(bytes);
  bytes[6] = (bytes[6]! & 0x0f) | 0x40;
  bytes[8] = (bytes[8]! & 0x3f) | 0x80;
  const hex = [...bytes].map((b) => b.toString(16).padStart(2, "0"));
  return [
    hex.slice(0, 4).join(""),
    hex.slice(4, 6).join(""),
    hex.slice(6, 8).join(""),
    hex.slice(8, 10).join(""),
    hex.slice(10).join(""),
  ].join("-");
}

function readStorage(key: string): StoredReply | null {
  try {
    const raw = window.localStorage.getItem(key);
    return raw ? (JSON.parse(raw) as StoredReply) : null;
  } catch {
    return null;
  }
}

function writeStorage(key: string, value: StoredReply | null) {
  try {
    if (value) window.localStorage.setItem(key, JSON.stringify(value));
    else window.localStorage.removeItem(key);
  } catch {
    // Private mode or a full quota: the draft just stays in memory.
  }
}

function entryFor(rawTicketId: string | number): Entry {
  // Ticket names are numbers in some payloads and strings in others.
  const ticketId = String(rawTicketId);
  const user = sessionUserId();
  const existing = entries.get(ticketId);
  if (existing && existing.user === user) return existing;
  existing?.poller.stop();

  const entry: Entry = {
    user,
    ticketId,
    live: shallowRef(null),
    snapshot: shallowRef(EMPTY_SNAPSHOT),
    controller: null,
    controllerKey: null,
    poller: new BoundedPoller({
      fetch: () => refresh(entry),
      shouldPoll: () => shouldPoll(entry),
      now: () => Date.now(),
      setTimer: (fn, ms) => setTimeout(fn, ms),
      clearTimer: (handle) => clearTimeout(handle as number),
      isVisible: () => document.visibilityState !== "hidden",
    }),
  };
  entries.set(ticketId, entry);
  return entry;
}

function currentDescriptor(entry: Entry): ChannelDescriptor | null {
  const { activities } = useTicket(entry.ticketId);
  const data = activities.data;
  if (entry.live.value && entry.live.value.base === data) {
    return entry.live.value.descriptor;
  }
  return (data?.channel as ChannelDescriptor | undefined) ?? null;
}

function shouldPoll(entry: Entry) {
  const descriptor = currentDescriptor(entry);
  return (
    hasPendingRows(descriptor?.outbound) ||
    Boolean(entry.snapshot.value.pending)
  );
}

/** Read the descriptor again. A read: it can never send. */
async function refresh(entry: Entry): Promise<OutboundRow[] | null> {
  const descriptor = currentDescriptor(entry);
  const key = descriptor?.key ?? entry.controllerKey;
  if (!key) return null;
  const { activities } = useTicket(entry.ticketId);
  const fresh = (await call("helpdesk.api.channel.get_channel", {
    ticket: entry.ticketId,
    channel: key,
  })) as ChannelDescriptor | null;
  if (!fresh) return null;
  entry.live.value = { descriptor: fresh, base: activities.data };
  entry.controller?.observe(fresh.outbound);
  loadMissingCommunications(entry, fresh);
  return fresh.outbound;
}

/** An accepted reply gains a native Communication: fetch it once it exists. */
function loadMissingCommunications(
  entry: Entry,
  descriptor: ChannelDescriptor
) {
  const { activities } = useTicket(entry.ticketId);
  if (activities.loading || !activities.data) return;
  const known = new Set(
    (activities.data.communications ?? []).map(
      (item: { name: string }) => item.name
    )
  );
  if (
    descriptor.outbound.some(
      (row) => row.communication && !known.has(row.communication)
    )
  ) {
    activities.reload();
  }
}

function controllerFor(entry: Entry, key: string): ReplyController {
  if (entry.controller && entry.controllerKey === key) return entry.controller;
  const storageKey = replyStorageKey(entry.user, key, entry.ticketId);
  const controller = new ReplyController({
    load: () => readStorage(storageKey),
    save: (value) => writeStorage(storageKey, value),
    send: (args) =>
      call("helpdesk.api.channel.send_channel_reply", {
        ticket: entry.ticketId,
        channel: key,
        message: args.message,
        request_id: args.requestId,
        file: args.file || undefined,
        template: args.template || undefined,
        language: args.language || undefined,
        parameters: args.parameters || undefined,
      }) as Promise<SendResult>,
    refresh: () => refresh(entry),
    newId: uuid,
    now: () => Date.now(),
    onChange: () => {
      entry.snapshot.value = controller.snapshot();
      if (shouldPoll(entry)) entry.poller.start();
    },
  });
  entry.controller = controller;
  entry.controllerKey = key;
  entry.snapshot.value = controller.snapshot();
  controller.observe(currentDescriptor(entry)?.outbound);
  return controller;
}

export interface TicketChannel {
  descriptor: ComputedRef<ChannelDescriptor | null>;
  mode: ComputedRef<ReplyMode>;
  reply: ComputedRef<ReplySnapshot>;
  shouldPoll: ComputedRef<boolean>;
  setDraft(text: string): void;
  submit(): Promise<SubmitOutcome>;
  submitTemplate(
    template: string,
    language: string,
    parameters: string[]
  ): Promise<SubmitOutcome>;
  submitFile(file: string, caption: string): Promise<SubmitOutcome>;
  discardDraft(): Promise<void>;
  discardPending(): Promise<void>;
  restorePendingText(): void;
  refresh(): Promise<OutboundRow[] | null>;
}

/**
 * Channel state for one ticket. With no ticket, or for a ticket answered by
 * email, `mode` is `email` and nothing else is created.
 */
export function useTicketChannel(
  ticketId: () => string | number | null | undefined
): TicketChannel {
  const ticket = computed(() => {
    const id = ticketId();
    return id ? useTicket(id) : null;
  });
  const entry = computed(() => {
    const id = ticketId();
    return id ? entryFor(id) : null;
  });

  const descriptor = computed(() => {
    const current = entry.value;
    return current ? currentDescriptor(current) : null;
  });

  const activitiesState = computed<ActivitiesState>(() => {
    const activities = ticket.value?.activities;
    if (activities?.data) return "loaded";
    if (activities?.error) return "error";
    return "loading";
  });

  const mode = computed<ReplyMode>(() => {
    if (!ticketId()) return { mode: "email" };
    return resolveReplyChannel({
      descriptor: descriptor.value,
      raisedBy: ticket.value?.ticket.doc?.raised_by,
      activities: activitiesState.value,
    });
  });

  // Create the draft controller as soon as the channel is known, so a settled
  // request is noticed when its row appears even before the composer opens.
  // This is a watcher, not a computed: it writes state.
  watch(
    () => [entry.value, descriptor.value?.key] as const,
    ([current, channelKey]) => {
      if (current && channelKey) controllerFor(current, channelKey);
    },
    { immediate: true, flush: "sync" }
  );

  watch(
    () => descriptor.value?.outbound,
    (rows) => {
      const current = entry.value;
      current?.controller?.observe(rows);
      if (current && shouldPoll(current)) current.poller.start();
    },
    { immediate: true }
  );

  const reply = computed(() => entry.value?.snapshot.value ?? EMPTY_SNAPSHOT);

  const pollWanted = computed(() => {
    const current = entry.value;
    return current ? shouldPoll(current) : false;
  });

  function requireController() {
    const current = entry.value?.controller;
    if (!current) throw new Error("This conversation has no reply channel.");
    return current;
  }

  return {
    descriptor,
    mode,
    reply,
    shouldPoll: pollWanted,
    setDraft: (text) => requireController().setDraft(text),
    submit: () => {
      const current = entry.value;
      const outcome = requireController().submit();
      current?.poller.start();
      return outcome;
    },
    submitTemplate: (
      template: string,
      language: string,
      parameters: string[]
    ) => {
      const current = entry.value;
      const outcome = requireController().submitTemplate(
        template,
        language,
        parameters
      );
      current?.poller.start();
      return outcome;
    },
    submitFile: (file: string, caption: string) => {
      const current = entry.value;
      const outcome = requireController().submitFile(file, caption);
      current?.poller.start();
      return outcome;
    },
    discardDraft: () => requireController().discardDraft(),
    discardPending: () => requireController().discardPending(),
    restorePendingText: () => requireController().restorePendingText(),
    refresh: async () => {
      const current = entry.value;
      return current ? refresh(current) : null;
    },
  };
}

/**
 * Start and stop the bounded poller with the ticket view. Reading only; the
 * poller runs while a reply is queued or unconfirmed and is stopped on unmount,
 * on navigation and when nothing is pending.
 */
export function useChannelPolling(
  ticketId: () => string | number | null | undefined
) {
  const channel = useTicketChannel(ticketId);

  const stop = () => {
    const id = ticketId();
    if (id) entries.get(String(id))?.poller.stop();
  };

  watch(
    () => [ticketId(), channel.shouldPoll.value] as const,
    ([id, wanted], previous) => {
      const previousId = previous?.[0];
      if (previousId && String(previousId) !== String(id)) {
        entries.get(String(previousId))?.poller.stop();
      }
      if (!id) return;
      const poller = entryFor(id).poller;
      if (wanted) poller.start();
      else poller.stop();
    },
    { immediate: true }
  );

  const onVisible = () => {
    if (document.visibilityState !== "visible") return;
    const id = ticketId();
    if (id && channel.shouldPoll.value) entryFor(id).poller.restart();
  };
  document.addEventListener("visibilitychange", onVisible);

  if (getCurrentScope()) {
    onScopeDispose(() => {
      document.removeEventListener("visibilitychange", onVisible);
      stop();
    });
  }
  return channel;
}
