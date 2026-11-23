<template>
  <div class="flex flex-col gap-2" data-testid="ticket-contact-picker">
    <span class="block text-sm text-ink-gray-6">
      {{ __("Customer") }}
      <span class="place-self-center text-ink-red-5"> * </span>
    </span>
    <div
      v-if="chosen"
      class="flex items-center justify-between gap-2 rounded-4 border border-outline-gray-1 px-3 py-2 text-base"
      data-testid="ticket-contact-chosen"
    >
      <span class="min-w-0 truncate">
        <span class="font-medium text-ink-gray-9">{{ label(chosen) }}</span>
        <span class="ms-2 text-ink-gray-6">{{ detail(chosen) }}</span>
      </span>
      <Button size="sm" variant="ghost" :label="__('Change')" @click="clear" />
    </div>
    <form
      v-else-if="creating"
      class="grid grid-cols-1 gap-2 rounded-4 border border-outline-gray-1 p-3 sm:grid-cols-3"
      data-testid="ticket-contact-form"
      @submit.prevent="create"
    >
      <TextInput
        v-model="draft.first_name"
        variant="outline"
        :placeholder="__('Name')"
        maxlength="140"
      />
      <TextInput
        v-model="draft.email"
        type="email"
        variant="outline"
        :placeholder="__('Email (optional)')"
      />
      <TextInput
        v-model="draft.phone"
        variant="outline"
        :placeholder="__('Phone, e.g. +971501234567')"
      />
      <p v-if="error" class="text-sm text-ink-red-6 sm:col-span-3" role="alert">
        {{ error }}
      </p>
      <div class="flex gap-2 sm:col-span-3">
        <Button
          size="sm"
          variant="solid"
          type="submit"
          :label="__('Create contact')"
          :loading="saving"
          data-testid="ticket-contact-create"
        />
        <Button
          size="sm"
          variant="ghost"
          type="button"
          :label="__('Cancel')"
          @click="creating = false"
        />
      </div>
    </form>
    <template v-else>
      <TextInput
        v-model="query"
        variant="outline"
        :placeholder="__('Search by name, email or phone')"
        data-testid="ticket-contact-search"
      />
      <ul
        v-if="results.data?.length"
        class="divide-y divide-outline-gray-1 rounded-4 border border-outline-gray-1 text-base"
      >
        <li v-for="row in results.data" :key="row.name">
          <button
            type="button"
            class="flex w-full items-center justify-between gap-3 px-3 py-2 text-start hover:bg-surface-gray-2"
            @click="choose(row)"
          >
            <span class="truncate font-medium text-ink-gray-9">{{ label(row) }}</span>
            <span class="truncate text-ink-gray-6">{{ detail(row) }}</span>
          </button>
        </li>
      </ul>
      <p
        v-else-if="query.trim() && !results.loading"
        class="text-sm text-ink-gray-5"
      >
        {{ __("No contact found.") }}
      </p>
      <div>
        <Button
          size="sm"
          variant="subtle"
          :label="__('New contact')"
          data-testid="ticket-contact-new"
          @click="startCreate"
        />
      </div>
    </template>
  </div>
</template>

<script setup lang="ts">
import { __ } from "@/translation";
import { useDebounceFn } from "@vueuse/core";
import { Button, TextInput, call, createResource } from "frappe-ui";
import { reactive, ref, watch } from "vue";

interface ContactRow {
  name: string;
  full_name?: string;
  email_id?: string;
  mobile_no?: string;
  phone?: string;
}

const contact = defineModel<string>({ default: "" });

const query = ref("");
const chosen = ref<ContactRow | null>(null);
const creating = ref(false);
const saving = ref(false);
const error = ref("");
const draft = reactive({ first_name: "", email: "", phone: "" });

const results = createResource({
  url: "helpdesk.api.contact.find_contacts",
  method: "GET",
  makeParams: () => ({ txt: query.value.trim() }),
  auto: true,
});
watch(query, useDebounceFn(() => results.reload(), 300));

function label(row: ContactRow) {
  return row.full_name || row.name;
}

function detail(row: ContactRow) {
  return row.email_id || row.mobile_no || row.phone || "";
}

function choose(row: ContactRow) {
  chosen.value = row;
  contact.value = row.name;
}

function clear() {
  chosen.value = null;
  contact.value = "";
}

function startCreate() {
  const typed = query.value.trim();
  draft.first_name = /[@\d]/.test(typed) ? "" : typed;
  draft.email = typed.includes("@") ? typed : "";
  draft.phone = /^\+?[\d\s()-]{6,}$/.test(typed) ? typed : "";
  error.value = "";
  creating.value = true;
}

async function create() {
  const first_name = draft.first_name.trim();
  const email = draft.email.trim();
  const phone = draft.phone.replace(/[\s()-]/g, "");
  error.value = "";
  if (!first_name) {
    error.value = __("Enter the customer's name.");
    return;
  }
  if (!email && !phone) {
    error.value = __("Enter an email or a phone number.");
    return;
  }
  saving.value = true;
  try {
    const name = await call("helpdesk.api.contact.create_contact", {
      doc: { first_name, email: email || undefined, phone: phone || undefined },
    });
    choose({ name, full_name: first_name, email_id: email, mobile_no: phone });
    creating.value = false;
  } catch (e) {
    const failure = e as { messages?: string[]; message?: string };
    error.value =
      failure.messages?.[0] || failure.message || __("The contact could not be created.");
  } finally {
    saving.value = false;
  }
}
</script>
