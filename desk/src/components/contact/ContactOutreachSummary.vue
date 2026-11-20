<template>
  <p v-if="summary" class="text-sm text-ink-gray-7">
    {{
      __("{0} attempts, {1} connected.", [
        summary.inchaa_call_attempts || 0,
        summary.inchaa_connected_calls || 0,
      ])
    }}
    <template v-if="summary.inchaa_last_call_at">
      {{ __("Last called {0}.", [when(summary.inchaa_last_call_at)]) }}
    </template>
    <template v-if="summary.inchaa_last_outcome">
      {{ __("Last outcome: {0}.", [__(summary.inchaa_last_outcome)]) }}
    </template>
    <template v-if="summary.inchaa_next_callback_at">
      {{ __("Next follow-up {0}.", [when(summary.inchaa_next_callback_at)]) }}
    </template>
  </p>
</template>

<script setup lang="ts">
import { __ } from "@/translation";
import { dayjs } from "frappe-ui";

defineProps<{
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
</script>
