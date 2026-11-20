<template>
  <div class="flex flex-col">
    <LayoutHeader>
      <template #left-header>
        <div class="text-lg-medium text-ink-gray-9">
          {{ __("Contacts") }}
        </div>
      </template>
      <template #right-header>
        <Button
          class="mr-2"
          :label="__('Not called yet')"
          variant="subtle"
          @click="showUncalled"
        />
        <Button
          class="mr-2"
          :label="__('Call columns')"
          variant="subtle"
          @click="showCallColumns"
        />
        <Button
          :label="__('Create')"
          theme="gray"
          variant="solid"
          @click="showNewContactModal = !showNewContactModal"
        >
          <template #prefix>
            <LucidePlus class="h-4 w-4" />
          </template>
        </Button>
      </template>
    </LayoutHeader>
    <ListViewBuilder ref="listViewRef" :options="options" />
    <NewContactDialog v-model="showNewContactModal" />
  </div>
</template>
<script setup lang="ts">
import { LayoutHeader, ListViewBuilder } from "@/components";
import NewContactDialog from "@/components/contact/NewContactDialog.vue";
import { PhoneIcon } from "@/components/icons";
import { __ } from "@/translation";
import { Avatar, usePageMeta } from "frappe-ui";
import { computed, h, ref } from "vue";
import LucideContact2 from "~icons/lucide/contact-2";
import { showNewContactModal } from "./dialogState";

const hasActiveFilters = computed(
  () => Object.keys(listViewRef.value?.list?.params?.filters || {}).length > 0
);
const listViewRef = ref(null);
const options = computed(() => {
  return {
    doctype: "Contact",
    selectable: true,
    showSelectBanner: true,
    columnConfig: {
      inchaa_call_attempts: {},
      inchaa_connected_calls: {},
      inchaa_last_call_at: {},
      inchaa_last_outcome: {},
      inchaa_next_callback_at: {},
      full_name: {
        prefix: ({ row }) => {
          return h(Avatar, {
            shape: "circle",
            image: row.image,
            label: row.name,
            size: "sm",
          });
        },
      },
      mobile_no: {
        prefix: ({ row }) => (row.mobile_no ? h(PhoneIcon) : null),
      },
    },
    emptyState: {
      title: "No contacts found",
      icon: h(LucideContact2, {
        class: "h-10 w-10",
      }),
      description: hasActiveFilters.value
        ? __(
            "No contacts found for the applied filters. Try adjusting or clearing your filters."
          )
        : undefined,
    },
    rowRoute: {
      name: "Contact",
      prop: "id",
    },
  };
});

const callColumns = [
  { label: __("Attempts"), type: "Int", key: "inchaa_call_attempts", width: "6rem" },
  {
    label: __("Connected"),
    type: "Int",
    key: "inchaa_connected_calls",
    width: "6rem",
  },
  {
    label: __("Last called"),
    type: "Datetime",
    key: "inchaa_last_call_at",
    width: "10rem",
  },
  {
    label: __("Last outcome"),
    type: "Data",
    key: "inchaa_last_outcome",
    width: "8rem",
  },
  {
    label: __("Next follow-up"),
    type: "Datetime",
    key: "inchaa_next_callback_at",
    width: "10rem",
  },
];

function showUncalled() {
  const params = listViewRef.value?.list?.params;
  if (!params) return;
  params.filters = { inchaa_call_attempts: 0 };
  listViewRef.value.reload();
}

function showCallColumns() {
  const params = listViewRef.value?.list?.params;
  if (!params) return;
  const current = Array.isArray(params.columns) ? params.columns : [];
  const keys = new Set(current.map((column) => column.key));
  params.columns = [
    ...current,
    ...callColumns.filter((column) => !keys.has(column.key)),
  ];
  listViewRef.value.reload();
}

usePageMeta(() => {
  return {
    title: "Contacts",
  };
});
</script>
