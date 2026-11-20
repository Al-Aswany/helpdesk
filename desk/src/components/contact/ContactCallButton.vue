<template>
  <div class="flex flex-col items-end gap-1">
    <div class="flex items-center gap-2">
      <FormControl
        v-if="phones.length > 1"
        v-model="selected"
        type="select"
        :options="phoneOptions"
        :aria-label="__('Phone number')"
      />
      <Button
        variant="solid"
        :label="__('Call')"
        :disabled="disabled"
        :title="reason"
        @click="dial"
      >
        <template #prefix>
          <LucidePhone class="h-4 w-4" />
        </template>
      </Button>
    </div>
    <p v-if="reason" class="max-w-xs text-right text-sm text-ink-gray-6">
      {{ reason }}
    </p>
    <p
      v-if="shared.length"
      class="max-w-xs text-right text-sm text-ink-amber-7"
    >
      {{
        __("This number is also on {0}.", [
          shared.map((row) => row.label).join(", "),
        ])
      }}
    </p>
  </div>
</template>

<script setup lang="ts">
import { useTelephonyStore } from "@/stores/telephony";
import { __ } from "@/translation";
import { Button, FormControl } from "frappe-ui";
import { computed, ref, watch } from "vue";
import LucidePhone from "~icons/lucide/phone";

const props = defineProps<{
  contactId: string;
  phones: string[];
  shared?: { name: string; label: string }[];
  lastOutcome?: string;
}>();

const store = useTelephonyStore();
const selected = ref("");
const shared = computed(() => props.shared || []);
const phoneOptions = computed(() =>
  props.phones.map((phone) => ({ label: phone, value: phone }))
);

watch(
  () => props.phones,
  (phones) => {
    if (!phones.includes(selected.value)) selected.value = phones[0] || "";
  },
  { immediate: true }
);

const reason = computed(() => {
  if (!store.ziwoStatusLoaded) return "";
  if (!store.isZiwoEnabled) return __("ZIWO calling is not available for you.");
  if (!props.phones.length)
    return __("No phone number. Ask an Agent Manager to add one.");
  return "";
});
const disabled = computed(
  () => !store.ziwoStatusLoaded || Boolean(reason.value) || !selected.value
);

function dial() {
  if (
    props.lastOutcome === "Do not call" &&
    !window.confirm(__("This contact is marked Do not call. Call anyway?"))
  ) {
    return;
  }
  store.makeCall({
    number: selected.value,
    doctype: "Contact",
    docname: props.contactId,
  });
}
</script>
