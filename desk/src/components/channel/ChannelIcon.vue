<template>
  <span
    v-bind="$attrs"
    class="inline-flex shrink-0"
    role="img"
    :aria-label="accessibleLabel"
    :title="accessibleLabel"
  >
    <component :is="icon" class="size-full" aria-hidden="true" />
  </span>
</template>

<script setup lang="ts">
import {
  InchaaIcon,
  InstagramIcon,
  MessengerIcon,
  WhatsAppIcon,
} from "@/components/icons";
import { computed } from "vue";
import LucideMessageSquare from "~icons/lucide/message-square";

// `name` comes from the channel descriptor. Unknown names get a neutral icon.
const props = defineProps<{ name?: string | null; label?: string | null }>();
const accessibleLabel = computed(
  () =>
    props.label ||
    ({
      whatsapp: "WhatsApp",
      messenger: "Messenger",
      instagram: "Instagram",
      inchaa: "Inchaa",
      inchaa_platform: "Inchaa",
    }[props.name || ""] ?? "Conversation")
);

const icon = computed(() => {
  if (props.name === "whatsapp") return WhatsAppIcon;
  if (props.name === "messenger") return MessengerIcon;
  if (props.name === "instagram") return InstagramIcon;
  if (props.name === "inchaa" || props.name === "inchaa_platform")
    return InchaaIcon;
  return LucideMessageSquare;
});

defineOptions({ inheritAttrs: false });
</script>
