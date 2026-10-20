<template>
  <TwilioCallUI ref="twilio" />
  <ExotelCallUI ref="exotel" />
  <ZiwoCallUI ref="ziwo" :userEmail="props.userEmail" />
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
const { defaultCallingMedium, isExotelEnabled, isTwilioEnabled, isZiwoEnabled } =
  storeToRefs(telephonyStore);

const twilio = ref(null);
const exotel = ref(null);
const ziwo = ref(null);

const callMedium = ref("Twilio");
const isDefaultMedium = ref(false);

const mediumOptions = computed(() => {
  const options = [];
  if (isTwilioEnabled.value) options.push("Twilio");
  if (isExotelEnabled.value) options.push("Exotel");
  if (isZiwoEnabled.value) options.push("Ziwo");
  return options.length ? options : ["Twilio", "Exotel"];
});

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
  if ((mediumOptions.value.length > 1 && !defaultCallingMedium.value) || !number) {
    mobileNumber.value = number;
    show.value = true;
    return;
  }

  callMedium.value = mediumOptions.value[0];
  if (defaultCallingMedium.value && mediumOptions.value.includes(defaultCallingMedium.value)) {
    callMedium.value = defaultCallingMedium.value;
  }

  mobileNumber.value = number;
  makeCallUsing();
}

function makeCallUsing() {
  // The telephony app's "default medium" field only accepts Twilio/Exotel
  // (see apps/telephony's TP Telephony Agent doctype), which this fork does
  // not modify in place. Persisting Ziwo as a cross-session default would
  // require that app's own schema change, so it is intentionally out of
  // scope: Ziwo is always chosen per-call via this dialog instead.
  if (isDefaultMedium.value && callMedium.value && callMedium.value !== "Ziwo") {
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
    ziwo.value.makeOutgoingCall(mobileNumber.value);
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

// Kept as its own watcher so the pre-existing Twilio/Exotel wiring above is
// untouched. ZIWO is a separate, custom-app-owned, independently toggled
// integration (AGENTS.md: "do not modify... existing... flags").
watch(
  isZiwoEnabled,
  (ziwoValue) =>
    nextTick(() => {
      if (!ziwoValue) return;
      // setup() only fetches configuration; it never loads the ZIWO script
      // or mounts <ziwo-root> until the agent explicitly opens the panel
      // (see ZiwoCallUI's openPanel()/makeOutgoingCall()).
      ziwo.value.setup();
      if (!isTwilioEnabled.value && !isExotelEnabled.value) {
        callMedium.value = "Ziwo";
      }
      telephonyStore.setMakeCall(makeCall);
    }),
  { immediate: true }
);
</script>
