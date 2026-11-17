<template>
  <TwilioCallUI ref="twilio" />
  <ExotelCallUI ref="exotel" />
  <ZiwoCallUI ref="ziwo" />
  <Dialog
    v-model:open="show"
    title="Make call"
    :actions="[
      {
        label: `Call using ${callMedium}`,
        variant: 'solid',
        onClick: makeCallUsing,
      },
    ]"
  >
    <template #default>
      <div class="flex flex-col gap-4">
        <FormControl type="text" v-model="mobileNumber" label="Mobile Number" />
        <FormControl
          type="select"
          v-model="callMedium"
          :label="'Calling Medium'"
          :options="mediumOptions"
        />
        <div v-if="callMedium !== 'Ziwo'" class="flex flex-col gap-1">
          <FormControl
            type="checkbox"
            v-model="isDefaultMedium"
            :label="`Make ${callMedium} as default calling medium`"
          />

          <div v-if="isDefaultMedium" class="text-sm text-ink-gray-4">
            {{
              __("You can change the default calling medium from the settings")
            }}
          </div>
        </div>
      </div>
    </template>
  </Dialog>
</template>
<script setup lang="ts">
import { FormControl, call, toast } from "frappe-ui";
import { computed, nextTick, ref, watch } from "vue";
import TwilioCallUI from "./TwilioCallUI.vue";
import ExotelCallUI from "./ExotelCallUI.vue";
import ZiwoCallUI from "./ZiwoCallUI.vue";
import { useTelephonyStore } from "@/stores/telephony";
import { storeToRefs } from "pinia";

const telephonyStore = useTelephonyStore();
const {
  defaultCallingMedium,
  isExotelEnabled,
  isTwilioEnabled,
  isZiwoEnabled,
} = storeToRefs(telephonyStore);

const twilio = ref(null);
const exotel = ref(null);
const ziwo = ref(null);

// Only media that are actually enabled are offered. With none enabled the dialog keeps the
// original two options, exactly as it was before ZIWO existed.
const mediumOptions = computed(() => {
  const options = [];
  if (isTwilioEnabled.value) options.push("Twilio");
  if (isExotelEnabled.value) options.push("Exotel");
  if (isZiwoEnabled.value) options.push("Ziwo");
  return options.length ? options : ["Twilio", "Exotel"];
});

const callMedium = ref("Twilio");
const isDefaultMedium = ref(false);

const show = ref(false);
const mobileNumber = ref("");

const props = defineProps({
  userEmail: {
    type: String,
    default: "",
  },
});

function makeCall({ number, doctype, docname }) {
  telephonyStore.setLinkDoc({
    docname,
    doctype,
  });
  if (
    (mediumOptions.value.length > 1 && !defaultCallingMedium.value) ||
    !number
  ) {
    mobileNumber.value = number;
    show.value = true;
    return;
  }

  callMedium.value = mediumOptions.value[0];
  if (
    defaultCallingMedium.value &&
    mediumOptions.value.includes(defaultCallingMedium.value)
  ) {
    callMedium.value = defaultCallingMedium.value;
  }

  mobileNumber.value = number;
  makeCallUsing();
}

function makeCallUsing() {
  // The telephony app's default-medium field only knows Twilio and Exotel, so ZIWO is never
  // saved as a default; it is chosen in this dialog, or used when it is the only medium.
  if (
    isDefaultMedium.value &&
    callMedium.value &&
    callMedium.value !== "Ziwo"
  ) {
    setCallingMedium();
    isDefaultMedium.value = false;
  }

  if (callMedium.value === "Twilio") {
    twilio.value.makeOutgoingCall(mobileNumber.value);
  }

  if (callMedium.value === "Exotel") {
    exotel.value.makeOutgoingCall(mobileNumber.value);
  }

  if (callMedium.value === "Ziwo") {
    // The ticket is read here, from what was clicked, and handed over once. ZIWO keeps it for
    // the whole call, so moving to another ticket afterwards cannot change the association.
    const { doctype, docname } = telephonyStore.linkDoc;
    ziwo.value.makeOutgoingCall(mobileNumber.value, {
      ticket: doctype === "HD Ticket" ? docname : "",
    });
  }
  show.value = false;
}

async function setCallingMedium() {
  await call("telephony.api.set_default_calling_medium", {
    medium: callMedium.value,
  });

  telephonyStore.setDefaultCallingMedium(callMedium.value);
  telephonyStore.fetchCallIntegrationStatus();
  toast.success(
    `Default calling medium set successfully to ${callMedium.value}`
  );
}

watch(
  [isTwilioEnabled, isExotelEnabled],
  ([twilioValue, exotelValue]) =>
    nextTick(() => {
      if (twilioValue) {
        twilio.value.setup();
        callMedium.value = "Twilio";
      }

      if (exotelValue) {
        exotel.value.setup(props.userEmail);
        callMedium.value = "Exotel";
      }

      if (twilioValue || exotelValue) {
        callMedium.value = "Twilio";
        telephonyStore.setMakeCall(makeCall);
      }
    }),
  { immediate: true }
);

// Its own watcher, so the Twilio and Exotel wiring above is untouched. ZIWO sets itself up
// from the store; all it needs here is to be the target of the ticket call buttons.
watch(
  isZiwoEnabled,
  (enabled) => {
    if (!enabled) return;
    if (!isTwilioEnabled.value && !isExotelEnabled.value)
      callMedium.value = "Ziwo";
    telephonyStore.setMakeCall(makeCall);
  },
  { immediate: true }
);
</script>
