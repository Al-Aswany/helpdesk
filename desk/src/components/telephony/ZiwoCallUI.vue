<template>
  <!--
    The ZIWO web component (<ziwo-root>) and its bridge script are only ever
    injected once the agent explicitly opens this panel (openPanel()). Nothing
    here loads on app boot, so a disabled/unconfigured ZIWO connector has zero
    footprint on the shared Helpdesk shell.
  -->
  <teleport to="body">
    <div v-if="sdkRequested">
      <ziwo-root automation="custom"></ziwo-root>
    </div>
  </teleport>

  <div v-show="showPopup" v-bind="$attrs">
    <div
      ref="popupHeader"
      class="fixed z-20 flex w-72 cursor-move select-none flex-col gap-3 rounded-lg bg-surface-gray-10 p-3 !text-ink-gray-2 shadow-2xl"
      :style="style"
    >
      <div class="flex flex-row-reverse items-center">
        <Button
          @click="closePopup"
          class="bg-surface-gray-10 text-ink-base hover:bg-surface-gray-9 shrink-0"
          icon="lucide-x"
          size="sm"
        />
        <div class="flex-1 text-sm font-medium">ZIWO</div>
      </div>

      <!-- SDK failed to load / is unavailable -->
      <div v-if="sdkError" class="flex flex-col gap-2 text-sm">
        <div class="text-ink-red-4">{{ sdkError }}</div>
        <Button size="sm" @click="retrySdkLoad">{{ __("Retry") }}</Button>
      </div>

      <!-- Not logged in yet: ZIWO's own embedded login -->
      <template v-else-if="!loggedIn">
        <div class="flex flex-col gap-2">
          <FormControl
            type="text"
            v-model="loginForm.accountName"
            :label="__('ZIWO Account Name')"
          />
          <FormControl
            type="text"
            v-model="loginForm.email"
            :label="__('Agent Email')"
          />
          <FormControl
            type="password"
            v-model="loginForm.password"
            :label="__('Password')"
          />
          <div v-if="loginError" class="text-sm text-ink-red-4">
            {{ loginError }}
          </div>
          <Button
            variant="solid"
            :loading="loggingIn"
            @click="login"
          >
            {{ __("Log in to ZIWO") }}
          </Button>
        </div>
      </template>

      <!-- Logged in: dialpad / active call state -->
      <template v-else>
        <div class="flex flex-col items-center justify-center gap-2">
          <Avatar
            :image="matchedContact?.image"
            :label="matchedContact?.label || displayNumber"
            class="relative flex !h-16 !w-16 items-center justify-center [&>div]:text-[22px]"
            :class="callStatus === 'active' ? '' : 'pulse'"
          />
          <div class="text-lg font-medium">
            {{ matchedContact?.label || displayNumber || __("No active call") }}
          </div>
          <div v-if="currentCall" class="text-sm text-ink-gray-5">
            {{ callStatusLabel }}
            <template v-if="callStatus === 'active'">
              · {{ counterUp?.updatedTime }}
            </template>
          </div>
        </div>

        <CountUpTimer ref="counterUp" class="hidden" />

        <!-- Ambiguous match: agent must pick, never auto-linked -->
        <div
          v-if="lookupResult.requiresSelection && !currentCall?.ticket"
          class="flex flex-col gap-1"
        >
          <div class="text-xs text-ink-gray-5">
            {{ __("Multiple matches found. Choose one to link:") }}
          </div>
          <div
            v-for="c in lookupResult.contacts"
            :key="c.name"
            class="cursor-pointer rounded px-2 py-1 text-sm hover:bg-surface-gray-9"
            @click="attachContact(c.name)"
          >
            {{ c.label }} ({{ c.phone || c.mobile_no }})
          </div>
          <div
            v-for="t in lookupResult.tickets"
            :key="t.name"
            class="cursor-pointer rounded px-2 py-1 text-sm hover:bg-surface-gray-9"
            @click="attachTicket(t.name)"
          >
            {{ __("Ticket") }} #{{ t.name }} — {{ t.subject }}
          </div>
        </div>

        <!-- Unambiguous open ticket(s): offer to attach, never auto-created -->
        <div
          v-else-if="!lookupResult.requiresSelection && lookupResult.tickets.length && !currentCall?.ticket"
          class="flex flex-col gap-1"
        >
          <div
            v-for="t in lookupResult.tickets"
            :key="t.name"
            class="flex items-center justify-between rounded px-2 py-1 text-sm hover:bg-surface-gray-9"
          >
            <span>#{{ t.name }} — {{ t.subject }}</span>
            <Button size="sm" variant="subtle" @click="attachTicket(t.name)">
              {{ __("Link") }}
            </Button>
          </div>
        </div>

        <div v-if="currentCall?.ticket" class="text-sm text-ink-gray-5">
          {{ __("Linked to ticket") }} #{{ currentCall.ticket }}
        </div>

        <div class="flex justify-center gap-2">
          <Button
            v-if="callStatus === 'active' || callStatus === 'ringing' || outboundInFlight"
            class="rounded-full bg-surface-red-7 hover:bg-surface-red-8"
            @click="hangUp"
          >
            <template #icon>
              <LucidePhone class="h-4 w-4 rotate-[135deg] text-ink-base" />
            </template>
          </Button>
          <div v-else class="flex w-full gap-2">
            <FormControl
              type="text"
              class="flex-1"
              v-model="dialNumber"
              :placeholder="__('Phone number')"
            />
            <Button variant="solid" theme="green" @click="makeOutgoingCall(dialNumber)">
              {{ __("Call") }}
            </Button>
          </div>
        </div>
      </template>
    </div>
  </div>
</template>

<script setup lang="ts">
import { Avatar, Button, FormControl, call, toast } from "frappe-ui";
import { useDraggable, useWindowSize } from "@vueuse/core";
import { computed, onBeforeUnmount, onMounted, reactive, ref } from "vue";
import LucidePhone from "~icons/lucide/phone";
import CountUpTimer from "./CountUpTimer.vue";

const props = defineProps({
  userEmail: {
    type: String,
    default: "",
  },
});

// --- Config (fetched on setup(), never triggers a script load by itself) ---
const config = reactive({
  enabled: false,
  canUse: false,
  sdkScriptUrl: "",
  accountNameHint: "",
  defaultRegion: "AE",
});

// --- SDK lifecycle: only touched once the agent opens the panel ---
const sdkRequested = ref(false); // <ziwo-root> mounted in DOM
const sdkScriptLoaded = ref(false);
const sdkError = ref("");
let scriptEl: HTMLScriptElement | null = null;

// --- Session ---
const loggedIn = ref(false);
const loggingIn = ref(false);
const loginError = ref("");
const loginForm = reactive({
  accountName: "",
  email: props.userEmail || "",
  password: "",
});

// --- Popup / drag UI (same pattern as ExotelCallUI) ---
const showPopup = ref(false);
const popupHeader = ref(null);
const { width, height } = useWindowSize();
let { style, x, y } = useDraggable(popupHeader, {
  initialValue: { x: width.value - 300, y: height.value - 340 },
  preventDefault: true,
});

// --- Call state ---
const dialNumber = ref("");
const currentCall = ref<any>(null); // { callId, direction, status, ticket }
const callStatus = ref(""); // "ringing" | "active" | "ended" | ""
const outboundInFlight = ref(false);
const counterUp = ref(null);
const lookupResult = reactive({ contacts: [], tickets: [], requiresSelection: false });
const matchedContact = ref<any>(null);

const RINGING_EVENTS = new Set(["ringing"]);
const OUTBOUND_PROGRESS_EVENTS = new Set(["requesting", "trying", "early"]);
const ACTIVE_EVENTS = new Set(["active", "answering"]);
const HANGUP_EVENTS = new Set(["hangup", "destroy"]);

const displayNumber = computed(() => currentCall.value?.customerNumber || dialNumber.value);
const callStatusLabel = computed(() => {
  if (callStatus.value === "ringing") return __("Ringing...");
  if (callStatus.value === "active") return __("In progress");
  if (callStatus.value === "ended") return __("Call ended");
  if (outboundInFlight.value) return __("Calling...");
  return "";
});

function __(s: string) {
  // Helpdesk ships a global translate helper elsewhere; keep this local and
  // dependency-free so this component has no hidden coupling.
  return (window as any).__ ? (window as any).__(s) : s;
}

async function fetchConfig() {
  try {
    const data = await call(
      "inchaa_custmization.integrations.ziwo.api.get_config"
    );
    config.enabled = Boolean(data.enabled);
    config.canUse = Boolean(data.can_use);
    config.sdkScriptUrl = data.sdk_script_url || "";
    config.accountNameHint = data.account_name_hint || "";
    config.defaultRegion = data.default_region || "AE";
    loginForm.accountName = config.accountNameHint;
  } catch (error) {
    // ZIWO is an optional custom-app integration; any failure here must
    // leave the rest of the Helpdesk calling UI (Twilio/Exotel) untouched.
    config.enabled = false;
    config.canUse = false;
  }
}

function loadScriptOnce(src: string): Promise<void> {
  return new Promise((resolve, reject) => {
    if (sdkScriptLoaded.value) return resolve();
    scriptEl = document.createElement("script");
    scriptEl.src = src;
    scriptEl.async = true;
    scriptEl.onload = () => {
      sdkScriptLoaded.value = true;
      resolve();
    };
    scriptEl.onerror = () => reject(new Error(__("Failed to load the ZIWO calling script.")));
    document.body.appendChild(scriptEl);
  });
}

async function ensureSdkLoaded() {
  sdkError.value = "";
  if (!config.sdkScriptUrl) {
    sdkError.value = __("ZIWO is not configured.");
    return false;
  }
  sdkRequested.value = true;
  try {
    await loadScriptOnce(config.sdkScriptUrl);
    return true;
  } catch (e: any) {
    sdkError.value = e?.message || __("ZIWO script failed to load.");
    return false;
  }
}

function retrySdkLoad() {
  sdkScriptLoaded.value = false;
  if (scriptEl) {
    scriptEl.remove();
    scriptEl = null;
  }
  ensureSdkLoaded();
}

function ziwo() {
  return (window as any).ZIWO;
}

async function login() {
  loginError.value = "";
  if (!(await ensureSdkLoaded())) return;
  const sdk = ziwo();
  if (!sdk?.session?.login) {
    loginError.value = __(
      "The ZIWO SDK did not expose a session login method. Verify the SDK build against ZIWO's current documentation."
    );
    return;
  }
  loggingIn.value = true;
  try {
    // SessionManager.login(accountName, email, password) per ZIWO's documented
    // SessionManager interface. The agent's own credentials are sent directly
    // to ZIWO's bridge in-browser; they are never sent to the Helpdesk backend.
    await sdk.session.login(loginForm.accountName, loginForm.email, loginForm.password);
    loggedIn.value = true;
  } catch (e: any) {
    loggedIn.value = false;
    loginError.value = e?.message || __("ZIWO login failed. Check the account name, email and password.");
  } finally {
    loggingIn.value = false;
  }
}

function openPanel() {
  showPopup.value = true;
  if (!sdkRequested.value) ensureSdkLoaded();
}

function closePopup() {
  showPopup.value = false;
}

async function makeOutgoingCall(number: string) {
  if (!number) return;
  openPanel();
  if (!loggedIn.value) {
    loginError.value = __("Log in to ZIWO before placing a call.");
    return;
  }
  const sdk = ziwo();
  const calls = sdk?.calls;
  if (!calls) {
    sdkError.value = __("ZIWO calling is not available in this session.");
    return;
  }
  dialNumber.value = number;
  outboundInFlight.value = true;
  currentCall.value = null;
  try {
    // ZIWO's CallsManager documents both clickToCall() and startCall() under
    // calls.*; the exact required parameter shape for this tenant has not
    // been confirmed against a live account, so the simpler, documented
    // click-to-call helper is tried first.
    if (typeof calls.clickToCall === "function") {
      await calls.clickToCall(number);
    } else if (typeof calls.startCall === "function") {
      await calls.startCall({ number });
    } else {
      throw new Error(__("No supported ZIWO call method is available."));
    }
  } catch (e: any) {
    outboundInFlight.value = false;
    toast.error(e?.message || __("Failed to start the ZIWO call."));
  }
}

async function hangUp() {
  const sdk = ziwo();
  try {
    await sdk?.calls?.hangUpCall?.();
  } catch (e) {
    // Best-effort only: the hangup event handler is the source of truth for
    // the durable call record, not this client-side call.
  }
}

async function lookupCustomer(number: string) {
  if (!config.canUse || !number) return;
  try {
    const data = await call("inchaa_custmization.integrations.ziwo.api.lookup_customer", {
      phone_number: number,
    });
    lookupResult.contacts = data.contacts || [];
    lookupResult.tickets = data.tickets || [];
    lookupResult.requiresSelection = Boolean(data.requires_selection);
    if (!lookupResult.requiresSelection && lookupResult.contacts.length === 1) {
      matchedContact.value = {
        label: lookupResult.contacts[0].label,
        image: lookupResult.contacts[0].image,
      };
    } else {
      matchedContact.value = null;
    }
  } catch (e) {
    // A failed lookup must never block call handling; it just means no
    // contact/ticket suggestions are shown for this call.
    lookupResult.contacts = [];
    lookupResult.tickets = [];
    lookupResult.requiresSelection = false;
  }
}

async function attachTicket(ticketName: string) {
  if (!currentCall.value?.callId) return;
  try {
    await call("inchaa_custmization.integrations.ziwo.api.link_call_ticket", {
      call_id: currentCall.value.callId,
      ticket: ticketName,
    });
    currentCall.value.ticket = ticketName;
    toast.success(__("Call linked to ticket."));
  } catch (e: any) {
    toast.error(e?.message || __("Could not link this call to the ticket."));
  }
}

async function attachContact(contactName: string) {
  if (!currentCall.value?.callId) return;
  try {
    await call("inchaa_custmization.integrations.ziwo.api.set_call_contact", {
      call_id: currentCall.value.callId,
      contact: contactName,
    });
    toast.success(__("Call linked to contact."));
  } catch (e: any) {
    toast.error(e?.message || __("Could not link this call to the contact."));
  }
}

async function recordEvent(detail: any, inferredDirection: string) {
  const callId = detail?.callId || detail?.call_id || detail?.id;
  if (!callId) return; // never record an event we cannot key durably
  const eventType = String(detail?.type || detail?.eventType || "unknown");
  try {
    const result = await call("inchaa_custmization.integrations.ziwo.api.record_call_event", {
      call_id: String(callId),
      event_type: eventType,
      direction: inferredDirection,
      customer_number: detail?.callerIdNumber || detail?.customerNumber || detail?.number || "",
      raw_payload: detail || {},
    });
    return result;
  } catch (e) {
    // Backend recording failures must not crash the in-browser call UI; the
    // scheduled recovery job (recover_pending_enrichment) covers durability
    // for events that made it into the Call Log but not into Call Event rows
    // is out of scope here — this is strictly a best-effort client post.
    return null;
  }
}

function onZiwoCallEvent(e: Event) {
  const detail = (e as CustomEvent).detail || {};
  const eventType = String(detail?.type || "").toLowerCase();
  const callId = detail?.callId || detail?.call_id || detail?.id;

  const direction = outboundInFlight.value ? "Outbound" : "Inbound";

  if (!currentCall.value || currentCall.value.callId !== callId) {
    currentCall.value = {
      callId,
      customerNumber: detail?.callerIdNumber || detail?.number || "",
      ticket: null,
    };
  }

  if (RINGING_EVENTS.has(eventType)) {
    callStatus.value = "ringing";
    showPopup.value = true;
    if (currentCall.value.customerNumber) lookupCustomer(currentCall.value.customerNumber);
  } else if (OUTBOUND_PROGRESS_EVENTS.has(eventType)) {
    callStatus.value = "ringing";
  } else if (ACTIVE_EVENTS.has(eventType)) {
    callStatus.value = "active";
    outboundInFlight.value = false;
    counterUp.value?.start?.();
  } else if (HANGUP_EVENTS.has(eventType)) {
    callStatus.value = "ended";
    outboundInFlight.value = false;
    counterUp.value?.stop?.();
  }

  recordEvent(detail, direction);
}

const ZIWO_WINDOW_EVENTS = [
  "ziwo-call-ringing",
  "ziwo-call-requesting",
  "ziwo-call-trying",
  "ziwo-call-early",
  "ziwo-call-attach",
  "ziwo-call-answering",
  "ziwo-call-active",
  "ziwo-call-recovering",
  "ziwo-call-hangup",
  "ziwo-call-destroy",
];

function installListeners() {
  ZIWO_WINDOW_EVENTS.forEach((name) => window.addEventListener(name, onZiwoCallEvent));
}

function removeListeners() {
  ZIWO_WINDOW_EVENTS.forEach((name) => window.removeEventListener(name, onZiwoCallEvent));
}

async function setup() {
  await fetchConfig();
}

onMounted(() => {
  installListeners();
});

onBeforeUnmount(() => {
  removeListeners();
});

defineExpose({ setup, makeOutgoingCall, openPanel, config });
</script>
