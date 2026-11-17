<template>
  <div class="flex h-full flex-col">
    <LayoutHeader>
      <template #left-header>
        <div class="text-lg-medium text-ink-gray-9">Call Logs</div>
        <!--
          The ZIWO view reads the Inchaa ZIWO call log. The standard view is the page as Helpdesk
          ships it (TP Call Log: Twilio, Exotel and manual logs) and is unchanged.
        -->
        <TabButtons
          v-if="canUseZiwoView"
          class="ms-2"
          :model-value="activeView"
          :options="viewOptions"
          data-testid="call-logs-view-switch"
          @update:model-value="chooseView"
        />
      </template>
      <template #right-header>
        <Button
          v-if="activeView === 'standard'"
          label="New Call Log"
          theme="gray"
          variant="solid"
          @click="newCallLog"
          icon-left="lucide-plus"
        />
      </template>
    </LayoutHeader>
    <div
      v-if="!ziwoStatusLoaded"
      class="flex flex-1 items-center justify-center"
      data-testid="call-logs-loading"
    >
      <LoadingIndicator class="size-6 text-ink-gray-4" />
    </div>
    <ZiwoCallLogs v-else-if="activeView === 'ziwo'" />
    <template v-else>
      <ListViewBuilder
        ref="listViewRef"
        :options="options"
        @row-click="openCallLog"
      />
      <CallLogDetailModal
        v-model="showCallLogDetailModal"
        v-model:callLogModal="showCallLogModal"
        :callLogId="callLogId"
      />
      <CallLogModal
        v-model="showCallLogModal"
        :callLogId="callLogId"
        @after-insert="
          () => {
            listViewRef?.reload();
          }
        "
      />
    </template>
  </div>
</template>

<script setup lang="ts">
import Icon from "@/components/Icon.vue";
import LayoutHeader from "@/components/LayoutHeader.vue";
import ListViewBuilder from "@/components/ListViewBuilder.vue";
import {
  Avatar,
  Badge,
  Button,
  LoadingIndicator,
  TabButtons,
  usePageMeta,
} from "frappe-ui";
import { storeToRefs } from "pinia";
import { computed, h, ref } from "vue";
import CallLogDetailModal from "./CallLogDetailModal.vue";
import CallLogModal from "./CallLogModal.vue";
import ZiwoCallLogs from "./ZiwoCallLogs.vue";
import { statusColorMap, statusLabelMap } from "./utils";
import { PhoneIcon } from "@/components/icons";
import { useTelephonyStore } from "@/stores/telephony";
import { __ } from "@/translation";

const showCallLogModal = ref(false);
const showCallLogDetailModal = ref(false);
const callLogId = ref("");

const listViewRef = ref(null);

// Which log to show. A permitted ZIWO agent starts on the ZIWO view; a manager who may read every
// agent's calls can open it; everyone else sees only the standard page, as before. The choice
// waits for the first answer about ZIWO so the page does not start on one view and jump to the
// other.
const telephonyStore = useTelephonyStore();
const {
  isZiwoEnabled,
  isZiwoConnectorEnabled,
  ziwoCanViewAllCalls,
  ziwoStatusLoaded,
} = storeToRefs(telephonyStore);

type LogView = "ziwo" | "standard";
const canUseZiwoView = computed(
  () =>
    isZiwoEnabled.value ||
    (isZiwoConnectorEnabled.value && ziwoCanViewAllCalls.value)
);
const chosenView = ref<LogView | null>(null);
const activeView = computed<LogView>(() => {
  if (!canUseZiwoView.value) return "standard";
  return chosenView.value ?? (isZiwoEnabled.value ? "ziwo" : "standard");
});
const viewOptions = computed(() => [
  { label: __("ZIWO"), value: "ziwo" },
  { label: __("Standard"), value: "standard" },
]);
function chooseView(value: string | number) {
  chosenView.value = value === "standard" ? "standard" : "ziwo";
}

const options = computed(() => {
  return {
    doctype: "TP Call Log",
    selectable: true,
    showSelectBanner: true,
    emptyState: {
      title: "No Call Logs Found",
      icon: PhoneIcon,
    },
    columnConfig: {
      caller: {
        prefix: ({ row }) => {
          return h(Avatar, {
            shape: "circle",
            image: row._caller?.image || "Unknown",
            label: row._caller?.label || "Unknown",
            size: "sm",
          });
        },
        custom: ({ row }) => {
          return h("span", row._caller?.label || "Unknown");
        },
      },
      receiver: {
        prefix: ({ row }) => {
          return h(Avatar, {
            shape: "circle",
            image: row._receiver?.image || "Unknown",
            label: row._receiver?.label || "Unknown",
            size: "sm",
          });
        },
        custom: ({ row }) => {
          return h("span", row._receiver?.label || "Unknown");
        },
      },
      type: {
        prefix: ({ row }) => {
          let icon =
            row.type === "Incoming"
              ? "lucide-phone-incoming"
              : "lucide-phone-outgoing";
          return h(Icon, {
            icon,
            class: ["size-3 shrink-0"],
          });
        },
      },
      status: {
        custom: ({ row }) => {
          return h(Badge, {
            label: statusLabelMap[row.status],
            variant: "subtle",
            theme: statusColorMap[row.status],
          });
        },
      },
      duration: {
        prefix: () => {
          return h(Icon, {
            icon: "lucide-clock",
            class: ["size-3 shrink-0"],
          });
        },
        custom: ({ row }) => {
          return h("span", row.duration ? row.duration + "s" : "0s");
        },
      },
    },
  };
});

const newCallLog = () => {
  callLogId.value = "";
  showCallLogModal.value = true;
};

function openCallLog(id: string): void {
  callLogId.value = id;
  showCallLogDetailModal.value = true;
}

usePageMeta(() => {
  return {
    title: "Call Logs",
  };
});
</script>
