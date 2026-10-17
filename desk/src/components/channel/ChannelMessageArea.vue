<template>
  <div
    :id="elementId"
    v-bind="$attrs"
    class="grow bg-surface-base rounded-md text-base leading-6 transition-all duration-300 ease-in-out border border-outline-gray-2"
    :data-direction="activity.direction"
    :data-outbound-state="view?.state"
    data-testid="channel-message"
  >
    <div class="flex items-center justify-between gap-2">
      <div class="flex min-w-0 flex-wrap items-center gap-x-2 gap-y-0.5">
        <span dir="auto" class="truncate font-medium text-ink-gray-8">{{
          senderName
        }}</span>
        <span
          class="inline-flex items-center gap-1 text-p-xs text-ink-gray-5"
          data-testid="channel-message-meta"
        >
          <ChannelIcon
            :name="activity.channel.icon"
            class="size-3.5 shrink-0"
          />
          <span>{{ activity.channel.label }}</span>
          <span aria-hidden="true">·</span>
          <component
            :is="incoming ? LucideArrowDownLeft : LucideArrowUpRight"
            class="size-3.5 shrink-0 rtl:-scale-x-100"
            aria-hidden="true"
          />
          <span>{{ incoming ? __("Received") : __("Sent") }}</span>
        </span>
      </div>
      <div class="flex shrink-0 items-center gap-2">
        <Badge
          v-if="view"
          :label="__(view.label)"
          variant="subtle"
          :theme="view.tone"
          :title="__(view.detail)"
          data-testid="channel-message-state"
        />
        <Tooltip
          v-if="activity.creation"
          :text="dateFormat(activity.creation, dateTooltipFormat)"
        >
          <p class="text-xs md:text-sm text-ink-gray-5">
            {{ timeAgo(activity.creation) }}
          </p>
        </Tooltip>
      </div>
    </div>

    <div class="border-0 border-t my-3 border-outline-elevation-2 !-mx-3" />

    <!-- Customer text is plain text: interpolation only, never v-html -->
    <p
      v-if="(activity.content || '').trim()"
      dir="auto"
      class="whitespace-pre-wrap break-words text-p-base text-ink-gray-8"
      data-testid="channel-message-text"
    >
      {{ activity.content }}
    </p>

    <p
      v-if="view && showDetail"
      class="mt-2 text-p-sm"
      :class="detailClass"
      :role="view.tone === 'red' ? 'alert' : 'status'"
      data-testid="channel-message-detail"
    >
      <span dir="auto">{{ view.detail }}</span>
    </p>

    <div v-if="canReuse" class="mt-2">
      <Button
        size="sm"
        variant="subtle"
        :label="__('Edit and send again')"
        data-testid="channel-message-reuse"
        @click="reuse"
      />
    </div>

    <p
      v-if="activity.attachmentName"
      dir="auto"
      class="mt-2 text-p-sm text-ink-gray-6"
      data-testid="channel-attachment-name"
    >
      {{ activity.attachmentName }}
    </p>

    <div v-if="activity.attachments?.length" class="mt-2 flex flex-wrap gap-2">
      <AttachmentItem
        v-for="a in activity.attachments"
        :key="a.file_url"
        :label="a.file_name"
        :url="a.file_url"
      />
    </div>
  </div>
</template>

<script setup lang="ts">
import { AttachmentItem } from "@/components";
import { outboundView } from "@/composables/ticketChannel";
import { useUserStore } from "@/stores/user";
import { __ } from "@/translation";
import type { ChatActivity } from "@/types";
import { dateFormat, dateTooltipFormat, timeAgo } from "@/utils";
import { Badge, Button, Tooltip } from "frappe-ui";
import { computed, type PropType } from "vue";
import LucideArrowDownLeft from "~icons/lucide/arrow-down-left";
import LucideArrowUpRight from "~icons/lucide/arrow-up-right";
import ChannelIcon from "./ChannelIcon.vue";

defineOptions({ inheritAttrs: false });

const props = defineProps({
  activity: {
    type: Object as PropType<ChatActivity>,
    required: true,
  },
  // Whether the reply box is free to take this text again (decided by the parent)
  reusable: {
    type: Boolean,
    default: false,
  },
});

const emit = defineEmits<{ reuse: [text: string] }>();

const incoming = computed(() => props.activity.direction === "incoming");
const { getUser } = useUserStore();
const senderName = computed(() => {
  const sender = props.activity.sender;
  if (sender?.full_name) return sender.full_name;
  // An outbound row that has no Communication yet only carries the agent's
  // user id. getUser() falls back to the session user for an empty id.
  if (!incoming.value && sender?.name) return getUser(sender.name).full_name;
  return incoming.value ? __("Customer") : __("Agent");
});
const elementId = computed(() =>
  props.activity.key.startsWith("outbound-")
    ? props.activity.key
    : `communication-${props.activity.name}`
);

const view = computed(() =>
  props.activity.outbound
    ? outboundView(props.activity.outbound, props.activity.channel?.label || "WhatsApp")
    : null
);

// "Accepted" is the normal outcome and its caveat is in the badge tooltip.
const showDetail = computed(
  () => view.value && view.value.state !== "Accepted"
);
const detailClass = computed(() => {
  switch (view.value?.tone) {
    case "red":
      return "text-ink-red-6";
    case "orange":
      return "text-ink-amber-8";
    default:
      return "text-ink-gray-5";
  }
});

// A blocked or failed message can be edited and sent as a new reply. An
// uncertain one cannot: it may already have reached the customer.
const canReuse = computed(
  () =>
    props.reusable &&
    ["Blocked", "Failed"].includes(view.value?.state ?? "") &&
    Boolean(props.activity.content)
);

function reuse() {
  emit("reuse", props.activity.content);
}
</script>
