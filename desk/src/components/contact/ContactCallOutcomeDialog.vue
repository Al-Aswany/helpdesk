<template>
  <Dialog v-model:open="open" :title="__('Record outcome')">
    <form class="space-y-3" @submit.prevent="save">
      <FormControl
        v-model="form.disposition"
        type="select"
        :label="__('Outcome')"
        :options="dispositionOptions"
        required
      />
      <p v-if="form.disposition === 'Interested'" class="text-sm text-ink-gray-7">
        {{ __("Enter this lead in Zoho CRM.") }}
      </p>
      <FormControl
        v-if="form.disposition === 'Interested'"
        v-model="form.zoho"
        type="checkbox"
        :label="__('I have entered this lead in Zoho CRM')"
      />
      <FormControl
        v-if="form.disposition === 'Support issue' && !ticket"
        v-model="form.subject"
        type="text"
        :label="__('Ticket subject')"
        maxlength="140"
        required
      />
      <label
        v-if="form.disposition === 'Call back' || form.disposition === 'No answer'"
        class="block text-sm text-ink-gray-7"
      >
        {{
          form.disposition === "Call back"
            ? __("Callback time ({0})", [timezone])
            : __("Move the follow-up ({0})", [timezone])
        }}
        <input
          v-model="form.due_at"
          type="datetime-local"
          :required="form.disposition === 'Call back'"
          class="mt-1 block w-full rounded border border-outline-gray-2 bg-surface-gray-2 px-2 py-1.5 text-base text-ink-gray-9"
        />
      </label>
      <div
        v-if="form.disposition === 'No answer'"
        class="flex flex-wrap gap-2"
      >
        <Button type="button" :label="__('In 2 hours')" @click="pickHours(2)" />
        <Button type="button" :label="__('Tomorrow 10:00')" @click="pickTomorrow" />
      </div>
      <FormControl
        v-model="form.note"
        type="textarea"
        :label="noteRequired ? __('Note') : __('Note (optional)')"
        maxlength="1000"
        :required="noteRequired"
      />
      <p v-if="error" role="alert" class="text-sm text-ink-red-6">{{ error }}</p>
      <div class="flex justify-end gap-2">
        <Button :label="__('Cancel')" :disabled="saving" @click="open = false" />
        <Button
          type="submit"
          variant="solid"
          :label="__('Save outcome')"
          :loading="saving"
        />
      </div>
    </form>
  </Dialog>
</template>

<script setup lang="ts">
import { __ } from "@/translation";
import { Button, Dialog, FormControl, call, dayjs, toast } from "frappe-ui";
import { computed, ref, watch } from "vue";

const props = defineProps<{
  contact: string;
  callLog: string;
  timezone?: string;
  ticket?: string;
  disposition?: string;
  note?: string;
  zohoLeadEntered?: boolean;
}>();
const open = defineModel<boolean>("open", { default: false });
const emit = defineEmits<{ saved: [] }>();

const DISPOSITIONS = [
  "Call back",
  "Interested",
  "No answer",
  "Not interested",
  "Wrong number",
  "Support issue",
  "Do not call",
];
const NOTE_REQUIRED = new Set([
  "Call back",
  "Interested",
  "Not interested",
  "Wrong number",
  "Support issue",
  "Do not call",
]);

const form = ref(blank());
const error = ref("");
const saving = ref(false);
const requestId = ref("");
const dispositionOptions = [
  { label: __("Choose an outcome"), value: "" },
  ...DISPOSITIONS.map((value) => ({ label: __(value), value })),
];
const noteRequired = computed(() => NOTE_REQUIRED.has(form.value.disposition));
const timezone = computed(() => props.timezone || "");

function blank() {
  return {
    disposition: props.disposition || "",
    note: props.note || "",
    due_at: "",
    subject: "",
    zoho: Boolean(props.zohoLeadEntered),
  };
}

watch(open, (isOpen) => {
  if (!isOpen) return;
  form.value = blank();
  error.value = "";
  requestId.value = crypto.randomUUID();
});

function pickHours(hours: number) {
  form.value.due_at = dayjs().add(hours, "hour").format("YYYY-MM-DDTHH:mm");
}

function pickTomorrow() {
  form.value.due_at = dayjs()
    .add(1, "day")
    .hour(10)
    .minute(0)
    .second(0)
    .format("YYYY-MM-DDTHH:mm");
}

async function save() {
  if (saving.value) return;
  error.value = "";
  saving.value = true;
  try {
    await call(
      "inchaa_custmization.integrations.ziwo.api.save_call_outcome",
      {
        request_id: requestId.value,
        contact: props.contact,
        call_log: props.callLog,
        disposition: form.value.disposition,
        note: form.value.note,
        callback_due_at: form.value.due_at,
        zoho_lead_entered: form.value.zoho ? 1 : 0,
        subject: form.value.subject,
      }
    );
  } catch (caught) {
    error.value =
      caught?.messages?.[0] || __("The outcome could not be saved.");
    saving.value = false;
    return;
  }
  saving.value = false;
  open.value = false;
  toast.success(__("Outcome saved"));
  emit("saved");
}
</script>
