<template>
  <Section v-if="visible" :label="__('Calls')" v-model:opened="opened">
    <div class="space-y-2 pb-3 pt-0.5" data-testid="ziwo-ticket-calls">
      <p
        v-if="error"
        class="text-p-sm text-ink-red-4"
        data-testid="ziwo-ticket-calls-error"
      >
        {{ error }}
      </p>
      <ZiwoCallList
        v-else
        :calls="calls"
        :show-agent="true"
        :show-ticket="false"
        :empty-text="__('No calls are linked to this ticket.')"
      />
    </div>
  </Section>
</template>

<script setup lang="ts">
import { errorMessage } from "@/composables/ziwoCall/logic";
import { useTelephonyStore } from "@/stores/telephony";
import { __ } from "@/translation";
import { TicketSymbol } from "@/types";
import { call } from "frappe-ui";
import { storeToRefs } from "pinia";
import { computed, inject, ref, watch } from "vue";
import Section from "../Section.vue";
import ZiwoCallList, { type HistoryRow } from "../telephony/ZiwoCallList.vue";

const ticket = inject(TicketSymbol)!;
const store = useTelephonyStore();
const { isZiwoConnectorEnabled, ziwoHistoryVersion } = storeToRefs(store);

const opened = ref(true);
const calls = ref<HistoryRow[]>([]);
const error = ref("");
const loaded = ref(false);

// Shown only when a ZIWO connector is on, so a site without ZIWO sees no new section.
const ticketName = computed(
  () => ticket.value?.doc?.name as string | undefined
);
const visible = computed(
  () => isZiwoConnectorEnabled.value && Boolean(ticketName.value)
);

let token = 0;
async function load() {
  const name = ticketName.value;
  if (!name || !isZiwoConnectorEnabled.value) return;
  const mine = ++token;
  try {
    const rows = await call<HistoryRow[]>(
      "inchaa_custmization.integrations.ziwo.api.get_call_history",
      { ticket: String(name), limit: 20 }
    );
    if (mine !== token) return; // a newer ticket or refresh superseded this answer
    calls.value = rows || [];
    error.value = "";
  } catch (e) {
    if (mine !== token) return;
    calls.value = [];
    error.value = errorMessage(e, __("Call history could not be loaded."));
  } finally {
    if (mine === token) loaded.value = true;
  }
}

// Reload on ticket change, when the connector turns on, and after a call or link is saved.
watch(
  () => [
    ticketName.value,
    isZiwoConnectorEnabled.value,
    ziwoHistoryVersion.value,
  ],
  load,
  { immediate: true }
);
</script>
