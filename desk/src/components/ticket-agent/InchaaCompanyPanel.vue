<template>
  <Section
    v-if="visible"
    :label="__('Inchaa company')"
    v-model:opened="opened"
  >
    <div class="space-y-3 pb-3 pt-0.5 text-p-sm text-ink-gray-8" data-testid="inchaa-company-panel">
      <p v-if="state && !state.enabled" data-testid="inchaa-company-disabled">
        {{ __("Company linking is turned off.") }}
      </p>

      <template v-else-if="state?.enabled">
        <p v-if="state.customer">
          {{ __("Customer on this ticket: {0}", [state.customer]) }}
        </p>
        <form class="space-y-2" data-testid="inchaa-company-lookup-form" @submit.prevent="lookup">
          <label class="block">
            {{ __("Inchaa user ID") }}
            <input
              v-model="form.userId"
              class="mt-1 w-full rounded border border-outline-gray-2 px-2 py-1"
              data-testid="inchaa-company-user"
              autocomplete="off"
            />
          </label>
          <label class="block">
            {{ __("Email") }}
            <input
              v-model="form.email"
              class="mt-1 w-full rounded border border-outline-gray-2 px-2 py-1"
              data-testid="inchaa-company-email"
              autocomplete="off"
            />
          </label>
          <label class="block">
            {{ __("Phone") }}
            <input
              v-model="form.phone"
              class="mt-1 w-full rounded border border-outline-gray-2 px-2 py-1"
              data-testid="inchaa-company-phone"
              autocomplete="off"
            />
          </label>
          <Button
            size="sm"
            :label="__('Look up')"
            :disabled="busy || identifierCount !== 1"
            data-testid="inchaa-company-lookup"
            @click="lookup"
          />
        </form>

        <div v-if="preview" class="space-y-2" data-testid="inchaa-company-preview">
          <p v-if="preview.fullName" data-testid="inchaa-company-person">
            {{ __("Person: {0}", [preview.fullName]) }}
          </p>
          <p v-if="preview.userType">
            {{ __("Account type: {0}", [preview.userType]) }}
          </p>
          <template v-if="preview.company">
            <p data-testid="inchaa-company-name">
              {{ __("Company: {0}", [preview.company.companyName]) }}
            </p>
            <p data-testid="inchaa-company-membership">
              {{ __("Membership: {0}", [preview.company.memberStatus || __("unknown")]) }}
            </p>
          </template>
          <p v-if="preview.message" role="status" data-testid="inchaa-company-message">
            {{ preview.message }}
          </p>
          <p v-if="preview.blockedReason" class="text-ink-red-6" role="alert">
            {{ preview.blockedReason }}
          </p>
          <p class="text-ink-gray-6">
            {{ __("A lookup does not link this ticket. Linking checks Inchaa again.") }}
          </p>
          <label v-if="preview.linkable" class="flex items-start gap-2">
            <input
              v-model="confirmed"
              type="checkbox"
              class="mt-0.5"
              data-testid="inchaa-company-confirm"
            />
            <span>{{ __("I confirmed this sender is this Inchaa account.") }}</span>
          </label>
          <Button
            variant="solid"
            size="sm"
            :label="__('Link company')"
            :disabled="busy || !confirmed || !preview.linkable || !preview.userId"
            data-testid="inchaa-company-link"
            @click="link"
          />
        </div>
        <p v-if="linked" role="status" data-testid="inchaa-company-linked">{{ linked }}</p>
        <p v-if="error" class="text-ink-red-6" role="alert" data-testid="inchaa-company-error">
          {{ error }}
        </p>
      </template>
    </div>
  </Section>
</template>

<script setup lang="ts">
import { reloadTicket } from "@/composables/useTicket";
import { __ } from "@/translation";
import { TicketSymbol } from "@/types";
import { Button, call } from "frappe-ui";
import { computed, inject, reactive, ref, watch } from "vue";
import Section from "../Section.vue";

interface CompanyPreview {
  outcome?: string;
  message?: string;
  linkable?: boolean;
  blockedReason?: string;
  fullName?: string | null;
  userType?: string | null;
  userId?: string | null;
  company?: {
    companyName?: string;
    memberStatus?: string;
  } | null;
}

interface PanelState {
  enabled: boolean;
  customer?: string | null;
}

const ticket = inject(TicketSymbol)!;
const visible = ref(false);
const opened = ref(true);
const busy = ref(false);
const error = ref("");
const linked = ref("");
const confirmed = ref(false);
const state = ref<PanelState | null>(null);
const preview = ref<CompanyPreview | null>(null);
const form = reactive({ userId: "", email: "", phone: "" });

const ticketName = computed(() => ticket.value?.doc?.name as string | undefined);
const identifierCount = computed(
  () => [form.userId, form.email, form.phone].filter((value) => value.trim()).length
);

function errorText(exc: unknown): string {
  if (exc && typeof exc === "object" && "messages" in exc) {
    const messages = (exc as { messages?: unknown }).messages;
    if (Array.isArray(messages) && messages.length) return messages.map(String).join(" ");
  }
  return exc instanceof Error ? exc.message : String(exc);
}

async function load() {
  const name = ticketName.value;
  preview.value = null;
  confirmed.value = false;
  error.value = "";
  linked.value = "";
  if (!name) return;
  try {
    state.value = (await call(
      "inchaa_custmization.integrations.inchaa_platform.api.get_company_panel",
      { ticket: name }
    )) as PanelState;
    visible.value = true;
  } catch {
    visible.value = false;
  }
}

watch(ticketName, load, { immediate: true });

async function lookup() {
  const name = ticketName.value;
  if (!name || identifierCount.value !== 1) return;
  busy.value = true;
  error.value = "";
  linked.value = "";
  confirmed.value = false;
  preview.value = null;
  try {
    preview.value = (await call(
      "inchaa_custmization.integrations.inchaa_platform.api.lookup_company_identity",
      {
        ticket: name,
        user_id: form.userId.trim(),
        email: form.email.trim(),
        phone: form.phone.trim(),
      }
    )) as CompanyPreview;
  } catch (exc: unknown) {
    error.value = errorText(exc);
  } finally {
    busy.value = false;
  }
}

async function link() {
  const name = ticketName.value;
  const userId = preview.value?.userId;
  // The checkbox is the only thing that may start a link, and the server reads
  // the company again. The preview's company is not sent.
  if (!name || !userId || !confirmed.value || !preview.value?.linkable) return;
  busy.value = true;
  error.value = "";
  linked.value = "";
  try {
    const result = (await call(
      "inchaa_custmization.integrations.inchaa_platform.api.link_company_identity",
      { ticket: name, user_id: userId, relationship_confirmed: 1 }
    )) as { customer?: string; company?: { companyName?: string } };
    const label = result.company?.companyName || result.customer || "";
    confirmed.value = false;
    preview.value = null;
    reloadTicket(name);
    await load();
    linked.value = __("Linked to {0}.", [label]);
  } catch (exc: unknown) {
    const text = errorText(exc);
    reloadTicket(name);
    await load();
    error.value = text;
  } finally {
    busy.value = false;
  }
}
</script>
