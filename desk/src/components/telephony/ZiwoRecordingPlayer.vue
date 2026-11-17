<template>
  <div
    class="flex flex-wrap items-center gap-x-2 gap-y-1 pt-0.5"
    data-testid="ziwo-recording"
  >
    <Button
      size="sm"
      variant="subtle"
      :disabled="!recordingsEnabled"
      :loading="state === 'loading'"
      :label="buttonLabel"
      :aria-label="buttonLabel"
      :aria-pressed="state === 'playing'"
      data-testid="ziwo-recording-toggle"
      @click="onToggle"
    >
      <template #prefix>
        <LucidePause v-if="state === 'playing'" class="size-3.5" />
        <LucidePlay v-else class="size-3.5" />
      </template>
    </Button>

    <span
      v-if="!recordingsEnabled"
      class="text-ink-gray-5"
      :title="unavailableReason"
      data-testid="ziwo-recording-unavailable"
    >
      {{ __("Recording playback is not set up") }}
    </span>
    <span
      v-else-if="state === 'playing' || state === 'ready'"
      class="tabular-nums text-ink-gray-6"
      data-testid="ziwo-recording-position"
    >
      {{ clock(position) }}
    </span>
    <span
      v-else-if="state === 'none'"
      class="text-ink-gray-5"
      role="status"
      data-testid="ziwo-recording-none"
    >
      {{ message }}
    </span>
    <span
      v-else-if="state === 'error'"
      class="text-ink-red-6"
      role="alert"
      data-testid="ziwo-recording-error"
    >
      {{ message }}
    </span>

    <!--
      The audio is a Blob this component downloaded through the authenticated Helpdesk endpoint;
      the source is a blob: address of this page, never a provider address. It has no native
      controls: Play and Pause above are the controls.
    -->
    <audio
      v-if="objectUrl"
      ref="audio"
      class="hidden"
      preload="auto"
      :src="objectUrl"
      @play="onPlaying"
      @pause="onPaused"
      @ended="onEnded"
      @timeupdate="onTime"
      @error="onMediaError"
    />
  </div>
</template>

<script setup lang="ts">
import {
  clock,
  loadRecording,
  playbackSlot,
  type FetchLike,
  type RecordingFetchError,
} from "@/composables/ziwoCall/recording";
import { useTelephonyStore } from "@/stores/telephony";
import { __ } from "@/translation";
import { Button } from "frappe-ui";
import { storeToRefs } from "pinia";
import { computed, nextTick, onBeforeUnmount, ref } from "vue";
import LucidePause from "~icons/lucide/pause";
import LucidePlay from "~icons/lucide/play";

/** `call` is the local call-log name from the call history, never a provider id or address. */
const props = defineProps<{ call: string }>();

type PlayerState = "idle" | "loading" | "ready" | "playing" | "none" | "error";

const store = useTelephonyStore();
const { isZiwoRecordingsEnabled: recordingsEnabled, ziwoRecordingsReason } =
  storeToRefs(store);

const state = ref<PlayerState>("idle");
const message = ref("");
const position = ref(0);
const objectUrl = ref("");
const audio = ref<HTMLAudioElement | null>(null);

let abort: AbortController | null = null;
let gone = false;
const slotHandle = { pause: () => audio.value?.pause() };

const unavailableReason = computed(
  () =>
    ziwoRecordingsReason.value ||
    __("A system manager must set up recording playback.")
);

const buttonLabel = computed(() => {
  if (state.value === "loading") return __("Loading recording");
  if (state.value === "playing") return __("Pause recording");
  return __("Play recording");
});

function setFailure(error: unknown) {
  const failure = error as RecordingFetchError;
  message.value = failure?.message || __("The recording could not be loaded.");
  state.value = failure?.kind === "not-found" ? "none" : "error";
}

async function download() {
  state.value = "loading";
  message.value = "";
  abort = new AbortController();
  try {
    const blob = await loadRecording(props.call, {
      // The browser's own fetch, same origin, with the agent's Helpdesk session.
      fetch: window.fetch.bind(window) as unknown as FetchLike,
      signal: abort.signal,
    });
    if (gone) return;
    objectUrl.value = URL.createObjectURL(blob);
    state.value = "ready";
  } catch (error: any) {
    if (gone || error?.name === "AbortError") return;
    setFailure(error);
  } finally {
    abort = null;
  }
}

async function play() {
  await nextTick();
  const element = audio.value;
  if (!element) return;
  try {
    await element.play();
  } catch {
    // Autoplay rules or a decoding problem. The button is still the way to try again.
    if (!gone) {
      message.value = __("The recording could not be played.");
      state.value = "error";
    }
  }
}

async function onToggle() {
  if (!recordingsEnabled.value || state.value === "loading") return;
  if (state.value === "playing") {
    audio.value?.pause();
    return;
  }
  if (!objectUrl.value) {
    await download();
    if (!objectUrl.value) return;
  }
  await play();
}

function onPlaying() {
  playbackSlot.claim(slotHandle);
  state.value = "playing";
}

function onPaused() {
  // `ended` fires pause too; keep the finished state in that case.
  if (state.value === "playing") state.value = "ready";
}

function onEnded() {
  playbackSlot.release(slotHandle);
  position.value = 0;
  if (audio.value) audio.value.currentTime = 0;
  state.value = "ready";
}

function onTime() {
  position.value = audio.value?.currentTime ?? 0;
}

function onMediaError() {
  playbackSlot.release(slotHandle);
  if (gone) return;
  message.value = __("This recording could not be played in your browser.");
  state.value = "error";
}

onBeforeUnmount(() => {
  gone = true;
  abort?.abort();
  audio.value?.pause();
  playbackSlot.release(slotHandle);
  if (objectUrl.value) URL.revokeObjectURL(objectUrl.value);
  objectUrl.value = "";
});
</script>
