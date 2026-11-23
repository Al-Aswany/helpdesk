<template>
  <section
    v-if="stats.data"
    class="mb-4 px-1"
    data-testid="contact-centre-section"
  >
    <h2 class="mb-3 text-base font-medium text-ink-gray-9">
      {{ __("Contact centre") }}
    </h2>
    <div class="grid grid-cols-1 gap-4 md:grid-cols-2 lg:grid-cols-5">
      <NumberCard
        v-for="card in stats.data.cards"
        :key="card.key"
        v-bind="reading(card)"
        :data-testid="`contact-centre-${card.key}`"
      >
        <!-- The row above is as tall as its "No data" caption. Reserve that line. -->
        <template #caption>
          <span class="invisible" aria-hidden="true">{{ __("No data") }}</span>
        </template>
      </NumberCard>
    </div>
    <ChartCard v-if="stats.data.outcomes.length" class="mt-4">
      <div class="flex flex-col gap-1.5">
        <div class="text-sm text-ink-gray-5">{{ __("Call outcomes") }}</div>
        <div class="space-y-2">
          <div
            v-for="row in stats.data.outcomes"
            :key="row.label"
            class="flex items-center gap-3 text-sm"
          >
            <span class="w-32 shrink-0 truncate text-ink-gray-8">{{ row.label }}</span>
            <div class="h-2 flex-1 rounded-1 bg-surface-gray-2">
              <div
                class="h-2 rounded-1"
                :style="{
                  width: `${(row.value / topOutcome) * 100}%`,
                  backgroundColor: 'var(--chart-sequential-2)',
                }"
              />
            </div>
            <span class="w-8 text-end text-sm tabular-nums text-ink-gray-5">
              {{ row.value }}
            </span>
          </div>
        </div>
      </div>
    </ChartCard>
  </section>
</template>

<script setup lang="ts">
import { __ } from "@/translation";
import { createResource } from "frappe-ui";
import { ChartCard, NumberCard } from "frappe-ui/charts";
import { computed, watch } from "vue";

interface StatsFilters {
  from_date: string | null;
  to_date: string | null;
  agent: string | null;
}

interface CentreCard {
  key: string;
  label: string;
  value: number | string;
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

function reading(card: CentreCard) {
  const ratio =
    typeof card.value === "string"
      ? card.value.match(/^(\d+)\s*\/\s*(\d+)$/)
      : null;
  return {
    title: card.label,
    value: ratio ? Number(ratio[1]) : card.value,
    target: ratio ? Number(ratio[2]) : undefined,
    color:
      card.key === "overdue_callbacks" && card.value
        ? "var(--ink-red-6)"
        : undefined,
  };
}

watch(
  () => [props.filters.from_date, props.filters.to_date, props.filters.agent],
  () => stats.reload()
);
</script>
