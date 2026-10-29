<template>
  <div class="flex items-center gap-3">
    <Avatar
      :label="contact.data?.name ?? ''"
      :image="contactImage"
      size="3xl"
    />
    <div class="flex min-w-0 flex-1 flex-col gap-1.5">
      <Tooltip :text="contact.data?.name || contact.data?.email_id">
        <div class="flex min-w-0 items-center gap-1.5 w-fit max-w-[65%]">
          <p
            class="min-h-[1lh] cursor-pointer truncate text-md font-medium text-ink-gray-7 hover:text-ink-gray-9"
            dir="auto"
            @click="contact.data?.email_id && openContact(contact.data?.name)"
          >
            {{ contact.data?.name || contact.data?.email_id }}
          </p>
        </div>
      </Tooltip>
      <div class="flex items-center gap-1 text-p-sm text-ink-gray-6">
        <p
          class="cursor-copy transition-colors hover:text-ink-gray-8"
          @click="
            copyToClipboard(
              ticket.doc.name,
              `Ticket #${ticket.doc.name} copied`
            )
          "
        >
          #{{ ticket.doc.name }}
        </p>
        <div class="flex items-center gap-1">
          <ChannelIcon
            v-if="channel.descriptor.value"
            :name="channel.descriptor.value.icon"
            :label="channel.descriptor.value.label"
            class="size-3.5"
          />
          <span>{{ sourceText }}</span>
        </div>
      </div>
    </div>
    <Tooltip v-if="isCallingEnabled" :text="__('Call contact')">
      <Button variant="ghost" @click="callContact">
        <template #icon>
          <PhoneIcon class="size-4" />
        </template>
      </Button>
    </Tooltip>
    <SetContactPhoneModal
      v-model="showPhoneModal"
      :name="contact.data?.name ?? ''"
      @onUpdate="contact.reload"
    />
  </div>
</template>

<script setup lang="ts">
import ChannelIcon from "@/components/channel/ChannelIcon.vue";
import { useShortcut } from "@/composables/shortcuts";
import { sourceLabel, useTicketChannel } from "@/composables/ticketChannel";
import { useTelephonyStore } from "@/stores/telephony";
import { useUserStore } from "@/stores/user";
import { TicketContactSymbol, TicketSymbol } from "@/types";
import { __ } from "@/translation";
import { copyToClipboard, openContact } from "@/utils";
import { Avatar, Button, Tooltip } from "frappe-ui";
import { storeToRefs } from "pinia";
import { computed, inject, ref } from "vue";
import PhoneIcon from "../icons/PhoneIcon.vue";
import SetContactPhoneModal from "../ticket/SetContactPhoneModal.vue";

const telephonyStore = useTelephonyStore();
const { getUser } = useUserStore();
const { isCallingEnabled } = storeToRefs(telephonyStore);
const showPhoneModal = ref(false);

const ticket = inject(TicketSymbol)!;

const channel = useTicketChannel(() => ticket.value?.doc?.name);
const sourceText = computed(() => {
  const label = sourceLabel({
    descriptor: channel.descriptor.value,
    viaPortal: ticket.value?.doc?.via_customer_portal,
    portalLabel: __("Portal"),
    emailLabel: __("Email"),
  });
  return __("via {0}", [label]);
});

const contact = inject(TicketContactSymbol)!;
const contactImage = computed(() => {
  if (!contact.value?.data) return "";
  const email = contact.value?.data?.email_id ?? "";
  return (
    contact.value?.data?.image || (email && getUser(email)?.user_image) || ""
  );
});

const callContact = () => {
  if (!contact.value.data.mobile_no && !contact.value.data.phone) {
    showPhoneModal.value = true;
    return;
  }
  telephonyStore.makeCall({
    number: contact.value.data.mobile_no || contact.value.data.phone,
    doctype: "HD Ticket",
    docname: ticket.value.name,
  });
};

useShortcut({ meta: true, shift: true, key: "." }, () => {
  copyToClipboard(window.location.href, `Ticket URL copied`);
});

useShortcut({ meta: true, key: "." }, () => {
  copyToClipboard(
    ticket.value.doc.name,
    `Ticket #${ticket.value.doc.name} copied`
  );
});
</script>
