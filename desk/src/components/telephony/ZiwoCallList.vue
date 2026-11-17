<template>
  <p
    v-if="!rows.length"
    class="py-2 text-p-sm text-ink-gray-5"
    data-testid="ziwo-call-list-empty"
  >
    {{ emptyText }}
  </p>
  <ul
    v-else
    class="divide-y divide-outline-gray-1"
    data-testid="ziwo-call-list"
  >
    <li
      v-for="row in rows"
      :key="row.name"
      class="space-y-0.5 py-2 text-p-sm text-ink-gray-8"
      :data-testid="`ziwo-call-${row.provider_call_id}`"
    >
      <div class="flex items-center justify-between gap-2">
        <span class="font-medium">
          {{ directionLabel(row.direction) }}
          <span class="font-normal text-ink-gray-6">
            {{ row.customer_number_raw || __("Unknown number") }}
          </span>
        </span>
        <span
          class="shrink-0 text-ink-gray-6"
          :data-testid="
            isProviderConfirmed(row) ? 'ziwo-outcome-provider' : 'ziwo-outcome'
          "
        >
          {{ headline(row) }}
        </span>
      </div>
      <div class="flex flex-wrap items-center gap-x-2 text-ink-gray-5">
        <span>{{ when(row) }}</span>
        <span v-if="showAgent && row.agent">{{ row.agent }}</span>
        <router-link
          v-if="showTicket && row.ticket"
          class="underline"
          :to="{ name: 'TicketAgent', params: { ticketId: row.ticket } }"
        >
          {{ __("Ticket") }} #{{ row.ticket }}
        </router-link>
        <span v-if="row.recovered">{{ __("recovered after reconnect") }}</span>
        <!-- Until ZIWO's own record is attributed to this agent, everything here is the browser's. -->
        <span
          v-if="!isProviderConfirmed(row)"
          :title="
            __('Reported by the agent\'s browser. Not confirmed by ZIWO.')
          "
          class="rounded bg-surface-gray-2 px-1"
        >
          {{ __("Observed") }}
        </span>
        <span
          v-if="badge(row).kind !== 'observed'"
          :title="__(badge(row).title)"
          :class="badgeClass(badge(row).kind)"
          class="rounded px-1"
          :data-testid="`ziwo-reconciliation-${badge(row).kind}`"
        >
          {{ __(badge(row).label) }}
        </span>
      </div>
      <!--
        Both accounts of the call, labelled. The browser's is kept as it was; ZIWO's durations
        are separate measurements and none is called billable.
      -->
      <div
        v-if="showEvidence(row)"
        class="space-y-0.5 text-ink-gray-6"
        data-testid="ziwo-call-evidence"
      >
        <p v-if="isProviderConfirmed(row)" data-testid="ziwo-evidence-browser">
          <span class="font-medium">{{ __("Browser saw") }}:</span>
          {{ statusLabel(row) }}
        </p>
        <p
          v-if="durations(row).length"
          class="flex flex-wrap gap-x-3"
          data-testid="ziwo-evidence-durations"
        >
          <span class="font-medium">{{ __("ZIWO") }}:</span>
          <span v-for="line in durations(row)" :key="line.key">
            {{ __(line.label) }} {{ line.value }}
          </span>
        </p>
        <p
          v-if="row.reconciliation_verified_at"
          data-testid="ziwo-evidence-checked"
        >
          {{ __("Last confirmed by ZIWO") }}
          {{ stamp(row.reconciliation_verified_at) }}
        </p>
      </div>
      <div
        v-if="canCheck(row)"
        class="flex flex-wrap items-center gap-2 pt-0.5"
      >
        <Button
          size="sm"
          variant="subtle"
          :loading="Boolean(checking[row.name])"
          :label="__('Check with ZIWO')"
          data-testid="ziwo-check"
          @click="check(row)"
        />
        <span
          v-if="results[row.name]"
          :class="results[row.name].ok ? 'text-ink-gray-6' : 'text-ink-red-6'"
          :role="results[row.name].ok ? 'status' : 'alert'"
          data-testid="ziwo-check-result"
        >
          {{ results[row.name].text }}
        </span>
      </div>
      <!--
        Only a finished call can have a recording. Whether one exists is learned by trying to
        play it; nothing here says a recording exists, or what the call's outcome was.
      -->
      <ZiwoRecordingPlayer v-if="hasEnded(row)" :call="row.name" />
    </li>
  </ul>
</template>

<script setup lang="ts">
import {
  canCheck,
  checkResultText,
  formatDuration,
  isProviderConfirmed,
  providerDurations,
  providerOutcomeLabel,
  reconciliationBadge,
  type BadgeKind,
  type HistoryRow as Row,
} from "@/composables/ziwoCall/history";
import { errorMessage } from "@/composables/ziwoCall/logic";
import { useTelephonyStore } from "@/stores/telephony";
import { __ } from "@/translation";
import { Button, call, dayjs } from "frappe-ui";
import { computed, reactive } from "vue";
import ZiwoRecordingPlayer from "./ZiwoRecordingPlayer.vue";

export type HistoryRow = Row;

const props = withDefaults(
  defineProps<{
    calls: Row[];
    showAgent?: boolean;
    showTicket?: boolean;
    emptyText?: string;
  }>(),
  { showAgent: false, showTicket: true, emptyText: "No calls recorded yet." }
);

const store = useTelephonyStore();
const rows = computed(() => props.calls || []);

// The one manual action. The server decides who may use it and answers in fixed text.
const checking = reactive<Record<string, boolean>>({});
const results = reactive<Record<string, { ok: boolean; text: string }>>({});

async function check(row: Row) {
  if (checking[row.name]) return;
  checking[row.name] = true;
  delete results[row.name];
  try {
    const answer = await call(
      "inchaa_custmization.integrations.ziwo.api.reconcile_call",
      { call: row.name }
    );
    results[row.name] = checkResultText(answer);
    // Lists refresh from the server, which now holds whatever the check found.
    store.bumpZiwoHistory();
  } catch (e) {
    results[row.name] = {
      ok: false,
      text: errorMessage(e, __("The check could not be done.")),
    };
  } finally {
    checking[row.name] = false;
  }
}

function hasEnded(row: Row) {
  return (
    (row.status === "Ended" && !row.not_confirmed_ended) ||
    isProviderConfirmed(row)
  );
}

function directionLabel(direction: string) {
  if (direction === "Inbound") return __("Incoming");
  if (direction === "Outbound") return __("Outgoing");
  return __("Call");
}

function duration(seconds: number) {
  return formatDuration(seconds);
}

// What the agent's own browser reported. This is the only place the observed figure is read.
function statusLabel(row: Row) {
  if (row.not_confirmed_ended) return __("Not confirmed ended");
  if (row.status === "Ringing") return __("Ringing");
  if (row.status === "Active") return __("In progress");
  if (row.status === "Ended") {
    if (row.answered) {
      return row.observed_duration_seconds != null
        ? __("Answered, {0}", [duration(row.observed_duration_seconds)])
        : __("Answered");
    }
    return __("Not answered");
  }
  return __("Unknown");
}

// ZIWO's outcome once it has been attributed to this agent; the browser's word until then.
function headline(row: Row) {
  const outcome = providerOutcomeLabel(row);
  return outcome ? __(outcome) : statusLabel(row);
}

const badge = reconciliationBadge;
const durations = providerDurations;

function showEvidence(row: Row) {
  return isProviderConfirmed(row) || Boolean(row.reconciliation_verified_at);
}

const BADGE_CLASSES: Record<BadgeKind, string> = {
  observed: "bg-surface-gray-2",
  confirmed: "bg-surface-green-2 text-ink-green-3",
  pending: "bg-surface-gray-2",
  conflict: "bg-surface-amber-2 text-ink-amber-3",
  unattributed: "bg-surface-gray-2",
  failed: "bg-surface-red-2 text-ink-red-4",
};

function badgeClass(kind: BadgeKind) {
  return BADGE_CLASSES[kind];
}

function stamp(value?: string | null) {
  return value ? dayjs(value).format("DD MMM, HH:mm") : "";
}

function when(row: Row) {
  const at = row.started_at || row.creation || row.last_event_at;
  return at ? dayjs(at).format("DD MMM, HH:mm") : "";
}
</script>
