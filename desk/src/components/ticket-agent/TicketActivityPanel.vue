<template>
  <Tabs
    :modelValue="tabIndex"
    :tabs="tabs"
    @update:modelValue="changeTabTo"
    class="[&_[role='tab']]:px-0 [&_[role='tablist']]:px-5 [&_[role='tablist']]:gap-7.5 [&_[role='tablist']]:flex-shrink-0 [&_[role='tabpanel'][data-state='active']]:flex-1"
  >
    <template #tab-panel="{ tab }">
      <TicketAnalyticsTab v-if="tab.name === 'analytics'" />
      <TicketAgentActivities
        v-else-if="Boolean(activities.data)"
        ref="ticketAgentActivitiesRef"
        :activities="filterActivities(tab.name as TicketTab)"
        :title="tab.label"
        :ticket-status="ticket.doc.status"
        @email:reply="
          (e) => {
            communicationAreaRef?.replyToEmail(e);
          }
        "
        @update="
          () => {
            activities.reload();
            ticketAgentActivitiesRef?.scrollToLatestActivity();
          }
        "
      />
      <!-- <div v-else class="flex items-center justify-center flex-col flex-1">
        <Button :loading="true" variant="ghost" size="2xl" />
        <p class="text-2xl-medium text-ink-gray-5">Loading...</p>
      </div> -->
    </template>
  </Tabs>
  <!-- Comm Area -->
  <CommunicationArea
    ref="communicationAreaRef"
    :ticketId="String(ticket.doc?.name)"
    :to-emails="[ticket.doc?.raised_by]"
    :cc-emails="[]"
    :bcc-emails="[]"
    :key="ticket.doc?.name"
    @update="
      () => {
        activities.reload();
        ticketAgentActivitiesRef?.scrollToLatestActivity();
      }
    "
  />
</template>

<script setup lang="ts">
import CommunicationArea from "@/components/CommunicationArea.vue";
import {
  ActivityIcon,
  CommentIcon,
  EmailIcon,
  PhoneIcon,
} from "@/components/icons";
import LucideMessageSquare from "~icons/lucide/message-square";
import TicketAnalyticsTab from "@/components/ticket-agent/analytics/TicketAnalyticsTab.vue";
import LucideChartNoAxesColumn from "~icons/lucide/chart-no-axes-column";
import { useActiveTabManager } from "@/composables/useActiveTabManager";
import {
  buildMessageActivities,
  useChannelPolling,
} from "@/composables/ticketChannel";
import { useTelephonyStore } from "@/stores/telephony";
import { ActivitiesSymbol, TabObject, TicketSymbol, TicketTab } from "@/types";
import { Button, Tabs } from "frappe-ui";
import { storeToRefs } from "pinia";
import { computed, ComputedRef, inject, ref } from "vue";
import { TicketAgentActivities } from "../ticket";

const ticket = inject(TicketSymbol);
const activities = inject(ActivitiesSymbol);
// Conversation channel of this ticket, if an installed app provides one. Also
// keeps the bounded status polling in step with this view's lifetime.
const channel = useChannelPolling(() => ticket?.value?.doc?.name);

const ticketAgentActivitiesRef = ref<InstanceType<
  typeof TicketAgentActivities
> | null>(null);
const communicationAreaRef = ref<InstanceType<typeof CommunicationArea> | null>(
  null
);
const telephonyStore = useTelephonyStore();
const { isCallingEnabled } = storeToRefs(telephonyStore);

const hasEmailActivity = computed(() =>
  Boolean(
    activities.value?.data?.communications?.some(
      (item) => item.communication_medium !== "Chat"
    )
  )
);

const tabs: ComputedRef<TabObject[]> = computed(() => {
  const _tabs: TabObject[] = [
    {
      name: "activity",
      label: "Activity",
      icon: ActivityIcon,
    },
  ];

  const isChannelTicket = Boolean(channel.descriptor.value);
  if (isChannelTicket) {
    _tabs.push({
      name: "chat",
      label: "Messages",
      icon: LucideMessageSquare,
    });
  }
  // A channel conversation has no email tab unless it also holds emails.
  if (!isChannelTicket || hasEmailActivity.value) {
    _tabs.push({
      name: "email",
      label: "Emails",
      icon: EmailIcon,
    });
  }
  _tabs.push({
    name: "comment",
    label: "Comments",
    icon: CommentIcon,
  });

  if (isCallingEnabled.value) {
    _tabs.push({
      name: "call",
      label: "Calls",
      icon: PhoneIcon,
    });
  }
  _tabs.push({
    name: "analytics",
    label: "Analytics",
    icon: LucideChartNoAxesColumn,
  });
  return _tabs;
});

const { tabIndex, changeTabTo } = useActiveTabManager(tabs);

// TODO: refactor for pagination
// can be done once we sort out the backend
// sender mail will be  user using portal
const _activities = computed(() => {
  if (!activities.value?.data) {
    return [];
  }
  // Emails keep their existing shape; chat messages and unfinished outbound
  // replies become `chat` activities (see ticketChannel/logic.ts).
  const emailProps = buildMessageActivities(
    activities.value.data.communications,
    channel.descriptor.value
  );

  const commentProps = activities.value.data.comments.map((comment) => {
    return {
      name: comment.name,
      type: "comment",
      key: comment.creation,
      commentedBy: comment.commented_by,
      commenter: comment.user.name,
      creation: comment.creation,
      content: comment.content,
      attachments: comment.attachments,
    };
  });

  activities.value.data.history.map((h) => {
    // }
    h.action;
    h.owner;
    // if h.actions includes h.owner, replace it with 'themselves'
    if (h.action && h.owner && h.action.includes(h.owner)) {
      h.action = h.action.replace(h.owner, "themselves");
    }
    return h;
  });

  const historyProps = [
    ...activities.value.data.history,
    ...activities.value.data.views,
  ].map((h) => {
    return {
      type: "history",
      key: h.creation,
      content: h.action ? h.action : "viewed this",
      creation: h.creation,
      user: h.user.name + " ",
    };
  });

  const callProps = activities.value.data.calls.map((call) => {
    return {
      ...call,
      type: "call",
      name: call.name,
      key: call.creation,
      call_type: call.type,
      content: `${call.caller || "Unknown"} made a call to ${
        call.receiver || "Unknown"
      }`,
      duration: call.duration ? call.duration + "s" : "0s",
    };
  });

  const sorted = [
    ...emailProps,
    ...commentProps,
    ...historyProps,
    ...callProps,
  ].sort((a, b) => new Date(a.creation) - new Date(b.creation));
  const data = [];
  let i = 0;

  while (i < sorted.length) {
    const currentActivity = sorted[i];

    if (currentActivity.type === "history") {
      currentActivity.relatedActivities = [currentActivity];
      for (let j = i + 1; j < sorted.length + 1; j++) {
        const nextActivity = sorted[j];

        if (
          nextActivity &&
          nextActivity.user === currentActivity.user &&
          nextActivity.content !== "viewed this" &&
          !nextActivity.content.includes("assigned") &&
          !nextActivity.content.includes("unassigned")
        ) {
          currentActivity.relatedActivities.push(nextActivity);
        } else {
          data.push(currentActivity);
          i = j - 1;
          break;
        }
      }
    } else {
      data.push(currentActivity);
    }
    i++;
  }
  // Feedback is not a timeline entry on desktop, it lives in the sidebar
  // (TicketDetailsTab). Mobile still appends it to its own activity list.
  return data;
});

function filterActivities(eventType: TicketTab) {
  if (eventType === "activity") {
    return _activities.value;
  }
  return _activities.value.filter((activity) => activity.type === eventType);
}
</script>
