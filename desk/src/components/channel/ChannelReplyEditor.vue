<template>
  <section
    class="channel-reply"
    :aria-label="__('Reply')"
    :data-channel-mode="resolved.mode"
  >
    <!-- The lookup is still running. The email composer is never a fallback. -->
    <div
      v-if="resolved.mode === 'checking'"
      class="mx-6 md:mx-5 flex items-center gap-2 border-t py-5 text-p-sm text-ink-gray-5"
      role="status"
      data-testid="channel-checking"
    >
      <LoadingIndicator class="size-4" />
      <span>{{ __("Checking how to reach this customer...") }}</span>
    </div>

    <!-- Replies are off for this conversation. Nothing can be typed or sent. -->
    <div
      v-else-if="resolved.mode === 'unavailable'"
      class="mx-6 md:mx-5 border-t py-4"
      data-testid="channel-unavailable"
    >
      <ChannelRecipient
        v-if="resolved.descriptor"
        :descriptor="resolved.descriptor"
        class="mb-3"
      />
      <div
        class="flex items-start gap-2 rounded-md bg-surface-amber-2 p-3 text-ink-amber-8"
        role="alert"
      >
        <LucideTriangleAlert
          class="mt-0.5 size-4 shrink-0"
          aria-hidden="true"
        />
        <div class="min-w-0 text-p-sm">
          <p class="font-medium">{{ __(unavailableCopy.title) }}</p>
          <p class="mt-0.5">{{ __(unavailableCopy.detail) }}</p>
          <router-link
            v-if="currentTicket"
            class="mt-1.5 inline-block font-medium underline"
            :to="{ name: 'TicketAgent', params: { ticketId: currentTicket } }"
            data-testid="channel-current-ticket"
          >
            {{ __("Open ticket #{0}", [currentTicket]) }}
          </router-link>
        </div>
      </div>
      <div class="mt-3 flex justify-end">
        <Button :label="__('Close')" @click="emit('discard')" />
      </div>
    </div>

    <!-- WhatsApp-style reply: read-only recipient, one text box, no email fields. -->
    <template v-else-if="resolved.mode === 'channel'">
      <div class="mx-6 md:mx-5 flex flex-col gap-2 border-t pt-3">
        <ChannelRecipient :descriptor="resolved.descriptor" />

        <!-- Why sending is off, and what to do next -->
        <div
          v-if="!resolved.canSend"
          class="flex items-start gap-2 rounded-md bg-surface-amber-2 p-3 text-ink-amber-8"
          role="status"
          data-testid="channel-hold"
        >
          <LucideTriangleAlert
            class="mt-0.5 size-4 shrink-0"
            aria-hidden="true"
          />
          <div class="min-w-0 text-p-sm">
            <p class="font-medium">{{ __(holdCopy.title) }}</p>
            <p class="mt-0.5">{{ __(holdCopy.detail) }}</p>
          </div>
        </div>
        <form
          v-if="templates.length"
          class="flex flex-col gap-2 rounded-md border border-outline-gray-2 p-3"
          data-testid="channel-template"
          @submit.prevent="sendTemplate"
        >
          <label class="text-p-sm text-ink-gray-7">
            {{ __("Approved template") }}
            <select
              v-model="templateKey"
              class="mt-1 w-full rounded border border-outline-gray-2 bg-surface-white px-2 py-1"
              data-testid="channel-template-select"
            >
              <option v-for="item in templates" :key="item.name + item.language" :value="item.name + '|' + item.language">
                {{ item.label }}
              </option>
            </select>
          </label>
          <label
            v-for="index in templateParameterCount"
            :key="index"
            class="text-p-sm text-ink-gray-7"
          >
            {{ __("Parameter {0}", [String(index)]) }}
            <input
              v-model="templateParameters[index - 1]"
              dir="auto"
              class="mt-1 w-full rounded border border-outline-gray-2 px-2 py-1"
              :data-testid="'channel-template-param-' + index"
            />
          </label>
          <div class="flex justify-end">
            <Button
              variant="solid"
              :label="__('Send template')"
              :disabled="!templateReady"
              data-testid="channel-template-send"
              @click="sendTemplate"
            />
          </div>
        </form>
        <div v-if="resolved.canSend && resolved.descriptor.capabilities.media" class="flex items-center gap-2">
          <input
            ref="fileRef"
            type="file"
            class="text-p-sm"
            data-testid="channel-file"
            @change="onFile"
          />
        </div>
        <p
          v-if="windowHint"
          class="text-p-xs text-ink-gray-5"
          data-testid="channel-window"
        >
          {{ windowHint }}
        </p>

        <!-- Result of the last attempt (live region: announced, never stolen focus) -->
        <div aria-live="polite" class="flex flex-col gap-2">
          <div
            v-if="blockedCopy"
            class="rounded-md bg-surface-amber-2 p-3 text-p-sm text-ink-amber-8"
            data-testid="channel-notice-blocked"
          >
            <p class="font-medium">{{ __(blockedCopy.title) }}</p>
            <p class="mt-0.5">{{ __(blockedCopy.detail) }}</p>
            <p class="mt-0.5">{{ __("Your text is kept below.") }}</p>
          </div>
          <div
            v-else-if="state.notice?.kind === 'conflict'"
            class="rounded-md bg-surface-amber-2 p-3 text-p-sm text-ink-amber-8"
            data-testid="channel-notice-conflict"
          >
            <p class="font-medium">{{ __("This reply was not sent") }}</p>
            <p class="mt-0.5">
              {{
                __(
                  "It could not be matched to an earlier attempt. Your text is kept below. Check the conversation, then send it again."
                )
              }}
            </p>
          </div>
          <div
            v-else-if="state.notice?.kind === 'rejected'"
            class="rounded-md bg-surface-red-1 p-3 text-p-sm text-ink-red-6"
            role="alert"
            data-testid="channel-notice-rejected"
          >
            <p class="font-medium">{{ __("This reply was not sent") }}</p>
            <ul class="mt-0.5 list-inside list-disc">
              <li
                v-for="(line, i) in state.notice.messages"
                :key="i"
                dir="auto"
              >
                {{ line }}
              </li>
            </ul>
            <p class="mt-0.5">{{ __("Your text is kept below.") }}</p>
          </div>
          <div
            v-else-if="state.phase === 'confirming'"
            class="flex items-center gap-2 rounded-md bg-surface-gray-2 p-3 text-p-sm text-ink-gray-7"
            role="status"
            data-testid="channel-notice-saving"
          >
            <LoadingIndicator class="size-4 shrink-0" />
            <span>{{ __("Reply saved. Waiting for its status...") }}</span>
          </div>
          <div
            v-else-if="state.phase === 'unconfirmed' || resolutionNeeded"
            class="rounded-md bg-surface-amber-2 p-3 text-p-sm text-ink-amber-8"
            role="alert"
            data-testid="channel-notice-unconfirmed"
          >
            <p class="font-medium">
              {{ __("We could not confirm that this reply was received") }}
            </p>
            <p class="mt-0.5">
              {{
                resolutionNeeded
                  ? __(
                      "You changed the text of a reply that is still unconfirmed. Restore it to try again, or discard it to write a new one."
                    )
                  : __(
                      "It may already have been saved. Trying again is safe: it will not be sent twice."
                    )
              }}
            </p>
            <div class="mt-2 flex flex-wrap gap-2">
              <Button
                v-if="!resolutionNeeded"
                size="sm"
                :label="__('Try again')"
                :disabled="!canSubmit"
                :loading="state.phase === 'sending'"
                @click="submit"
              />
              <Button
                v-else
                size="sm"
                :label="__('Restore text')"
                @click="restore"
              />
              <Button size="sm" :label="__('Check status')" @click="check" />
              <Button
                size="sm"
                variant="subtle"
                theme="red"
                :label="__('Discard request')"
                @click="discardRequest"
              />
            </div>
          </div>
        </div>

        <textarea
          ref="textareaRef"
          v-model="draft"
          dir="auto"
          rows="4"
          class="min-h-[7rem] max-h-[30vh] w-full resize-y rounded border border-outline-gray-2 bg-surface-white px-3 py-2 text-base text-ink-gray-8 placeholder-ink-gray-4 transition-colors hover:border-outline-gray-3 focus:border-outline-gray-4 focus:outline-none focus:ring-2 focus:ring-outline-gray-3 disabled:cursor-not-allowed disabled:opacity-60"
          :placeholder="placeholder ? __(placeholder) : ''"
          :aria-label="__('Message to the customer')"
          :disabled="!resolved.canSend"
          :aria-invalid="tooLong"
          data-testid="channel-textarea"
        />
        <p
          v-if="showCounter"
          class="text-end text-p-xs"
          :class="tooLong ? 'text-ink-red-6' : 'text-ink-gray-5'"
          data-testid="channel-counter"
        >
          {{ length }} / {{ maxLength }}
        </p>
      </div>

      <div class="mx-6 md:mx-5 flex items-center justify-between gap-2 py-3">
        <p class="hidden text-p-xs text-ink-gray-5 sm:block">
          {{ __("Visible to the customer") }}
        </p>
        <div class="ms-auto flex items-center gap-x-2">
          <Button :label="__('Discard')" @click="discard" />
          <Button
            variant="solid"
            :label="label"
            :disabled="!canSubmit"
            :loading="state.phase === 'sending'"
            data-testid="channel-send"
            @click="submit"
          />
        </div>
      </div>
    </template>
  </section>
</template>

<script setup lang="ts">
import {
  formatWindowLeft,
  reasonCopy,
  useTicketChannel,
} from "@/composables/ticketChannel";
import { __ } from "@/translation";
import { useNow } from "@vueuse/core";
import { Button, LoadingIndicator } from "frappe-ui";
import { computed, nextTick, ref, watch } from "vue";
import LucideTriangleAlert from "~icons/lucide/triangle-alert";
import ChannelRecipient from "./ChannelRecipient.vue";

const props = defineProps<{
  ticketId: string;
  label: string;
  placeholder?: string;
}>();

const emit = defineEmits<{ submit: []; discard: [] }>();

const channel = useTicketChannel(() => props.ticketId);
const resolved = channel.mode;
const state = channel.reply;
const textareaRef = ref<HTMLTextAreaElement | null>(null);
const resolutionNeeded = ref(false);
/** An attempt is running or unconfirmed; close the box once it is settled. */
const attempting = ref(false);

const draft = computed({
  get: () => state.value.draft,
  set: (value: string) => {
    resolutionNeeded.value = false;
    channel.setDraft(value);
  },
});

const maxLength = computed(() =>
  resolved.value.mode === "channel"
    ? resolved.value.descriptor.reply.max_length
    : null
);
const length = computed(() => Array.from(draft.value).length);
const tooLong = computed(() =>
  Boolean(maxLength.value && length.value > maxLength.value)
);
const showCounter = computed(
  () =>
    Boolean(maxLength.value) &&
    length.value >= (maxLength.value as number) * 0.8
);

const canSubmit = computed(
  () =>
    resolved.value.mode === "channel" &&
    resolved.value.canSend &&
    state.value.phase !== "sending" &&
    state.value.phase !== "confirming" &&
    draft.value.trim().length > 0 &&
    !tooLong.value
);

const unavailableCopy = computed(() =>
  resolved.value.mode === "unavailable"
    ? reasonCopy(resolved.value.reason)
    : reasonCopy(null)
);
const holdCopy = computed(() => {
  if (resolved.value.mode !== "channel") return reasonCopy(null);
  if (
    resolved.value.holdReason === "template_required" &&
    !(resolved.value.descriptor.templates || []).length
  ) {
    return reasonCopy("no_approved_template");
  }
  return reasonCopy(resolved.value.holdReason);
});
const templates = computed(() =>
  resolved.value.mode === "channel" ? resolved.value.descriptor.templates || [] : []
);
const templateKey = ref("");
const templateParameters = ref<string[]>([]);
const fileRef = ref<HTMLInputElement | null>(null);
const selectedTemplate = computed(() =>
  templates.value.find((item) => `${item.name}|${item.language}` === templateKey.value)
);
const templateParameterCount = computed(() => selectedTemplate.value?.parameter_count || 0);
const templateReady = computed(() => {
  const count = templateParameterCount.value;
  if (!selectedTemplate.value) return false;
  return templateParameters.value.slice(0, count).every((value) => value && value.trim());
});

async function sendTemplate() {
  const chosen = selectedTemplate.value;
  if (!chosen || !templateReady.value) return;
  await channel.submitTemplate(
    chosen.name,
    chosen.language,
    templateParameters.value.slice(0, chosen.parameter_count)
  );
}

async function onFile(event: Event) {
  const input = event.target as HTMLInputElement;
  const file = input.files?.[0];
  if (!file) return;
  const body = new FormData();
  body.append("file", file, file.name);
  body.append("is_private", "1");
  body.append("doctype", "HD Ticket");
  body.append("docname", props.ticketId);
  body.append("folder", "Home/Attachments");
  const response = await fetch("/api/method/upload_file", {
    method: "POST",
    body,
    headers: {
      "X-Frappe-CSRF-Token":
        (window as unknown as { csrf_token?: string }).csrf_token || "",
    },
  });
  const payload = await response.json();
  const name = payload?.message?.name;
  if (name) await channel.submitFile(name, draft.value);
  input.value = "";
}
const currentTicket = computed(() =>
  resolved.value.mode === "unavailable"
    ? resolved.value.descriptor?.current_ticket
    : null
);

const blockedCopy = computed(() => {
  const notice = state.value.notice;
  if (notice?.kind !== "blocked") return null;
  const copy = reasonCopy(notice.reason);
  const known = notice.reason && copy.title !== reasonCopy(null).title;
  return known || !notice.message
    ? copy
    : { title: copy.title, detail: notice.message };
});

// The window text counts down in the browser from the time it was read.
const now = useNow({ interval: 30_000 });
const readAt = ref(Date.now());
watch(
  () => (resolved.value.mode === "channel" ? resolved.value.descriptor : null),
  () => {
    readAt.value = Date.now();
  },
  { immediate: true }
);
const windowHint = computed(() => {
  if (resolved.value.mode !== "channel") return "";
  const left = resolved.value.descriptor.window.seconds_left;
  if (!(left > 0)) return "";
  const remaining = left - (now.value.getTime() - readAt.value) / 1000;
  return remaining > 0
    ? __("You can reply freely for {0} more.", [formatWindowLeft(remaining)])
    : "";
});

async function submit() {
  if (!canSubmit.value) return false;
  attempting.value = true;
  const outcome = await channel.submit();
  resolutionNeeded.value = outcome.kind === "needs_resolution";
  if (outcome.kind !== "unconfirmed" && outcome.kind !== "saved") {
    // Settled one way or another; the watcher below decides about closing.
    settle();
  }
  return outcome.kind === "confirmed" || outcome.kind === "saved";
}

function settle() {
  const snapshot = state.value;
  if (!attempting.value) return;
  if (snapshot.phase === "idle" && !snapshot.pending) {
    attempting.value = false;
    if (!snapshot.notice && !snapshot.draft) emit("submit");
  }
}

// A request that was saved but whose row was not visible yet is settled by the
// next refresh or poll; close the box then.
watch(
  () => [
    state.value.phase,
    state.value.pending,
    state.value.notice,
    state.value.draft,
  ],
  settle
);

async function check() {
  await channel.refresh().catch(() => null);
}

function restore() {
  resolutionNeeded.value = false;
  channel.restorePendingText();
  nextTick(() => textareaRef.value?.focus());
}

async function discardRequest() {
  resolutionNeeded.value = false;
  attempting.value = false;
  await channel.discardPending();
}

async function discard() {
  resolutionNeeded.value = false;
  attempting.value = false;
  await channel.discardDraft();
  emit("discard");
}

function focus() {
  textareaRef.value?.focus();
}

defineExpose({ submit, focus });
</script>
