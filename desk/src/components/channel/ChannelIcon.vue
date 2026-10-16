<template>
  <component :is="icon" v-bind="$attrs" />
</template>

<script setup lang="ts">
import { WhatsAppIcon } from "@/components/icons";
import { computed } from "vue";
import LucideMessageSquare from "~icons/lucide/message-square";

// `name` comes from the channel descriptor. Unknown names get a neutral icon.
const props = defineProps<{ name?: string | null }>();

const icon = computed(() =>
  props.name === "whatsapp" ? WhatsAppIcon : LucideMessageSquare
);

defineOptions({ inheritAttrs: false });
</script>
