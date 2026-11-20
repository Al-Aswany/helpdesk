<template>
  <p v-if="text" class="text-sm text-ink-gray-7">{{ text }}</p>
</template>

<script setup lang="ts">
import { __ } from "@/translation";
import { dayjs } from "frappe-ui";
import { computed } from "vue";

const props = defineProps<{
  summary?: {
    inchaa_call_attempts?: number;
    inchaa_connected_calls?: number;
    inchaa_last_call_at?: string | null;
    inchaa_last_outcome?: string | null;
    inchaa_next_callback_at?: string | null;
  } | null;
}>();

function when(value: string) {
  return dayjs(value).format("DD MMM YYYY, HH:mm");
}

// The sentences are joined here, not laid out in the template, because the template compiler
// drops the whitespace between conditional blocks and ran them together.
const text = computed(() => {
  const summary = props.summary;
  if (!summary) return "";
  const parts = [
    __("{0} attempts, {1} connected.", [
      summary.inchaa_call_attempts || 0,
      summary.inchaa_connected_calls || 0,
    ]),
  ];
  if (summary.inchaa_last_call_at)
    parts.push(__("Last called {0}.", [when(summary.inchaa_last_call_at)]));
  if (summary.inchaa_last_outcome)
    parts.push(__("Last outcome: {0}.", [__(summary.inchaa_last_outcome)]));
  if (summary.inchaa_next_callback_at)
    parts.push(
      __("Next follow-up {0}.", [when(summary.inchaa_next_callback_at)])
    );
  return parts.join(" ");
});
</script>
