<template>
  <Dialog v-model:open="open" :title="__('Merge into another contact')">
    <div class="space-y-3 text-base" data-testid="merge-contact-dialog">
      <p class="text-ink-gray-7">
        {{
          __(
            "Tickets, calls, callbacks, conversations, emails and phone numbers of {0} move to the contact you choose. {0} is then deleted. This cannot be undone.",
            [sourceLabel]
          )
        }}
      </p>
      <TextInput
        v-model="query"
        variant="outline"
        :placeholder="__('Search by name, email or phone')"
        data-testid="merge-contact-search"
      />
      <ul
        v-if="choices.length"
        class="divide-y divide-outline-gray-1 rounded-4 border border-outline-gray-1"
      >
        <li v-for="row in choices" :key="row.name">
          <button
            type="button"
            class="flex w-full items-center justify-between gap-3 px-3 py-2 text-start hover:bg-surface-gray-2"
            :class="target?.name === row.name && 'bg-surface-gray-2'"
            @click="target = row"
          >
            <span class="truncate font-medium text-ink-gray-9">
              {{ row.full_name || row.name }}
            </span>
            <span class="truncate text-ink-gray-6">
              {{ row.email_id || row.mobile_no || row.phone || "" }}
            </span>
          </button>
        </li>
      </ul>
      <p v-if="error" role="alert" class="text-ink-red-6">{{ error }}</p>
      <div class="flex justify-end gap-2">
        <Button :label="__('Cancel')" :disabled="merging" @click="open = false" />
        <Button
          variant="solid"
          theme="red"
          :label="
            target
              ? __('Merge into {0}', [target.full_name || target.name])
              : __('Merge')
          "
          :disabled="!target"
          :loading="merging"
          data-testid="merge-contact-confirm"
          @click="merge"
        />
      </div>
    </div>
  </Dialog>
</template>

<script setup lang="ts">
import { __ } from "@/translation";
import { useDebounceFn } from "@vueuse/core";
import { Button, Dialog, TextInput, call, createResource, toast } from "frappe-ui";
import { computed, ref, watch } from "vue";
import { useRouter } from "vue-router";

interface ContactRow {
  name: string;
  full_name?: string;
  email_id?: string;
  mobile_no?: string;
  phone?: string;
}

const props = defineProps<{ source: string; sourceLabel: string }>();
const open = defineModel<boolean>("open", { default: false });

const router = useRouter();
const query = ref("");
const target = ref<ContactRow | null>(null);
const merging = ref(false);
const error = ref("");

const results = createResource({
  url: "helpdesk.api.contact.find_contacts",
  method: "GET",
  makeParams: () => ({ txt: query.value.trim() }),
});
const choices = computed<ContactRow[]>(() =>
  (results.data || []).filter((row: ContactRow) => row.name !== props.source)
);
watch(query, useDebounceFn(() => results.reload(), 300));
watch(open, (isOpen) => {
  if (!isOpen) return;
  query.value = "";
  target.value = null;
  error.value = "";
  results.reload();
});

async function merge() {
  if (!target.value || merging.value) return;
  merging.value = true;
  error.value = "";
  try {
    const kept = await call("helpdesk.api.contact.merge_contacts", {
      source: props.source,
      target: target.value.name,
    });
    open.value = false;
    toast.success(__("Contacts merged"));
    // The contact page keeps its first contact's data, so it is loaded afresh.
    window.location.replace(router.resolve({ name: "Contact", params: { id: kept } }).href);
  } catch (e) {
    const failure = e as { messages?: string[] };
    error.value = failure.messages?.[0] || __("The contacts could not be merged.");
  } finally {
    merging.value = false;
  }
}
</script>
