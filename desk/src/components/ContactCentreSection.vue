<template>
  <section
    v-if="stats.data"
    class="mb-4 space-y-3 px-1"
    data-testid="contact-centre-section"
  >
    <h2 class="text-base font-medium text-ink-gray-8">
      {{ __("Contact centre") }}
    </h2>
    <div class="grid grid-cols-2 gap-4 md:grid-cols-3 lg:grid-cols-6">
      <div
        v-for="card in stats.data.cards"
        :key="card.key"
        class="rounded-lg border border-outline-gray-2 px-4 py-3"
        :data-testid="`contact-centre-${card.key}`"
      >
        <div class="text-sm text-ink-gray-6">{{ card.label }}</div>
        <div
          class="mt-1 text-2xl font-semibold"
          :class="
            card.key === 'overdue_callbacks' && card.value
              ? 'text-ink-red-6'
              : 'text-ink-gray-9'
          "
        >
          {{ card.value }}
        </div>
      </div>
    </div>
    <div
      v-if="stats.data.outcomes.length"
      class="rounded-lg border border-outline-gray-2 px-4 py-3"
    >
      <div class="mb-2 text-sm text-ink-gray-6">{{ __("Call outcomes") }}</div>
      <div class="space-y-1.5">
        <div
          v-for="row in stats.data.outcomes"
          :key="row.label"
          class="flex items-center gap-3 text-sm"
        >
          <span class="w-32 shrink-0 truncate text-ink-gray-8">{{ row.label }}</span>
          <div class="h-2 flex-1 rounded bg-surface-gray-2">
            <div
              class="h-2 rounded bg-surface-violet-4"
              :style="{ width: `${(row.value / topOutcome) * 100}%` }"
            />
          </div>
          <span class="w-8 text-end text-ink-gray-7">{{ row.value }}</span>
        </div>
      </div>
    </div>
  </section>
</template>

<script setup lang="ts">
import { __ } from "@/translation";
import { createResource } from "frappe-ui";
import { computed, watch } from "vue";

interface StatsFilters {
  from_date: string | null;
  to_date: string | null;
  agent: string | null;
}

const props = defineProps<{ filters: StatsFilters }>();

const stats = createResource({
  url: "inchaa_custmization.integrations.contact_centre.get_stats",
  method: "GET",
  makeParams: () => ({
    from_date: props.filters.from_date,
    to_date: props.filters.to_date,
    agent: props.filters.agent || undefined,
  }),
  auto: true,
});

const topOutcome = computed(() =>
  Math.max(1, ...(stats.data?.outcomes || []).map((row: { value: number }) => row.value))
);

watch(
  () => [props.filters.from_date, props.filters.to_date, props.filters.agent],
  () => stats.reload()
);
</script>
