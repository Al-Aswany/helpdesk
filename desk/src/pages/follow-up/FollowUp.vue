<template>
  <div class="flex h-full min-h-0 flex-col">
    <LayoutHeader>
      <template #left-header>
        <h1 class="text-lg-medium text-ink-gray-9">{{ __("Follow-up") }}</h1>
      </template>
      <template #right-header>
        <Button
          variant="solid"
          icon-left="lucide-plus"
          :label="__('Schedule callback')"
          :disabled="!queue.data || queue.loading"
          @click="openCreate()"
        />
      </template>
    </LayoutHeader>

    <div
      class="flex flex-wrap items-center justify-between gap-3 border-b border-outline-gray-2 px-4 py-3 sm:px-5"
    >
      <TabButtons
        :model-value="view"
        :options="tabs"
        @update:model-value="changeView"
      />
      <Button
        icon="lucide-refresh-cw"
        :aria-label="__('Refresh queue')"
        :loading="queue.loading"
        @click="load()"
      />
    </div>

    <div
      class="min-h-0 flex-1 overflow-auto px-4 sm:px-5"
      :aria-busy="queue.loading"
    >
      <p
        v-if="queue.loading"
        role="status"
        class="py-6 text-base text-ink-gray-6"
      >
        {{ __("Loading follow-up queue…") }}
      </p>
      <p
        v-else-if="queue.error"
        role="alert"
        class="py-6 text-base text-ink-gray-7"
      >
        {{
          queue.error.messages?.[0] || __("Could not load the follow-up queue.")
        }}
      </p>
      <p
        v-else-if="!queue.data?.rows.length"
        class="py-6 text-base text-ink-gray-6"
      >
        {{ emptyMessage }}
      </p>
      <table v-else class="w-full min-w-[36rem] text-left text-base">
        <thead
          class="sticky top-0 border-b border-outline-gray-2 bg-surface-white text-ink-gray-7"
        >
          <tr v-if="view === 'unassigned'">
            <th class="py-3 pe-4 font-medium" scope="col">
              {{ __("Ticket") }}
            </th>
            <th class="py-3 pe-4 font-medium" scope="col">{{ __("Team") }}</th>
            <th class="py-3 pe-4 font-medium" scope="col">
              {{ __("Status") }}
            </th>
            <th class="py-3 pe-4 font-medium" scope="col">
              {{ __("First response due") }}
            </th>
            <th class="py-3 font-medium" scope="col">{{ __("Created") }}</th>
          </tr>
          <tr v-else>
            <th class="py-3 pe-4 font-medium" scope="col">
              {{ __("Callback") }}
            </th>
            <th class="py-3 pe-4 font-medium" scope="col">
              {{ __("Assigned agent") }}
            </th>
            <th class="py-3 pe-4 font-medium" scope="col">
              {{ __("Due at") }}
            </th>
            <th class="py-3 pe-4 font-medium" scope="col">
              {{ __("Outcome") }}
            </th>
            <th v-if="view === 'pending'" class="py-3 font-medium" scope="col">
              {{ __("Actions") }}
            </th>
          </tr>
        </thead>
        <tbody v-if="view === 'unassigned'">
          <tr
            v-for="row in ticketRows"
            :key="row.name"
            class="border-b border-outline-gray-1 align-top"
          >
            <td class="max-w-96 py-3 pe-4">
              <RouterLink
                :to="ticketRoute(row.name)"
                class="font-medium text-ink-gray-9 underline"
              >
                #{{ row.name }} <span dir="auto">{{ row.subject }}</span>
              </RouterLink>
              <div class="mt-1 text-ink-gray-6">{{ __(row.priority) }}</div>
            </td>
            <td class="py-3 pe-4">{{ row.agent_group || "—" }}</td>
            <td class="py-3 pe-4">{{ __(row.status) }}</td>
            <td class="py-3 pe-4">
              {{
                !row.first_responded_on && row.response_by
                  ? formatTime(row.response_by)
                  : "—"
              }}
            </td>
            <td class="py-3">{{ formatTime(row.creation) }}</td>
          </tr>
        </tbody>
        <tbody v-else>
          <tr
            v-for="row in callbackRows"
            :key="row.name"
            class="border-b border-outline-gray-1 align-top"
          >
            <td class="max-w-96 py-3 pe-4">
              <bdi class="font-medium text-ink-gray-9">{{ row.phone }}</bdi>
              <p dir="auto" class="mt-1 whitespace-pre-wrap break-words">
                {{ row.summary }}
              </p>
              <RouterLink
                v-if="row.ticket"
                :to="ticketRoute(row.ticket)"
                class="mt-1 inline-block text-ink-gray-7 underline"
              >
                {{ __("Ticket #{0}", [row.ticket]) }}
              </RouterLink>
            </td>
            <td class="py-3 pe-4">
              {{
                row.assigned_agent
                  ? users.getUser(row.assigned_agent).full_name
                  : __("Unassigned")
              }}
            </td>
            <td class="whitespace-nowrap py-3 pe-4">
              {{ formatTime(row.due_at) }}
              <div
                v-if="
                  view === 'pending' &&
                  dayjs(row.due_at).isBefore(dayjs(queue.data.now))
                "
                class="mt-1 font-medium"
              >
                {{ __("Overdue") }}
              </div>
            </td>
            <td class="max-w-64 py-3 pe-4">
              {{ row.outcome ? __(row.outcome) : __("Pending") }}
              <p
                v-if="row.result_note"
                dir="auto"
                class="mt-1 whitespace-pre-wrap break-words text-ink-gray-6"
              >
                {{ row.result_note }}
              </p>
            </td>
            <td v-if="view === 'pending'" class="py-3">
              <div class="flex flex-wrap gap-1">
                <Button
                  v-if="!row.assigned_agent"
                  :label="__('Claim')"
                  @click="openAction('claim', row)"
                />
                <Button
                  v-if="canManage"
                  :label="__('Assign')"
                  @click="openAction('assign', row)"
                />
                <template
                  v-if="
                    row.assigned_agent &&
                    (canManage ||
                      queue.data.current_user === row.assigned_agent)
                  "
                >
                  <Button
                    :label="__('Reschedule')"
                    @click="openAction('reschedule', row)"
                  />
                  <Button
                    :label="__('Record outcome')"
                    @click="openAction('complete', row)"
                  />
                </template>
              </div>
            </td>
          </tr>
        </tbody>
      </table>
    </div>

    <footer
      class="flex flex-wrap items-center justify-between gap-3 border-t border-outline-gray-2 px-4 py-2 text-base text-ink-gray-6 sm:px-5"
    >
      <span v-if="queue.data?.site_timezone">{{
        __("Times in {0}", [queue.data.site_timezone])
      }}</span>
      <div class="ms-auto flex gap-2">
        <Button
          :label="__('Previous')"
          :disabled="queue.loading || !start"
          @click="move(-1)"
        />
        <Button
          :label="__('Next')"
          :disabled="queue.loading || !queue.data?.has_more"
          @click="move(1)"
        />
      </div>
    </footer>
  </div>

  <Dialog v-model:open="dialogOpen" :title="dialogTitle">
      <form class="space-y-3" @submit.prevent="save">
        <template v-if="action === 'create'">
          <FormControl
            v-model="form.phone"
            type="tel"
            :label="__('Phone with country code')"
            required
          />
          <FormControl
            v-model="form.summary"
            type="textarea"
            :label="__('Reason')"
            maxlength="1000"
            required
          />
          <FormControl
            v-model="form.ticket"
            type="text"
            :label="__('Ticket ID (optional)')"
          />
          <FormControl
            v-model="form.source_reference"
            type="text"
            :label="__('ZIWO call reference (optional)')"
            maxlength="140"
          />
        </template>
        <p v-else-if="selected" class="text-base text-ink-gray-7">
          <bdi>{{ selected.phone }}</bdi>
          <span v-if="selected.ticket" class="ms-2">{{
            __("Ticket #{0}", [selected.ticket])
          }}</span>
        </p>
        <template
          v-if="(action === 'create' && canManage) || action === 'assign'"
        >
          <FormControl
            v-model="form.assigned_agent"
            type="select"
            :label="__('Assigned agent')"
            :options="assigneeOptions"
            :disabled="agents.loading"
          />
          <p v-if="agents.error" role="alert" class="text-sm text-ink-gray-7">
            {{ __("Could not load active agents.") }}
          </p>
        </template>
        <label
          v-if="action === 'create' || action === 'reschedule'"
          class="block text-sm text-ink-gray-7"
        >
          {{ __("Due at ({0})", [queue.data?.site_timezone || ""]) }}
          <input
            v-model="form.due_at"
            type="datetime-local"
            required
            class="mt-1 block w-full rounded border border-outline-gray-2 bg-surface-gray-2 px-2 py-1.5 text-base text-ink-gray-9"
          />
        </label>
        <FormControl
          v-if="action === 'complete'"
          v-model="form.outcome"
          type="select"
          :label="__('Outcome')"
          :options="outcomes"
          required
        />
        <FormControl
          v-if="action === 'complete' || action === 'reschedule'"
          v-model="form.note"
          type="textarea"
          :label="__('Result note (optional)')"
          maxlength="1000"
        />
        <p v-if="error" role="alert" class="text-base text-ink-gray-8">
          {{ error }}
        </p>
        <div class="flex justify-end gap-2">
          <Button
            :label="__('Cancel')"
            :disabled="saving"
            @click="dialogOpen = false"
          />
          <Button
            type="submit"
            variant="solid"
            :label="dialogTitle"
            :loading="saving"
          />
        </div>
      </form>
  </Dialog>
</template>

<script setup lang="ts">
import LayoutHeader from "@/components/LayoutHeader.vue";
import { useUserStore } from "@/stores/user";
import { __ } from "@/translation";
import dayjs from "dayjs";
import {
  Button,
  createResource,
  Dialog,
  FormControl,
  TabButtons,
  toast,
  usePageMeta,
} from "frappe-ui";
import { computed, ref, watch } from "vue";
import { useRoute, useRouter } from "vue-router";

type View = "pending" | "completed" | "unassigned";
type Action = "create" | "claim" | "assign" | "reschedule" | "complete";
interface CallbackRow {
  name: string;
  phone: string;
  summary: string;
  ticket?: string;
  assigned_agent?: string;
  due_at: string;
  modified: string;
  outcome?: string;
  result_note?: string;
}
interface TicketRow {
  name: string;
  subject: string;
  priority: string;
  agent_group?: string;
  status: string;
  creation: string;
  first_responded_on?: string;
  response_by?: string;
}
interface QueuePage {
  rows: (CallbackRow | TicketRow)[];
  has_more: boolean;
  page_size: number;
  site_timezone: string;
  now: string;
  can_manage: boolean;
  current_user: string;
}

const route = useRoute();
const router = useRouter();
const users = useUserStore();
const view = ref<View>("pending");
const start = ref(0);
const queue = createResource({
  url: "helpdesk.api.follow_up.get_queue",
  method: "GET",
  initialData: null as QueuePage | null,
});
const agents = createResource({
  url: "helpdesk.api.follow_up.get_callback_agents",
  method: "GET",
});
const create = createResource({
  url: "helpdesk.api.follow_up.create_callback",
});
const update = createResource({
  url: "helpdesk.api.follow_up.update_callback",
});
const canManage = computed(() => Boolean(queue.data?.can_manage));
const ticketRows = computed(() => (queue.data?.rows || []) as TicketRow[]);
const callbackRows = computed(() => (queue.data?.rows || []) as CallbackRow[]);
const emptyMessage = computed(
  () =>
    ({
      pending: __("No pending callbacks."),
      completed: __("No completed callbacks."),
      unassigned: __("No unresolved tickets without an assignment."),
    }[view.value])
);
const tabs = [
  { label: __("Callbacks"), value: "pending" },
  { label: __("Completed"), value: "completed" },
  { label: __("Unassigned tickets"), value: "unassigned" },
];

const dialogOpen = ref(false);
const action = ref<Action>("create");
const selected = ref<CallbackRow | null>(null);
const requestId = ref("");
const error = ref("");
const saving = computed(() => create.loading || update.loading);
const blankForm = () => ({
  phone: "",
  ticket: "",
  summary: "",
  source_reference: "",
  due_at: "",
  assigned_agent: queue.data?.current_user || "",
  outcome: "",
  note: "",
});
const form = ref(blankForm());
const assigneeOptions = computed(() => [
  { label: __("Unassigned"), value: "" },
  { label: __("Me"), value: queue.data?.current_user || "" },
  ...(agents.data || [])
    .filter((agent) => agent.name !== queue.data?.current_user)
    .map((agent) => ({ label: agent.label, value: agent.name })),
]);
const outcomes = ["", "Reached", "No answer", "Cancelled"].map((value) => ({
  value,
  label: value ? __(value) : __("Choose an outcome"),
}));
const dialogTitle = computed(
  () =>
    ({
      create: __("Schedule callback"),
      claim: __("Claim callback"),
      assign: __("Assign callback"),
      reschedule: __("Reschedule callback"),
      complete: __("Record outcome"),
    }[action.value])
);

function ticketRoute(ticketId: string) {
  return { name: "TicketAgent", params: { ticketId } };
}

function formatTime(value: string) {
  return dayjs(value).format("DD MMM YYYY, HH:mm");
}

async function load() {
  if (queue.loading) return;
  try {
    const result = await queue.fetch({ view: view.value, start: start.value });
    if (start.value && !result.rows.length) {
      start.value -= result.page_size;
      await queue.fetch({ view: view.value, start: start.value });
    }
  } catch {
    // The resource renders the server's error above the table.
  }
}

function changeView(next: View) {
  if (queue.loading || view.value === next) return;
  view.value = next;
  start.value = 0;
  void load();
}

function move(direction: number) {
  start.value += direction * queue.data.page_size;
  void load();
}

function openCreate(ticket = "") {
  error.value = "";
  action.value = "create";
  requestId.value = crypto.randomUUID();
  selected.value = null;
  form.value = { ...blankForm(), ticket };
  dialogOpen.value = true;
  loadAgents();
}

function openAction(next: Exclude<Action, "create">, row: CallbackRow) {
  error.value = "";
  action.value = next;
  selected.value = row;
  form.value = { ...blankForm(), note: row.result_note || "" };
  if (next === "assign") {
    form.value.assigned_agent = row.assigned_agent || "";
    loadAgents();
  }
  dialogOpen.value = true;
}

function loadAgents() {
  if (canManage.value && !agents.fetched && !agents.loading) {
    void agents.fetch().catch(() => {});
  }
}

async function save() {
  if (saving.value) return;
  error.value = "";
  try {
    const {
      phone,
      due_at,
      summary,
      ticket,
      assigned_agent,
      source_reference,
      outcome,
      note,
    } = form.value;
    if (action.value === "create") {
      await create.submit({
        request_id: requestId.value,
        phone,
        due_at,
        summary,
        ticket,
        assigned_agent,
        source_reference,
      });
    } else if (selected.value) {
      const { name, modified } = selected.value;
      await update.submit({
        name,
        modified,
        action: action.value,
        assigned_agent,
        due_at,
        outcome,
        note,
      });
    }
  } catch (e) {
    error.value = e?.messages?.[0] || __("Could not save the callback.");
    return;
  }

  dialogOpen.value = false;
  toast.success(
    action.value === "create"
      ? __("Callback scheduled")
      : __("Callback updated")
  );
  if (action.value === "create") {
    view.value = "pending";
    start.value = 0;
  }
  await load();
}

watch(
  () => [route.query.ticket, queue.data?.current_user],
  ([ticket, user]) => {
    if (typeof ticket !== "string" || !ticket || !user) return;
    openCreate(ticket);
    const query = { ...route.query };
    delete query.ticket;
    void router.replace({ query });
  }
);
void load();
usePageMeta(() => ({ title: __("Follow-up") }));
</script>
