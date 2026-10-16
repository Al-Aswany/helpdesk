<template>
  <div
    class="flex min-w-0 flex-wrap items-center gap-x-2 gap-y-1 text-p-sm text-ink-gray-6"
    data-testid="channel-recipient"
  >
    <ChannelIcon :name="descriptor.icon" class="size-4 shrink-0" />
    <span class="font-medium text-ink-gray-8">{{ descriptor.label }}</span>
    <template v-if="descriptor.contact.name || descriptor.contact.identity">
      <span aria-hidden="true">·</span>
      <span class="sr-only">{{ __("To") }}:</span>
    </template>
    <span
      v-if="descriptor.contact.name"
      dir="auto"
      class="max-w-[16rem] truncate text-ink-gray-8"
      :title="descriptor.contact.name"
    >
      {{ descriptor.contact.name }}
    </span>
    <!-- Phone numbers keep their order inside right-to-left text -->
    <bdi v-if="descriptor.contact.identity" dir="ltr">{{
      descriptor.contact.identity
    }}</bdi>
    <span v-if="descriptor.account.label" class="text-ink-gray-5">
      {{ __("via {0}", [descriptor.account.label]) }}
    </span>
  </div>
</template>

<script setup lang="ts">
import type { ChannelDescriptor } from "@/composables/ticketChannel";
import ChannelIcon from "./ChannelIcon.vue";

defineProps<{ descriptor: ChannelDescriptor }>();
</script>
