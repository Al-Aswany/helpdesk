<template>
  <Section
    v-if="panel && panel.kind !== 'none'"
    :label="__('Inchaa')"
    v-model:opened="opened"
  >
    <div class="space-y-3 pb-3 pt-0.5 text-p-sm text-ink-gray-8" data-testid="inchaa-admin-task">
      <template v-if="panel.kind === 'customer'">
        <p v-if="panel.referenceNumber">
          {{ __("Reference {0}", [panel.referenceNumber]) }}
        </p>
        <p>
          {{ __("Inchaa status: {0}", [panel.externalStatus || __("unknown")]) }}
        </p>
        <p v-if="panel.assignedToName">
          {{ __("Assigned in Inchaa: {0}", [panel.assignedToName]) }}
        </p>
        <p
          v-if="panel.stateConflict"
          class="text-ink-amber-8"
          role="status"
        >
          {{ __("Inchaa reported a status conflict. Review before closing this ticket.") }}
        </p>
        <Button
          v-if="panel.wontResolveEnabled"
          size="sm"
          :label="__('Mark Won’t Resolve in Inchaa')"
          :disabled="busy"
          data-testid="inchaa-wont-resolve"
          @click="markWontResolve"
        />
      </template>

      <template v-else-if="panel.kind === 'admin_task'">
        <p>{{ __("Admin task {0}", [panel.referenceNumber || panel.id || panel.state]) }}</p>
        <p>{{ __("Status: {0}", [panel.status || panel.state]) }}</p>
        <p v-if="panel.assignedToName">
          {{ __("Assignee: {0}", [panel.assignedToName]) }}
        </p>
        <p v-if="panel.externalPriority">
          {{ __("Priority: {0}", [panel.externalPriority]) }}
        </p>
        <p v-if="panel.error" class="text-ink-red-6" role="alert">
          {{ panel.error }}
        </p>
        <ul v-if="panel.activities?.length" class="space-y-1 text-ink-gray-6">
          <li v-for="item in panel.activities" :key="item.id">
            {{ item.type }} · {{ item.content }}
          </li>
        </ul>
        <Button
          size="sm"
          :label="__('Refresh from Inchaa')"
          :disabled="busy"
          data-testid="inchaa-admin-refresh"
          @click="refreshTask"
        />
      </template>

      <form
        v-else-if="panel.kind === 'create' && panel.canCreate"
        class="space-y-2"
        data-testid="inchaa-admin-create"
        @submit.prevent="createTask"
      >
        <label class="block">
          {{ __("Category") }}
          <select
            v-model="form.category"
            class="mt-1 w-full rounded border border-outline-gray-2 bg-surface-white px-2 py-1"
          >
            <option v-for="item in panel.categories" :key="item" :value="item">
              {{ item }}
            </option>
          </select>
        </label>
        <label class="block">
          {{ __("Priority") }}
          <select
            v-model="form.priority"
            class="mt-1 w-full rounded border border-outline-gray-2 bg-surface-white px-2 py-1"
          >
            <option v-for="item in panel.priorities" :key="item" :value="item">
              {{ item }}
            </option>
          </select>
        </label>
        <label class="block">
          {{ __("Description") }}
          <textarea
            v-model="form.description"
            rows="3"
            class="mt-1 w-full rounded border border-outline-gray-2 px-2 py-1"
          />
        </label>
        <Button
          variant="solid"
          size="sm"
          :label="__('Create Inchaa admin task')"
          :disabled="busy || !form.description.trim()"
          data-testid="inchaa-admin-submit"
          @click="createTask"
        />
      </form>
      <p v-if="error" class="text-ink-red-6" role="alert">{{ error }}</p>
    </div>
  </Section>
</template>

<script setup lang="ts">
import { __ } from "@/translation";
import { TicketSymbol } from "@/types";
import { Button, call } from "frappe-ui";
import { computed, inject, reactive, ref, watch } from "vue";
import Section from "../Section.vue";

interface Activity {
  id: string;
  type: string;
  content: string;
}

interface Panel {
  kind: "customer" | "admin_task" | "create" | "none";
  referenceNumber?: string | null;
  id?: string | null;
  state?: string | null;
  status?: string | null;
  externalStatus?: string | null;
  externalPriority?: string | null;
  assignedToName?: string | null;
  stateConflict?: number;
  wontResolveEnabled?: boolean;
  canCreate?: boolean;
  error?: string | null;
  categories?: string[];
  priorities?: string[];
  defaultPriority?: string;
  activities?: Activity[];
}

const ticket = inject(TicketSymbol)!;
const panel = ref<Panel | null>(null);
const busy = ref(false);
const error = ref("");
const opened = ref(true);
const form = reactive({
  category: "Incident",
  priority: "Normal",
  description: "",
});

const ticketName = computed(() => ticket.value?.doc?.name as string | undefined);

async function load() {
  const name = ticketName.value;
  if (!name) return;
  try {
    const data = (await call(
      "inchaa_custmization.integrations.inchaa_platform.api.get_ticket_panel",
      { ticket: name }
    )) as Panel;
    panel.value = data;
    if (data.defaultPriority) form.priority = data.defaultPriority;
    if (data.categories?.length && !data.categories.includes(form.category)) {
      form.category = data.categories[0] || "Incident";
    }
  } catch {
    panel.value = null;
  }
}

watch(ticketName, load, { immediate: true });

async function createTask() {
  const name = ticketName.value;
  if (!name || !form.description.trim()) return;
  busy.value = true;
  error.value = "";
  try {
    await call(
      "inchaa_custmization.integrations.inchaa_platform.api.create_admin_task",
      {
        ticket: name,
        subject: ticket.value?.doc?.subject || name,
        category: form.category,
        priority: form.priority,
        description: form.description,
      }
    );
    await load();
  } catch (exc: unknown) {
    error.value = exc instanceof Error ? exc.message : String(exc);
  } finally {
    busy.value = false;
  }
}

async function refreshTask() {
  const name = ticketName.value;
  if (!name) return;
  busy.value = true;
  error.value = "";
  try {
    await call(
      "inchaa_custmization.integrations.inchaa_platform.api.refresh_admin_task",
      { ticket: name }
    );
    await load();
  } catch (exc: unknown) {
    error.value = exc instanceof Error ? exc.message : String(exc);
  } finally {
    busy.value = false;
  }
}

async function markWontResolve() {
  const name = ticketName.value;
  if (!name) return;
  busy.value = true;
  error.value = "";
  try {
    await call(
      "inchaa_custmization.integrations.inchaa_platform.api.mark_wont_resolve",
      { ticket: name }
    );
    await load();
  } catch (exc: unknown) {
    error.value = exc instanceof Error ? exc.message : String(exc);
  } finally {
    busy.value = false;
  }
}
</script>
