<template>
  <component :is="icon" v-bind="$attrs" />
</template>

<script setup lang="ts">
import { InstagramIcon, MessengerIcon, WhatsAppIcon } from "@/components/icons";
import { computed } from "vue";
import LucideMessageSquare from "~icons/lucide/message-square";

// `name` comes from the channel descriptor. Unknown names get a neutral icon.
const props = defineProps<{ name?: string | null }>();

const icon = computed(() => {
  if (props.name === "whatsapp") return WhatsAppIcon;
  if (props.name === "messenger") return MessengerIcon;
  if (props.name === "instagram") return InstagramIcon;
  return LucideMessageSquare;
});

defineOptions({ inheritAttrs: false });
</script>
