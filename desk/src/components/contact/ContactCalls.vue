<template>
  <div class="flex flex-col gap-4">
    <p v-if="loading" class="text-base text-ink-gray-6">
      {{ __("Loading calls…") }}
    </p>
    <p v-else-if="error" role="alert" class="text-base text-ink-red-6">
      {{ error }}
    </p>
    <template v-else>
      <ZiwoCallList
        :calls="calls"
        :show-agent="true"
        :show-ticket="true"
        :empty-text="__('No calls yet.')"
      />
      <ul v-if="calls.length" class="space-y-2">
        <li
          v-for="row in calls"
          :key="row.name"
          class="flex flex-wrap items-center gap-2 text-sm text-ink-gray-7"
        >
          <span class="font-medium text-ink-gray-8">
            {{ row.agent_name || row.agent }}
          </span>
          <span>{{ row.outcome ? __(row.outcome) : __("Outcome missing") }}</span>
          <span v-if="row.outcome_note" class="max-w-md truncate">{{
            row.outcome_note
          }}</span>
          <span v-if="row.outcome === 'Interested'" class="text-ink-gray-8">
            {{ __("Enter this lead in Zoho CRM.") }}
            <template v-if="row.zoho_lead_entered">{{ __("Marked as entered.") }}</template>
          </span>
          <Button
            v-if="row.can_record_outcome || row.can_edit_outcome"
            size="sm"
            :label="row.outcome ? __('Edit outcome') : __('Record outcome')"
            @click="$emit('record', row)"
          />
        </li>
      </ul>
    </template>
  </div>
</template>

<script setup lang="ts">
import ZiwoCallList from "@/components/telephony/ZiwoCallList.vue";
import { __ } from "@/translation";
import { Button } from "frappe-ui";

defineProps<{
  calls: any[];
  loading?: boolean;
  error?: string;
}>();

defineEmits<{ record: [row: any] }>();
</script>
