<template>
  <!--
    The ZIWO view of the Call Logs page. It lists Inchaa Ziwo Call Log rows, one page at a time,
    counted and paginated by the server. What the agent's browser saw and what ZIWO confirmed are
    shown side by side and labelled, exactly as in the ticket's Calls section; this page adds no
    third source. Recordings play through the same player and authenticated endpoint.
  -->
  <div class="flex min-h-0 flex-1 flex-col" data-testid="ziwo-call-logs">
    <div class="flex flex-wrap items-center gap-2 px-5 pb-3 pt-3">
      <div v-if="canChooseScope" class="w-40">
        <FormControl
          type="select"
          v-model="scope"
          :options="scopeOptions"
          data-testid="ziwo-logs-scope"
        />
      </div>
      <div class="w-40">
        <FormControl
          type="select"
          v-model="direction"
          :options="directionOptions"
          data-testid="ziwo-logs-direction"
        />
      </div>
      <div class="w-56">
        <FormControl
          type="select"
          v-model="reconciliation"
          :options="reconciliationOptions"
          data-testid="ziwo-logs-reconciliation"
        />
      </div>
      <div class="w-56">
        <FormControl
          type="text"
          v-model="searchText"
          :placeholder="__('Search by number or ticket')"
          data-testid="ziwo-logs-search"
        />
      </div>
      <Button
        variant="ghost"
        icon="lucide-refresh-cw"
        :aria-label="__('Reload')"
        :loading="loading"
        data-testid="ziwo-logs-reload"
        @click="load()"
      />
    </div>

    <div class="min-h-0 flex-1 overflow-auto px-5">
      <div
        v-if="error"
        class="flex items-center gap-3 rounded bg-surface-red-2 p-3 text-p-sm text-ink-red-6"
        role="alert"
        data-testid="ziwo-logs-error"
      >
        <span>{{ error }}</span>
        <Button size="sm" :label="__('Retry')" @click="load()" />
      </div>
      <div
        v-else-if="!loadedOnce"
        class="flex items-center justify-center py-16"
        data-testid="ziwo-logs-loading"
      >
        <LoadingIndicator class="size-6 text-ink-gray-4" />
      </div>
      <p
        v-else-if="!rows.length"
        class="py-16 text-center text-p-sm text-ink-gray-5"
        data-testid="ziwo-logs-empty"
      >
        {{ filtered ? __("No calls match these filters.") : emptyText }}
      </p>
      <table
        v-else
        class="w-full min-w-[980px] border-collapse text-start text-p-sm text-ink-gray-8"
        data-testid="ziwo-logs-table"
      >
        <thead>
          <tr class="border-b border-outline-gray-2 text-ink-gray-6">
            <th scope="col" class="py-2 pe-3 text-start font-medium">
              {{ __("Time") }}
            </th>
            <th scope="col" class="py-2 pe-3 text-start font-medium">
              {{ __("Direction") }}
            </th>
            <th scope="col" class="py-2 pe-3 text-start font-medium">
              {{ __("Number / contact") }}
            </th>
            <th
              v-if="scope === 'all'"
              scope="col"
              class="py-2 pe-3 text-start font-medium"
            >
              {{ __("Agent") }}
            </th>
            <th scope="col" class="py-2 pe-3 text-start font-medium">
              {{ __("Outcome") }}
            </th>
            <th scope="col" class="py-2 pe-3 text-start font-medium">
              {{ __("Durations") }}
            </th>
            <th scope="col" class="py-2 pe-3 text-start font-medium">
              {{ __("Ticket") }}
            </th>
            <th scope="col" class="py-2 pe-3 text-start font-medium">
              {{ __("Reconciliation") }}
            </th>
            <th scope="col" class="py-2 text-start font-medium">
              {{ __("Recording") }}
            </th>
          </tr>
        </thead>
        <tbody>
          <tr
            v-for="row in rows"
            :key="row.name"
            class="border-b border-outline-gray-1 align-top"
            :data-testid="`ziwo-log-${row.provider_call_id}`"
          >
            <td class="whitespace-nowrap py-2 pe-3" data-testid="ziwo-log-time">
              {{ when(row) }}
            </td>
            <td
              class="whitespace-nowrap py-2 pe-3"
              data-testid="ziwo-log-direction"
            >
              <span class="inline-flex items-center gap-1.5">
                <LucidePhoneIncoming
                  v-if="row.direction === 'Inbound'"
                  class="size-3.5 shrink-0 text-ink-gray-6"
                />
                <LucidePhoneOutgoing
                  v-else-if="row.direction === 'Outbound'"
                  class="size-3.5 shrink-0 text-ink-gray-6"
                />
                <LucidePhone v-else class="size-3.5 shrink-0 text-ink-gray-6" />
                {{ directionLabel(row.direction) }}
              </span>
            </td>
            <td class="py-2 pe-3" data-testid="ziwo-log-party">
              <div v-if="row.contact_label" class="font-medium text-ink-gray-9">
                {{ row.contact_label }}
              </div>
              <div :class="row.contact_label ? 'text-ink-gray-6' : ''">
                {{ row.customer_number_raw || __("Unknown number") }}
              </div>
            </td>
            <td
              v-if="scope === 'all'"
              class="py-2 pe-3"
              data-testid="ziwo-log-agent"
            >
              {{ row.agent_name || row.agent }}
            </td>
            <td class="py-2 pe-3">
              <div
                :data-testid="
                  isProviderConfirmed(row)
                    ? 'ziwo-log-outcome-provider'
                    : 'ziwo-log-outcome'
                "
              >
                {{ headline(row) }}
              </div>
              <!-- Until ZIWO's own record is attributed to this agent, the outcome is the browser's. -->
              <span
                v-if="!isProviderConfirmed(row)"
                :title="
                  __('Reported by the agent\'s browser. Not confirmed by ZIWO.')
                "
                class="mt-0.5 inline-block rounded bg-surface-gray-2 px-1 text-ink-gray-6"
              >
                {{ __("Observed") }}
              </span>
            </td>
            <td
              class="py-2 pe-3 text-ink-gray-6"
              data-testid="ziwo-log-durations"
            >
              <template v-if="durations(row).length">
                <div class="flex flex-wrap gap-x-2">
                  <span class="font-medium">{{ __("ZIWO") }}:</span>
                  <span v-for="line in durations(row)" :key="line.key">
                    {{ __(line.label) }} {{ line.value }}
                  </span>
                </div>
                <div
                  v-if="browserDuration(row)"
                  data-testid="ziwo-log-browser-duration"
                >
                  {{ __("Browser") }}: {{ browserDuration(row) }}
                </div>
              </template>
              <template v-else>
                <span
                  v-if="browserDuration(row)"
                  data-testid="ziwo-log-browser-duration"
                >
                  {{ __("Browser") }}: {{ browserDuration(row) }}
                </span>
                <span v-else>—</span>
              </template>
            </td>
            <td class="py-2 pe-3" data-testid="ziwo-log-ticket">
              <router-link
                v-if="row.ticket"
                class="underline"
                :to="{ name: 'TicketAgent', params: { ticketId: row.ticket } }"
              >
                #{{ row.ticket }}
              </router-link>
              <span v-else class="text-ink-gray-5">—</span>
            </td>
            <td class="py-2 pe-3">
              <span
                :title="__(badge(row).title)"
                :class="badgeClass(badge(row).kind)"
                class="inline-block rounded px-1"
                :data-testid="`ziwo-log-reconciliation-${badge(row).kind}`"
              >
                {{ __(badge(row).label) }}
              </span>
              <div
                v-if="row.reconciliation_verified_at"
                class="mt-0.5 text-ink-gray-5"
              >
                {{ __("Last confirmed by ZIWO") }}
                {{ stamp(row.reconciliation_verified_at) }}
              </div>
            </td>
            <td class="py-1.5" data-testid="ziwo-log-recording">
              <!--
                Only a finished call can have a recording. Whether one exists is learned by
                trying to play it; nothing here says a recording exists.
              -->
              <ZiwoRecordingPlayer v-if="hasEnded(row)" :call="row.name" />
              <span v-else class="text-ink-gray-5">—</span>
            </td>
          </tr>
        </tbody>
      </table>
    </div>

    <div
      v-if="loadedOnce && !error && total"
      class="flex flex-wrap items-center justify-between gap-3 border-t px-5 py-2 text-p-sm text-ink-gray-7"
      data-testid="ziwo-logs-footer"
    >
      <div class="flex items-center gap-2">
        <span>{{ __("Rows per page") }}</span>
        <TabButtons
          :model-value="pageSize"
          :options="
            PAGE_SIZES.map((size) => ({ label: String(size), value: size }))
          "
          @update:model-value="(size) => (pageSize = Number(size))"
        />
      </div>
      <div class="flex items-center gap-3">
        <span data-testid="ziwo-logs-range">
          {{ __("{0}–{1} of {2}", [summary.from, summary.to, summary.total]) }}
        </span>
        <Button
          size="sm"
          :label="__('Previous')"
          :disabled="page <= 1 || loading"
          data-testid="ziwo-logs-prev"
          @click="page -= 1"
        />
        <Button
          size="sm"
          :label="__('Next')"
          :disabled="page >= pages || loading"
          data-testid="ziwo-logs-next"
          @click="page += 1"
        />
      </div>
    </div>
  </div>
</template>

<script setup lang="ts">
import {
  PAGE_SIZES,
  callTime,
  hasEnded,
  isProviderConfirmed,
  observedStatus,
  formatDuration,
  pageSummary,
  providerDurations,
  providerOutcomeLabel,
  reconciliationBadge,
  showsAsMissed,
  type BadgeKind,
  type CallLogPage,
  type HistoryRow,
} from "@/composables/ziwoCall/history";
import { errorMessage } from "@/composables/ziwoCall/logic";
import { useTelephonyStore } from "@/stores/telephony";
import { __ } from "@/translation";
import { useDebounceFn, useIntervalFn } from "@vueuse/core";
import {
  Button,
  FormControl,
  LoadingIndicator,
  TabButtons,
  call,
  dayjs,
} from "frappe-ui";
import { storeToRefs } from "pinia";
import { computed, onBeforeUnmount, ref, watch } from "vue";
import LucidePhone from "~icons/lucide/phone";
import LucidePhoneIncoming from "~icons/lucide/phone-incoming";
import LucidePhoneOutgoing from "~icons/lucide/phone-outgoing";
import ZiwoRecordingPlayer from "@/components/telephony/ZiwoRecordingPlayer.vue";

const API = "inchaa_custmization.integrations.ziwo.api.";
/** How often a page with unsettled recent calls asks again, while it is in view. */
const REFRESH_MS = 30000;
/** A call newer than this can still be waiting for ZIWO's record. */
const RECENT_MS = 2 * 60 * 60 * 1000;

const store = useTelephonyStore();
const { isZiwoEnabled, ziwoCanViewAllCalls, ziwoHistoryVersion } =
  storeToRefs(store);

// Managers who are also permitted agents can switch between their own calls and everyone's. A
// manager who is not an agent has no calls of their own, so everyone's is all there is.
const canChooseScope = computed(
  () => isZiwoEnabled.value && ziwoCanViewAllCalls.value
);
const scope = ref<"mine" | "all">(isZiwoEnabled.value ? "mine" : "all");
const scopeOptions = computed(() => [
  { label: __("My calls"), value: "mine" },
  { label: __("All agents"), value: "all" },
]);

const direction = ref("");
const reconciliation = ref("");
const searchText = ref("");
const appliedSearch = ref("");
const page = ref(1);
const pageSize = ref<number>(PAGE_SIZES[0]);

const rows = ref<HistoryRow[]>([]);
const total = ref(0);
const pages = ref(1);
// The page and size the rows on screen belong to. The footer describes these, never the page the
// agent has just asked for, so "21–40 of 31" cannot show while the old rows are still there.
const shownPage = ref(1);
const shownPageSize = ref<number>(PAGE_SIZES[0]);
const loading = ref(false);
const loadedOnce = ref(false);
const error = ref("");

const directionOptions = computed(() => [
  { label: __("All directions"), value: "" },
  { label: __("Incoming"), value: "Inbound" },
  { label: __("Outgoing"), value: "Outbound" },
  { label: __("Missed"), value: "missed" },
]);
const reconciliationOptions = computed(() => [
  { label: __("Any reconciliation status"), value: "" },
  { label: __("Confirmed by ZIWO"), value: "Verified" },
  { label: __("Waiting for ZIWO"), value: "Pending" },
  { label: __("ZIWO record differs"), value: "Conflict" },
  { label: __("Not tied to this agent"), value: "Unattributed" },
  { label: __("ZIWO check failed"), value: "Failed" },
  { label: __("Observed only"), value: "Not Checked" },
]);

const filtered = computed(() =>
  Boolean(direction.value || reconciliation.value || appliedSearch.value)
);
const emptyText = computed(() =>
  scope.value === "all"
    ? __("No ZIWO calls have been recorded yet.")
    : __("You have no ZIWO calls yet.")
);
const summary = computed(() =>
  pageSummary(
    total.value,
    shownPage.value,
    shownPageSize.value,
    rows.value.length
  )
);

// --- loading -------------------------------------------------------------------------------

let token = 0;
async function load(silent = false) {
  const mine = ++token;
  if (!silent) loading.value = true;
  try {
    const answer = await call<CallLogPage>(`${API}get_call_log_page`, {
      page: page.value,
      page_size: pageSize.value,
      scope: scope.value,
      // "Missed" is an outcome filter on the server; it already means incoming.
      direction:
        direction.value && direction.value !== "missed"
          ? direction.value
          : undefined,
      outcome: direction.value === "missed" ? "missed" : undefined,
      reconciliation: reconciliation.value || undefined,
      search: appliedSearch.value || undefined,
    });
    if (mine !== token) return; // a newer request superseded this answer
    rows.value = answer.rows || [];
    total.value = answer.total || 0;
    pages.value = answer.pages || 1;
    shownPage.value = answer.page || 1;
    shownPageSize.value = answer.page_size || pageSize.value;
    error.value = "";
    // Rows were removed or filtered while the agent was on a later page: go to the last one.
    if (page.value > pages.value && total.value) page.value = pages.value;
  } catch (e) {
    if (mine !== token) return;
    error.value = errorMessage(e, __("Call logs could not be loaded."));
  } finally {
    if (mine === token) {
      loading.value = false;
      loadedOnce.value = true;
    }
  }
}

// Any change to what is asked for starts again from the first page. Declared before the loader
// so that one flush resets the page first, and the loader then runs once with the new values.
watch([pageSize, direction, reconciliation, scope, appliedSearch], () => {
  page.value = 1;
});
watch(
  [page, pageSize, direction, reconciliation, scope, appliedSearch],
  () => void load(),
  { immediate: true }
);

const applySearch = useDebounceFn((value: string) => {
  appliedSearch.value = value.trim();
}, 400);
watch(searchText, (value) => applySearch(value));

// A call or a link was just saved, or a check was run: the list is stale. Several saves in a
// row (the events of one call) become one reload.
const reloadSoon = useDebounceFn(() => void load(true), 600);
watch(ziwoHistoryVersion, () => reloadSoon());

// ZIWO's record of a call arrives some time after the call, and nothing tells this page. While
// the page shows a recent call that is still unsettled, ask again now and then.
const unsettled = computed(() =>
  rows.value.some((row) => {
    if (row.status !== "Ended") return !row.not_confirmed_ended;
    const settled =
      isProviderConfirmed(row) || row.reconciliation_status === "Failed";
    const at = callTime(row);
    return (
      !settled && Boolean(at) && Date.now() - dayjs(at).valueOf() < RECENT_MS
    );
  })
);
const { pause, resume } = useIntervalFn(
  () => {
    if (!document.hidden && !loading.value) void load(true);
  },
  REFRESH_MS,
  { immediate: false }
);
watch(unsettled, (value) => (value ? resume() : pause()), { immediate: true });
onBeforeUnmount(() => {
  token += 1; // a late answer must not touch a page that is gone
  pause();
});

// --- cells -----------------------------------------------------------------------------------

const badge = reconciliationBadge;
const durations = providerDurations;

function when(row: HistoryRow) {
  const at = callTime(row);
  return at ? dayjs(at).format("DD MMM YYYY, HH:mm") : "";
}

function stamp(value?: string | null) {
  return value ? dayjs(value).format("DD MMM, HH:mm") : "";
}

function directionLabel(value: string) {
  if (value === "Inbound") return __("Incoming");
  if (value === "Outbound") return __("Outgoing");
  return __("Call");
}

// ZIWO's outcome once it has been attributed to this agent; the browser's word until then.
function headline(row: HistoryRow) {
  if (showsAsMissed(row)) return __("Missed");
  const outcome = providerOutcomeLabel(row);
  if (outcome) return __(outcome);
  const seen = observedStatus(row);
  switch (seen.key) {
    case "not-confirmed-ended":
      return __("Not confirmed ended");
    case "ringing":
      return __("Ringing");
    case "active":
      return __("In progress");
    case "answered":
      return seen.seconds != null
        ? __("Answered, {0}", [formatDuration(seen.seconds)])
        : __("Answered");
    case "not-answered":
      return __("Not answered");
    default:
      return __("Unknown");
  }
}

// The browser's own measurement, kept as it was and always named as the browser's.
function browserDuration(row: HistoryRow) {
  return row.answered ? formatDuration(row.observed_duration_seconds) : "";
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
</script>
