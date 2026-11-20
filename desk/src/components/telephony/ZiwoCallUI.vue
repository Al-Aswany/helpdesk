<template>
  <!--
    The phone button opens ZIWO's own panel. Call & ticket is the Helpdesk view for linking,
    creating a ticket and ending the call. The ZIWO session and the call listeners live here,
    in the persistent app header, so switching panels or moving between tickets never signs
    out and never drops a call. The same iframe stays mounted.
  -->
  <Tooltip v-if="isZiwoEnabled" :text="toggleLabel">
    <button
      type="button"
      class="relative mt-1.5 flex size-7 items-center justify-center rounded text-ink-gray-6 hover:bg-surface-gray-2"
      :aria-label="toggleLabel"
      data-testid="ziwo-toggle"
      @click="togglePanel"
    >
      <LucidePhone class="size-4" />
      <span
        v-if="indicator"
        class="absolute -end-0.5 -top-0.5 size-2.5 rounded-full"
        :class="indicator"
        data-testid="ziwo-indicator"
      />
    </button>
  </Tooltip>

  <Teleport to="body">
    <iframe
      v-if="isZiwoEnabled && hostPageUrl"
      :key="frameKey"
      ref="frame"
      :src="hostPageUrl"
      title="ZIWO softphone"
      allow="microphone; autoplay"
      :class="
        vendorVisible
          ? 'fixed bottom-[4.5rem] end-4 z-[60] h-[560px] max-h-[calc(100vh-6.5rem)] w-[min(22.5rem,calc(100vw-1rem))] rounded-lg border border-outline-gray-3 bg-surface-base shadow-2xl'
          : 'pointer-events-none fixed bottom-0 end-0 size-px border-0 opacity-0'
      "
      :aria-hidden="!vendorVisible"
      :tabindex="vendorVisible ? 0 : -1"
      data-testid="ziwo-frame"
    />

    <div
      v-if="isZiwoEnabled && vendorVisible"
      class="fixed bottom-4 end-4 z-[60] flex w-[min(22.5rem,calc(100vw-1rem))] items-center justify-between gap-2 rounded-lg border border-outline-gray-3 bg-surface-base px-3 py-2 text-p-sm text-ink-gray-8 shadow-2xl"
      data-testid="ziwo-vendor-bar"
    >
      <span
        class="min-w-0 truncate"
        :class="needsLink ? 'text-ink-amber-8' : 'text-ink-gray-6'"
        data-testid="ziwo-bar-status"
      >
        {{ barStatus }}
      </span>
      <div class="flex shrink-0 items-center gap-1">
        <Button
          size="sm"
          :label="__('Call & ticket')"
          :title="__('Link this call to a ticket, or end it.')"
          data-testid="ziwo-open-helpdesk"
          @click="showCallTicket"
        >
          <template v-if="needsLink" #suffix>
            <span
              class="size-2 rounded-full bg-surface-amber-3"
              data-testid="ziwo-bar-attention"
            />
          </template>
        </Button>
        <Button
          size="sm"
          variant="ghost"
          icon="lucide-x"
          :aria-label="__('Hide')"
          data-testid="ziwo-vendor-hide"
          @click="closePanel"
        />
      </div>
    </div>

    <div
      v-if="
        isZiwoEnabled &&
        vendorVisible &&
        (view.unsaved.count || view.unparsedEvents)
      "
      class="fixed end-4 top-14 z-[70] w-[min(22.5rem,calc(100vw-1rem))] space-y-1 rounded-lg border border-outline-gray-3 bg-surface-red-2 p-3 text-p-sm text-ink-red-6 shadow-2xl"
      role="alert"
      data-testid="ziwo-vendor-alert"
    >
      <template v-if="view.unsaved.count">
        <div>
          {{
            __("{0} call event(s) are not saved in Helpdesk.", [
              view.unsaved.count,
            ])
          }}
          <span v-if="view.unsaved.error">{{ view.unsaved.error }}</span>
        </div>
        <div v-if="view.unsaved.permanent">
          {{
            __("{0} will not be retried automatically.", [
              view.unsaved.permanent,
            ])
          }}
        </div>
        <div class="text-ink-red-5">
          {{ __("Keep this page open. Events are retried while it is.") }}
        </div>
        <Button
          size="sm"
          :label="__('Retry now')"
          data-testid="ziwo-vendor-retry-unsaved"
          @click="controller.retryUnsaved()"
        />
      </template>
      <div v-if="view.unparsedEvents" class="text-ink-amber-8">
        {{
          __(
            "{0} call event(s) could not be read because they had no call id.",
            [view.unparsedEvents]
          )
        }}
      </div>
    </div>

    <section
      v-if="isZiwoEnabled && open"
      class="fixed bottom-4 end-4 z-50 flex h-[560px] max-h-[calc(100dvh-3rem)] w-[min(22.5rem,calc(100vw-1rem))] flex-col overflow-hidden rounded-2xl border border-outline-gray-2 bg-surface-base text-start text-p-sm text-ink-gray-8 shadow-2xl"
      :class="vendorVisible ? 'hidden' : ''"
      role="dialog"
      aria-label="Call & ticket"
      data-testid="ziwo-panel"
    >
      <header class="flex shrink-0 items-center gap-2 border-b border-outline-gray-1 px-4 py-3">
        <LucidePhone class="size-4 shrink-0 text-ink-gray-7" />
        <h2 class="min-w-0 flex-1 truncate text-base font-medium text-ink-gray-9">
          {{ __("Call & ticket") }}
        </h2>
        <span
          class="flex max-w-[9rem] items-center gap-1.5 truncate text-p-xs text-ink-gray-7"
          data-testid="ziwo-status"
          aria-live="polite"
        >
          <span
            class="size-2 shrink-0 rounded-full"
            :class="presenceDot"
            data-testid="ziwo-status-dot"
          />
          {{ presenceLabel }}
        </span>
        <button
          type="button"
          class="flex size-7 items-center justify-center rounded text-ink-gray-6 hover:bg-surface-gray-2"
          :class="showDetails ? 'bg-surface-gray-2 text-ink-gray-9' : ''"
          :aria-label="__('Connection details')"
          :aria-pressed="showDetails"
          data-testid="ziwo-details-toggle"
          @click="showDetails = !showDetails"
        >
          <LucideInfo class="size-4" />
        </button>
        <button
          type="button"
          class="flex size-7 items-center justify-center rounded text-ink-gray-6 hover:bg-surface-gray-2"
          :aria-label="__('Hide')"
          data-testid="ziwo-hide"
          @click="closePanel"
        >
          <LucideX class="size-4" />
        </button>
      </header>

      <div class="min-h-0 flex-1 space-y-3 overflow-y-auto px-4 py-3">
        <div
          v-if="view.unsaved.count"
          class="space-y-1 rounded bg-surface-red-2 p-2 text-ink-red-6"
          role="alert"
          data-testid="ziwo-unsaved"
        >
          <div>
            {{
              __("{0} call event(s) are not saved in Helpdesk.", [
                view.unsaved.count,
              ])
            }}
            <span v-if="view.unsaved.error">{{ view.unsaved.error }}</span>
          </div>
          <div v-if="view.unsaved.permanent">
            {{
              __("{0} will not be retried automatically.", [
                view.unsaved.permanent,
              ])
            }}
          </div>
          <div class="text-ink-red-5">
            {{ __("Keep this page open. Events are retried while it is.") }}
          </div>
          <Button
            size="sm"
            :label="__('Retry now')"
            data-testid="ziwo-retry-unsaved"
            @click="controller.retryUnsaved()"
          />
        </div>

        <div
          v-if="view.unparsedEvents"
          class="rounded bg-surface-amber-2 p-2 text-ink-amber-8"
          data-testid="ziwo-unparsed"
        >
          {{
            __(
              "{0} call event(s) could not be read because they had no call id.",
              [view.unparsedEvents]
            )
          }}
        </div>

        <div
          v-if="view.sdk === 'loading' || view.sdk === 'idle'"
          class="text-ink-gray-6"
          data-testid="ziwo-sdk-loading"
        >
          {{ __("Starting the softphone…") }}
        </div>
        <div
          v-else-if="view.sdk === 'failed'"
          class="space-y-2"
          data-testid="ziwo-sdk-failed"
        >
          <p class="text-ink-red-6">{{ view.sdkError }}</p>
          <Button size="sm" :label="__('Retry')" @click="retrySdk" />
        </div>
        <p
          v-if="view.authError"
          class="text-ink-red-6"
          data-testid="ziwo-auth-error"
        >
          {{ view.authError }}
        </p>
        <div
          v-if="presence === 'reconnecting'"
          class="flex items-center justify-between gap-2 rounded bg-surface-amber-2 p-2 text-ink-amber-8"
        >
          <span>{{ __("Reconnecting to ZIWO.") }}</span>
          <Button
            size="sm"
            :label="__('Reconnect')"
            data-testid="ziwo-reconnect"
            @click="onReconnect"
          />
        </div>

        <p v-if="view.session !== 'signed-in'" class="text-ink-gray-6">
          {{ __("Sign in and change your status in the ZIWO panel.") }}
        </p>
        <p v-if="view.intent" class="text-ink-gray-6" data-testid="ziwo-intent">
          <template v-if="view.intent.state === 'uncertain'">
            {{
              __(
                "ZIWO did not confirm the last call attempt. Check the ZIWO panel before dialing again."
              )
            }}
            <Button
              size="sm"
              class="mt-1"
              :label="__('I checked, allow dialing again')"
              data-testid="ziwo-ack"
              @click="controller.acknowledgeUncertain()"
            />
          </template>
          <template v-else-if="view.intent.error">
            {{
              __(
                "ZIWO reported: {0}. Waiting a few seconds to be sure no call was placed.",
                [view.intent.error]
              )
            }}
          </template>
          <template v-else>{{ __("Placing the call…") }}</template>
        </p>
        <p v-if="view.dialError" class="text-ink-red-6" data-testid="ziwo-dial-error">
          {{ view.dialError }}
        </p>
        <div
          v-if="newerCall"
          class="flex items-center justify-between gap-2 rounded-md bg-surface-gray-1 px-2 py-1.5"
          data-testid="ziwo-new-call"
        >
          <span class="min-w-0 truncate">
            {{
              __("New call from {0}", [
                callerName(newerCall) || newerCall.number || __("Unknown number"),
              ])
            }}
          </span>
          <button
            type="button"
            class="shrink-0 rounded text-ink-violet-6 hover:text-ink-violet-8"
            data-testid="ziwo-switch-call"
            @click="switchToCall(newerCall.callId)"
          >
            {{ __("Switch") }}
          </button>
        </div>

        <!-- The call this panel is pinned to. A new call does not replace it while a draft is open. -->
        <div v-if="focus" class="space-y-3" data-testid="ziwo-call-screen">
          <div class="flex items-center justify-between gap-3">
            <span class="flex min-w-0 items-center gap-2 font-medium text-ink-gray-9">
              <span class="size-2 shrink-0 rounded-full" :class="callDot" />
              <span class="truncate">{{ callHeading }}</span>
            </span>
            <span
              class="w-12 shrink-0 text-end tabular-nums text-ink-gray-6"
              dir="ltr"
              data-testid="ziwo-call-timer"
            >
              {{ callTimer || "0:00" }}
            </span>
          </div>
          <div class="flex items-center gap-3">
            <span
              class="flex size-10 shrink-0 items-center justify-center rounded-full bg-surface-violet-2 text-xs font-medium text-ink-violet-7"
              aria-hidden="true"
            >
              {{ initials(callerName(focus) || focus.number) }}
            </span>
            <div class="min-w-0">
              <div class="truncate font-medium text-ink-gray-9" data-testid="ziwo-live-number">
                {{ callerName(focus) || focus.number || __("Unknown number") }}
              </div>
              <div
                v-if="callerName(focus) && focus.number"
                class="truncate text-ink-gray-6"
                dir="ltr"
              >
                {{ focus.number }}
              </div>
            </div>
          </div>

          <button
            v-if="answerInZiwo"
            type="button"
            class="flex h-11 w-full items-center justify-center rounded-xl border border-outline-gray-2 font-medium text-ink-gray-8 hover:bg-surface-gray-1 focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-outline-gray-3"
            data-testid="ziwo-answer-in-ziwo"
            @click="showZiwo"
          >
            {{ __("Answer in the ZIWO panel") }}
          </button>
          <Button
            v-else-if="endVisible"
            class="!h-11 !w-full !rounded-xl"
            variant="subtle"
            theme="red"
            :label="focus.ending ? __('Ending…') : __('End call')"
            :disabled="!canEnd"
            :loading="focus.ending"
            data-testid="ziwo-hangup"
            @click="onHangup"
          >
            <template #prefix>
              <LucidePhoneOff class="size-4" />
            </template>
          </Button>
          <p v-if="focus.endError" class="text-ink-red-6" data-testid="ziwo-end-error">
            {{ __(focus.endError) }}
          </p>

          <section class="space-y-2 border-t border-outline-gray-1 pt-3" data-testid="ziwo-customer">
            <div
              v-if="focus.ticket"
              class="flex items-center justify-between gap-2 rounded-xl border border-outline-gray-2 px-3 py-2"
              data-testid="ziwo-linked-ticket"
            >
              <span class="min-w-0 truncate">
                <span class="font-medium text-ink-gray-9">#{{ focus.ticket }}</span>
                <template v-if="linkedTicket(focus)">
                  <span class="ms-1.5 text-ink-gray-7">{{ linkedTicket(focus)?.subject }}</span>
                </template>
              </span>
              <router-link
                class="shrink-0 rounded-full bg-surface-violet-2 px-2.5 py-1 text-p-xs font-medium text-ink-violet-7"
                data-testid="ziwo-open-ticket"
                :to="{ name: 'TicketAgent', params: { ticketId: focus.ticket } }"
              >
                {{ __("Open ticket") }}
              </router-link>
            </div>
            <div
              v-else-if="focus.contact"
              class="flex items-center justify-between gap-2 rounded-xl border border-outline-gray-2 px-3 py-2"
              data-testid="ziwo-linked-contact"
            >
              <span class="min-w-0 truncate">
                <span class="font-medium text-ink-gray-9">{{ __("Outreach call") }}</span>
                <span class="ms-1.5 text-ink-gray-7">{{ callerLabel(focus) || focus.contact }}</span>
              </span>
              <router-link
                v-if="focus.status === 'ended' && focus.logName"
                class="shrink-0 rounded-full bg-surface-violet-2 px-2.5 py-1 text-p-xs font-medium text-ink-violet-7"
                data-testid="ziwo-record-outcome"
                :to="{ name: 'Contact', params: { id: focus.contact }, query: { call: focus.logName } }"
              >
                {{ __("Record outcome") }}
              </router-link>
            </div>
            <div
              v-else-if="ringPreview(focus)"
              class="truncate rounded-xl border border-outline-gray-2 px-3 py-2 text-ink-gray-8"
              data-testid="ziwo-ticket-preview"
            >
              <span class="font-medium text-ink-gray-9">#{{ ringPreview(focus)?.name }}</span>
              {{ ringPreview(focus)?.subject }}
            </div>
            <p
              v-if="focus.ticket && focus.panel?.link_source === 'Originating ticket'"
              class="text-ink-gray-6"
            >
              {{ __("This call was started from this ticket.") }}
            </p>
            <p
              v-else-if="focus.originError"
              class="text-ink-amber-8"
              data-testid="ziwo-origin-error"
            >
              {{
                __("This call could not be linked to ticket #{0}: {1}.", [
                  focus.originTicket,
                  originReason(focus.originError),
                ])
              }}
            </p>
            <p v-else-if="focus.originTicket && !focus.logName" class="text-ink-gray-6">
              {{ __("Linking to ticket #{0}…", [focus.originTicket]) }}
            </p>
            <p
              v-else-if="!focus.logName"
              class="text-ink-gray-6"
              data-testid="ziwo-link-unavailable"
            >
              {{
                __(
                  "This call is not saved in Helpdesk yet, so linking and creating a ticket are unavailable until the call event is saved."
                )
              }}
            </p>
            <p
              v-if="focus.ticket && focus.panel?.link_source === 'Originating ticket'"
              class="text-ink-gray-6"
            >
              {{ __("This call was started from this ticket.") }}
            </p>
            <div v-if="needsContactChoice(focus)" class="space-y-1">
              <div class="text-ink-gray-6">
                {{ __("This number matches several contacts. Choose one.") }}
              </div>
              <div
                v-for="c in callerContacts(focus)"
                :key="c.name"
                class="flex items-center justify-between gap-2"
              >
                <span class="truncate">{{ c.label }}</span>
                <Button
                  size="sm"
                  :label="__('Use')"
                  :disabled="!focus.logName"
                  :data-testid="`ziwo-use-contact-${c.name}`"
                  @click="useContact(focus.callId, c.name)"
                />
              </div>
            </div>

            <template v-if="showTicketTools(focus)">
              <div class="font-medium text-ink-gray-9">
                {{ unknownCaller(focus) ? __("Find a ticket") : __("Suggested ticket") }}
              </div>
              <div v-if="ticketChoices(focus).length" class="space-y-1.5">
                <div
                  v-for="t in ticketChoices(focus)"
                  :key="t.name"
                  class="flex items-center justify-between gap-2 rounded-xl border px-3 py-2"
                  :class="
                    draft.pending?.name === t.name
                      ? 'border-surface-violet-4 bg-surface-violet-1'
                      : 'border-outline-gray-2'
                  "
                >
                  <button
                    type="button"
                    class="min-w-0 flex-1 truncate text-start"
                    :data-testid="`ziwo-pick-ticket-${t.name}`"
                    @click="draft.pending = t"
                  >
                    <span class="font-medium">#{{ t.name }}</span> {{ t.subject }}
                  </button>
                  <router-link
                    class="shrink-0 text-p-xs text-ink-violet-6"
                    :to="{ name: 'TicketAgent', params: { ticketId: t.name } }"
                  >
                    {{ __("Open") }}
                  </router-link>
                </div>
              </div>
              <p
                v-else-if="!unknownCaller(focus) && (focus.panel?.call_log || focus.lookup)"
                class="rounded-xl border border-dashed border-outline-gray-2 px-3 py-3 text-center text-ink-gray-5"
              >
                {{ __("No open tickets for this contact.") }}
              </p>
              <form
                v-if="unknownCaller(focus)"
                class="flex gap-2"
                data-testid="ziwo-ticket-search"
                @submit.prevent="onSearch"
              >
                <input
                  v-model="draft.searchQuery"
                  class="min-w-0 flex-1 rounded-xl border border-outline-gray-2 px-3 py-2"
                  :placeholder="__('Ticket number or subject')"
                  :aria-label="__('Find a ticket')"
                  autocomplete="off"
                  data-testid="ziwo-ticket-query"
                />
                <Button
                  size="sm"
                  :label="__('Search')"
                  type="submit"
                  :loading="draft.searching"
                  data-testid="ziwo-ticket-search-submit"
                />
              </form>
              <p
                v-if="unknownCaller(focus) && draft.searchEmpty"
                class="rounded-xl border border-dashed border-outline-gray-2 px-3 py-4 text-center text-ink-gray-6"
                data-testid="ziwo-ticket-search-empty"
              >
                {{ __("No matching ticket you can edit.") }}
              </p>
              <div
                v-if="draft.pending && !focus.ticket"
                class="space-y-2 rounded-xl bg-surface-gray-1 p-2.5"
                data-testid="ziwo-link-confirm"
              >
                <p>{{ __("Link this call to ticket #{0}?", [draft.pending.name]) }}</p>
                <div class="flex gap-2">
                  <Button
                    class="!h-10 flex-1 !rounded-xl !bg-surface-violet-6 !text-ink-violet-1 hover:!bg-surface-violet-7"
                    variant="solid"
                    :label="__('Link ticket')"
                    :loading="draft.linking"
                    data-testid="ziwo-link-confirm-button"
                    @click="linkTicket"
                  />
                  <Button
                    class="!h-10"
                    variant="ghost"
                    :label="__('Cancel')"
                    @click="draft.pending = null"
                  />
                </div>
              </div>
              <Button
                class="!h-10 !w-full !rounded-xl"
                variant="outline"
                theme="gray"
                :label="__('Create ticket')"
                data-testid="ziwo-create-ticket"
                @click="draft.showCreate = !draft.showCreate"
              />
              <form
                v-if="draft.showCreate"
                class="space-y-2"
                data-testid="ziwo-create-form"
                @submit.prevent="onCreate"
              >
                <p class="text-ink-gray-5">
                  {{ __("Status and the other ticket defaults come from Helpdesk.") }}
                </p>
                <input
                  v-model="draft.subject"
                  class="w-full rounded border border-outline-gray-2 px-2 py-1"
                  :placeholder="__('Subject')"
                  :aria-label="__('Subject')"
                  maxlength="140"
                  required
                  data-testid="ziwo-create-subject"
                />
                <textarea
                  v-model="draft.summary"
                  class="w-full rounded border border-outline-gray-2 px-2 py-1"
                  rows="3"
                  :placeholder="__('Short summary of the issue')"
                  :aria-label="__('Short summary of the issue')"
                  required
                  data-testid="ziwo-create-summary"
                />
                <label
                  v-for="field in focus.panel?.fields || []"
                  :key="field.fieldname"
                  class="block space-y-1"
                >
                  <span class="text-ink-gray-6">{{ field.label }}</span>
                  <select
                    v-if="field.fieldtype === 'Select'"
                    v-model="draft.fields[field.fieldname]"
                    class="w-full rounded border border-outline-gray-2 px-2 py-1"
                    :aria-label="field.label"
                    :data-testid="`ziwo-create-field-${field.fieldname}`"
                  >
                    <option value="">{{ __("Select") }}</option>
                    <option
                      v-for="option in selectOptions(field.options)"
                      :key="option"
                      :value="option"
                    >
                      {{ option }}
                    </option>
                  </select>
                  <input
                    v-else
                    v-model="draft.fields[field.fieldname]"
                    class="w-full rounded border border-outline-gray-2 px-2 py-1"
                    :aria-label="field.label"
                    :data-testid="`ziwo-create-field-${field.fieldname}`"
                  />
                </label>
                <div class="flex gap-2">
                  <Button
                    size="sm"
                    variant="solid"
                    :label="__('Create and link')"
                    type="submit"
                    :loading="draft.creating"
                    :disabled="draft.creating"
                    data-testid="ziwo-create-submit"
                  />
                  <Button
                    size="sm"
                    variant="ghost"
                    :label="__('Cancel')"
                    type="button"
                    @click="draft.showCreate = false"
                  />
                </div>
              </form>
            </template>
            <p v-else-if="focus.lookupError" class="text-ink-gray-5">
              {{ focus.lookupError }}
            </p>
            <p v-if="focus.panelError" class="text-ink-red-6">{{ focus.panelError }}</p>
            <p v-if="draft.error" class="text-ink-red-6" data-testid="ziwo-link-error">
              {{ draft.error }}
            </p>

            <div
              v-if="focus.status === 'ended'"
              class="flex flex-wrap items-center gap-2"
              data-testid="ziwo-after-call"
            >
              <span
                v-if="focusBadge && focusBadge.kind !== 'observed'"
                class="inline-flex items-center rounded-md px-2 py-1 text-p-xs"
                :class="
                  focusBadge.kind === 'confirmed'
                    ? 'bg-surface-green-2 text-ink-green-3'
                    : 'bg-surface-gray-2 text-ink-gray-7'
                "
                :data-testid="
                  focusBadge.kind === 'confirmed'
                    ? 'ziwo-confirmed'
                    : 'ziwo-reconciliation'
                "
              >
                {{ __(focusBadge.label) }}
              </span>
              <ZiwoRecordingPlayer
                v-if="focusRow && offerRecording(focusRow)"
                :call="focusRow.name"
              />
            </div>

            <form
              v-if="focus.status === 'ended' && focus.ticket"
              class="space-y-2"
              data-testid="ziwo-note"
              @submit.prevent="saveNote"
            >
              <label class="block font-medium text-ink-gray-9" for="ziwo-internal-note">
                {{ __("Internal note") }}
              </label>
              <textarea
                id="ziwo-internal-note"
                v-model="draft.note"
                class="w-full rounded border border-outline-gray-2 px-2 py-1"
                rows="3"
                :placeholder="__('Add a note...')"
                :aria-label="__('Internal note')"
                data-testid="ziwo-note-text"
              />
              <p v-if="draft.noteError" class="text-ink-red-6" role="alert">{{ draft.noteError }}</p>
              <div class="flex justify-end">
                <Button
                  type="submit"
                  variant="solid"
                  size="sm"
                  :class="
                    draft.note.trim() && !draft.savingNote
                      ? '!bg-surface-violet-6 !text-ink-violet-1 hover:!bg-surface-violet-7'
                      : ''
                  "
                  :label="__('Save note')"
                  :loading="draft.savingNote"
                  :disabled="draft.savingNote || !draft.note.trim()"
                  data-testid="ziwo-save-note"
                />
              </div>
            </form>
          </section>
        </div>
        <p v-else class="text-ink-gray-6" data-testid="ziwo-no-call">
          {{
            __(
              "No call in progress. Calls are placed and answered in the ZIWO panel."
            )
          }}
        </p>

        <details
          v-if="showDetails"
          open
          class="rounded-lg bg-surface-gray-1 p-2.5 text-p-xs text-ink-gray-6"
          data-testid="ziwo-diagnostics"
          @toggle="onDetailsToggle"
        >
          <summary class="cursor-pointer font-medium text-ink-gray-7">
            {{ __("Connection details") }}
          </summary>
          <div class="mt-1.5 space-y-1">
            <p v-if="ziwoConfig?.expected_caller_id">
              {{
                __(
                  "Caller ID: ZIWO applies its own default ({0}). Helpdesk does not set it.",
                  [ziwoConfig.expected_caller_id]
                )
              }}
            </p>
            <p v-if="ziwoConfig?.provider_agent_name || ziwoConfig?.queue_label">
              {{
                __("Agent {0}, queue {1}", [
                  ziwoConfig?.provider_agent_name || "—",
                  ziwoConfig?.queue_label || "—",
                ])
              }}
            </p>
            <p v-for="(line, index) in restLines" :key="index" data-testid="ziwo-rest-status">
              {{ line }}
            </p>
            <p v-if="view.session === 'signed-in'">
              {{
                __("Connection: {0} (status text is not documented by ZIWO).", [
                  view.connection,
                ])
              }}
            </p>
            <div v-if="view.sdkMessages.length" data-testid="ziwo-sdk-messages">
              <p>{{ __("Recent messages from ZIWO:") }}</p>
              <p
                v-for="(line, index) in view.sdkMessages"
                :key="index"
                class="break-all font-mono text-xs"
              >
                {{ line }}
              </p>
            </div>
            <p
              v-if="view.lastEventShape"
              class="break-all font-mono text-xs"
              data-testid="ziwo-last-event-shape"
            >
              {{ view.lastEventShape }}
            </p>
            <p>
              {{
                __(
                  "ZIWO keeps its own sign-in in this browser. Sign out on a shared computer."
                )
              }}
            </p>
          </div>
        </details>
      </div>

      <div class="shrink-0 border-t border-outline-gray-1 px-3 pb-2 pt-2 text-center">
        <button
          type="button"
          class="text-p-xs text-ink-violet-6 hover:text-ink-violet-8 focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-outline-gray-3 disabled:cursor-not-allowed disabled:text-ink-gray-4"
          data-testid="ziwo-show-vendor"
          :disabled="!canShowVendor"
          @click="showZiwo"
        >
          {{ __("Open ZIWO panel") }}
        </button>
      </div>
    </section>
  </Teleport>
</template>

<script setup lang="ts">
import {
  ZiwoController,
  type ActionResult,
  type CallView,
  type TicketChoice,
} from "@/composables/ziwoCall/controller";
import {
  offerRecording,
  reconciliationBadge,
  restStatusLines,
  type HistoryRow,
} from "@/composables/ziwoCall/history";
import {
  errorMessage,
  internalNoteHtml,
  presenceKind,
  type PresenceKind,
} from "@/composables/ziwoCall/logic";
import { useTelephonyStore } from "@/stores/telephony";
import { __ } from "@/translation";
import { useIntervalFn } from "@vueuse/core";
import { Button, Tooltip, call, toast } from "frappe-ui";
import { storeToRefs } from "pinia";
import { computed, onBeforeUnmount, onMounted, reactive, ref, shallowRef, watch } from "vue";
import LucideInfo from "~icons/lucide/info";
import LucidePhone from "~icons/lucide/phone";
import LucidePhoneOff from "~icons/lucide/phone-off";
import LucideX from "~icons/lucide/x";
import ZiwoRecordingPlayer from "./ZiwoRecordingPlayer.vue";

const API = "inchaa_custmization.integrations.ziwo.api.";
const SDK_START_TIMEOUT_MS = 30000;

interface CallDraft {
  logName: string;
  searchQuery: string;
  searchResults: TicketChoice[];
  searchEmpty: boolean;
  pending: TicketChoice | null;
  showCreate: boolean;
  subject: string;
  summary: string;
  fields: Record<string, string>;
  note: string;
  error: string;
  noteError: string;
  linking: boolean;
  creating: boolean;
  searching: boolean;
  savingNote: boolean;
}

function emptyDraft(): CallDraft {
  return {
    logName: "",
    searchQuery: "",
    searchResults: [],
    searchEmpty: false,
    pending: null,
    showCreate: false,
    subject: "",
    summary: "",
    fields: {},
    note: "",
    error: "",
    noteError: "",
    linking: false,
    creating: false,
    searching: false,
    savingNote: false,
  };
}

function draftIsOpen(held: CallDraft | undefined): boolean {
  if (!held) return false;
  const typed = Object.values(held.fields).some((value) => value.trim());
  return Boolean(
    held.pending ||
      held.showCreate ||
      held.subject.trim() ||
      held.summary.trim() ||
      typed ||
      held.note.trim() ||
      held.searchQuery.trim() ||
      held.searchResults.length ||
      held.error ||
      held.noteError ||
      held.linking ||
      held.creating ||
      held.searching ||
      held.savingNote
  );
}

function clearTicketDraft(held: CallDraft) {
  held.pending = null;
  held.showCreate = false;
  held.subject = "";
  held.summary = "";
  held.fields = {};
  held.searchQuery = "";
  held.searchResults = [];
  held.searchEmpty = false;
  held.error = "";
}

const store = useTelephonyStore();
const { isZiwoEnabled, ziwoConfig, ziwoHistoryVersion } = storeToRefs(store);

const controller = new ZiwoController({
  post: (method, args) => call(`${API}${method}`, args),
  onChange: () => {
    view.value = controller.snapshot();
  },
  onPersisted: () => store.bumpZiwoHistory(),
});
const view = shallowRef(controller.snapshot());

const open = ref(false);
const vendorVisible = ref(false);
const showDetails = ref(false);
const dialing = ref(false);
const ticketCallId = ref("");
const drafts = reactive(new Map<string, CallDraft>());
const fallbackDraft = emptyDraft();
const announcedRings = new Set<string>();
const wrapUpId = ref("");
const focusRow = ref<HistoryRow | null>(null);

const hostPageUrl = computed(() => ziwoConfig.value?.host_page_url || "");
const canShowVendor = computed(
  () => Boolean(hostPageUrl.value) && view.value.sdk !== "failed"
);
const restLines = computed(() =>
  restStatusLines(ziwoConfig.value?.rest).map((line) => __(line))
);
const draft = computed(() => drafts.get(ticketCallId.value) ?? fallbackDraft);

const frame = ref<HTMLIFrameElement | null>(null);
const frameKey = ref(0);
let sdkWatch: ReturnType<typeof setInterval> | undefined;

function readyWindow(): any | null {
  try {
    const win: any = frame.value?.contentWindow;
    if (win?.ZIWO?.session && win?.ZIWO?.calls) return win;
  } catch {
    // The frame is not loaded yet, or is not same-origin. Treated as not ready.
  }
  return null;
}

function stopSdkWatch() {
  if (sdkWatch) clearInterval(sdkWatch);
  sdkWatch = undefined;
}

function startSdkWatch() {
  stopSdkWatch();
  controller.detach();
  controller.setSdkLoading();
  const started = Date.now();
  let reported = false;
  sdkWatch = setInterval(() => {
    const win = readyWindow();
    if (win) {
      stopSdkWatch();
      controller.attach(win);
      return;
    }
    // Keep watching after the warning. The loader can finish just after 30 seconds,
    // and stopping here left a ready softphone stuck on the failure message.
    if (!reported && Date.now() - started > SDK_START_TIMEOUT_MS) {
      reported = true;
      controller.setSdkFailed(
        __(
          "The ZIWO softphone did not start within 30 seconds. Check that this network allows static.ziwo.io, plugin.ziwo.io and integrations.ziwo.run, then retry."
        )
      );
    }
  }, 250);
}

watch(frame, (element) => {
  if (element) startSdkWatch();
});

watch(isZiwoEnabled, (enabled) => {
  if (!enabled) {
    stopSdkWatch();
    controller.detach();
  }
});

function retrySdk() {
  const win = readyWindow();
  if (win) {
    stopSdkWatch();
    controller.attach(win);
    return;
  }
  frameKey.value += 1;
}

function showZiwo() {
  open.value = true;
  vendorVisible.value = canShowVendor.value;
  void store.fetchZiwoStatus();
}

function showCallTicket() {
  open.value = true;
  vendorVisible.value = false;
  void store.fetchZiwoStatus();
}

function onDetailsToggle(event: Event) {
  if ((event.target as HTMLDetailsElement | null)?.open)
    void store.fetchZiwoStatus();
}

watch(
  () => view.value.sdk,
  (sdk) => {
    if (sdk === "failed") vendorVisible.value = false;
  }
);

function closePanel() {
  open.value = false;
  vendorVisible.value = false;
}

function togglePanel() {
  if (open.value) closePanel();
  else showZiwo();
}

function onReconnect() {
  act(controller.reconnect());
}

function act(result: ActionResult) {
  if (!result.ok && result.error) toast.error(result.error);
}

function draftFor(callId: string): CallDraft {
  let held = drafts.get(callId);
  if (!held) {
    held = emptyDraft();
    drafts.set(callId, held);
  }
  return held;
}

function switchToCall(callId: string) {
  ticketCallId.value = callId;
}

/**
 * Ticket call button. Sign-in is checked before any dial. Once the agent is signed in,
 * Call runs the existing dispatch once, and the ticket stays with that request.
 */
async function makeOutgoingCall(
  number: string,
  options: { ticket?: string; contact?: string } = {}
) {
  const ready =
    view.value.session === "signed-in" &&
    view.value.sdk === "ready" &&
    Boolean(number);
  if (!ready) {
    showZiwo();
    toast.error(__("Sign in to ZIWO, then press Call again."));
    return;
  }
  if (dialing.value) return;
  dialing.value = true;
  try {
    const result = await controller.dial(number, {
      ticket: options.ticket || "",
      contact: options.contact || "",
    });
    if (!result.ok && result.error) toast.error(result.error);
  } finally {
    dialing.value = false;
  }
  showZiwo();
}

function onHangup() {
  const call = focus.value;
  if (!call || !canEnd.value) return;
  act(controller.hangup(call.callId));
}

async function useContact(callId: string, contact: string) {
  const call = view.value.calls.find((item) => item.callId === callId);
  const callLog = call?.logName || "";
  const held = draftFor(callId);
  if (!callLog) return;
  held.logName = callLog;
  held.error = "";
  held.pending = null;
  const result = await controller.chooseContact(callId, contact, { callLog });
  const same = drafts.get(callId);
  if (same && !result.ok) same.error = result.error || "";
}

async function linkTicket() {
  const call = focus.value;
  if (!call) return;
  const callId = call.callId;
  const callLog = call.logName;
  const held = drafts.get(callId);
  const ticket = held?.pending?.name || "";
  if (!held || held.linking || !callLog || !ticket) return;
  held.logName = callLog;
  held.linking = true;
  held.error = "";
  const result = await controller.linkTicket(callId, ticket, { callLog });
  const same = drafts.get(callId);
  if (!same) return;
  same.linking = false;
  if (!result.ok) {
    same.error = result.error || "";
    return;
  }
  clearTicketDraft(same);
}

async function onSearch() {
  const call = focus.value;
  if (!call) return;
  const callId = call.callId;
  const callLog = call.logName;
  const held = drafts.get(callId);
  if (!held || held.searching || !callLog) return;
  const query = held.searchQuery;
  held.logName = callLog;
  held.searching = true;
  held.error = "";
  held.searchEmpty = false;
  const result = await controller.searchTickets(callId, query, { callLog });
  const same = drafts.get(callId);
  if (!same) return;
  same.searching = false;
  if (!result.ok) {
    same.error = result.error || "";
    same.searchResults = [];
    return;
  }
  same.searchResults = result.tickets || [];
  same.searchEmpty = !same.searchResults.length;
  same.pending = null;
}

async function onCreate() {
  const call = focus.value;
  if (!call) return;
  const callId = call.callId;
  const callLog = call.logName;
  const held = drafts.get(callId);
  if (!held || held.creating || !callLog) return;
  const subject = held.subject;
  const description = held.summary;
  const values = { ...held.fields };
  held.logName = callLog;
  held.creating = true;
  held.error = "";
  const result = await controller.createTicket(
    callId,
    { subject, description, values },
    { callLog }
  );
  const same = drafts.get(callId);
  if (!same) return;
  same.creating = false;
  if (!result.ok) {
    same.error = result.error || "";
    return;
  }
  clearTicketDraft(same);
}

async function saveNote() {
  const call = focus.value;
  const ticket = call?.ticket;
  if (!call || !ticket) return;
  const callId = call.callId;
  const held = drafts.get(callId);
  if (!held || held.savingNote || !held.note.trim()) return;
  const text = held.note;
  held.savingNote = true;
  held.noteError = "";
  try {
    await call("run_doc_method", {
      dt: "HD Ticket",
      dn: ticket,
      method: "new_comment",
      args: { content: internalNoteHtml(text), attachments: [] },
    });
    const same = drafts.get(callId);
    if (same && same.note === text) same.note = "";
  } catch (error) {
    const same = drafts.get(callId);
    if (same) {
      same.note = text;
      same.noteError = errorMessage(error, __("The note could not be saved."));
    }
  } finally {
    const same = drafts.get(callId);
    if (same) same.savingNote = false;
  }
}

const liveCalls = computed(() =>
  view.value.calls.filter((item) => item.status !== "ended")
);
const live = computed<CallView | null>(
  () => view.value.ringingCall ?? liveCalls.value[0] ?? null
);
const focus = computed<CallView | null>(
  () => view.value.calls.find((item) => item.callId === ticketCallId.value) ?? null
);
const wrapUp = computed(
  () => view.value.calls.find((item) => item.callId === wrapUpId.value) ?? null
);
const naturalId = computed(
  () => (live.value ?? view.value.calls[0] ?? null)?.callId ?? ""
);

watch(naturalId, (id) => {
  if (!id) return;
  if (!ticketCallId.value || ticketCallId.value === id) {
    ticketCallId.value = id;
    return;
  }
  if (draftIsOpen(drafts.get(ticketCallId.value))) return;
  ticketCallId.value = id;
});

watch(ticketCallId, (id) => {
  if (id) draftFor(id);
  controller.pin(id || null);
});

watch(
  () => view.value.calls.map((item) => item.callId).join("\n"),
  () => {
    const ids = new Set(view.value.calls.map((item) => item.callId));
    for (const [id, held] of [...drafts.entries()]) {
      if (!ids.has(id) && !draftIsOpen(held)) drafts.delete(id);
    }
    if (ticketCallId.value && !ids.has(ticketCallId.value)) {
      if (!draftIsOpen(drafts.get(ticketCallId.value)))
        ticketCallId.value = naturalId.value;
    }
  }
);

watch(
  () => view.value.calls.map((item) => `${item.callId}:${item.status}`).join(","),
  (next, previous) => {
    if (!previous) return;
    const before = new Map(
      previous
        .split(",")
        .filter(Boolean)
        .map((part) => {
          const splitAt = part.lastIndexOf(":");
          return [part.slice(0, splitAt), part.slice(splitAt + 1)] as const;
        })
    );
    for (const item of view.value.calls) {
      const prior = before.get(item.callId);
      if (item.status === "ended" && prior && prior !== "ended")
        wrapUpId.value = item.callId;
    }
  }
);

const newerCall = computed(() => {
  const current = live.value;
  if (!current || current.callId === ticketCallId.value) return null;
  if (!draftIsOpen(drafts.get(ticketCallId.value))) return null;
  return current;
});

const needsLink = computed(() => {
  const unlinked = (item?: { ticket?: string; contact?: string } | null) =>
    Boolean(item && !item.ticket && !item.contact);
  if (liveCalls.value.some((item) => unlinked(item))) return true;
  if (unlinked(wrapUp.value)) return true;
  for (const held of drafts.values()) if (draftIsOpen(held)) return true;
  return false;
});

const barStatus = computed(() => {
  const current = liveCalls.value[0];
  if (current) {
    if (current.ticket) return __("Linked to ticket #{0}", [current.ticket]);
    if (current.contact) return __("Outreach call");
    if (current.originTicket && !current.originError)
      return __("Linking to ticket #{0}…", [current.originTicket]);
    if (current.originContact && !current.originContactError)
      return __("Linking to contact…");
    return __("Not linked to a ticket yet");
  }
  if (wrapUp.value && !wrapUp.value.ticket && !wrapUp.value.contact)
    return __("Call ended, not linked");
  if (view.value.session === "signed-in")
    return __("Signed in as {0}", [view.value.agentName]);
  if (view.value.sdk === "loading" || view.value.sdk === "idle")
    return __("Starting the softphone…");
  return __("Not signed in");
});

const answerInZiwo = computed(() => {
  const item = focus.value;
  const current = live.value;
  return Boolean(
    item &&
      current &&
      item.callId === current.callId &&
      item.status === "ringing" &&
      item.direction !== "Outbound"
  );
});

const endVisible = computed(() => {
  const item = focus.value;
  const current = live.value;
  if (!item || !current || item.callId !== current.callId) return false;
  if (item.status === "ended") return false;
  if (item.ending) return true;
  if (item.status === "ringing" && item.direction !== "Outbound") return false;
  return item.status === "active" || item.direction === "Outbound";
});

const canEnd = computed(() => {
  const item = focus.value;
  if (!endVisible.value || !item || item.ending) return false;
  if (view.value.session !== "signed-in" || view.value.sdk !== "ready") return false;
  if (item.status === "active") return true;
  return item.status === "ringing" && item.direction === "Outbound";
});

const toggleLabel = computed(() =>
  view.value.session === "signed-in"
    ? __("Phone, signed in as {0}", [view.value.agentName])
    : __("Phone, not signed in")
);

const presence = computed<PresenceKind>(() =>
  presenceKind({
    sdk: view.value.sdk,
    session: view.value.session,
    connection: view.value.connection,
    ziwoStatus: view.value.ziwoStatus,
  })
);

const presenceLabel = computed(() => {
  if (presence.value === "available") return __("Available");
  if (presence.value === "connecting") return __("Connecting");
  if (presence.value === "reconnecting") return __("Reconnecting");
  if (presence.value === "signed-out") return __("Signed out");
  return view.value.ziwoStatus.trim() || __("Unavailable");
});

const presenceDot = computed(() => {
  if (presence.value === "available") return "bg-surface-green-6";
  if (presence.value === "connecting" || presence.value === "reconnecting")
    return "bg-surface-amber-3 animate-pulse";
  return "bg-ink-gray-4";
});

const indicator = computed(() => {
  if (view.value.ringingCall) return "bg-surface-red-7 animate-pulse";
  if (view.value.unsaved.count) return "bg-surface-red-7";
  if (presence.value === "available") return "bg-surface-green-6";
  if (view.value.session === "signed-in") return "bg-surface-amber-3";
  return "";
});

const now = ref(Date.now());
const { pause, resume } = useIntervalFn(() => (now.value = Date.now()), 1000, {
  immediate: false,
});
watch(
  () => liveCalls.value.length,
  (count) => (count ? resume() : pause()),
  { immediate: true }
);

function elapsed(since: number | null) {
  if (!since) return "";
  const seconds = Math.max(0, Math.floor((now.value - since) / 1000));
  return `${Math.floor(seconds / 60)}:${String(seconds % 60).padStart(2, "0")}`;
}

const callHeading = computed(() => {
  const item = focus.value;
  if (!item) return "";
  if (item.status === "ended") return __("Call ended");
  if (item.status === "active") return item.held ? __("On hold") : __("In call");
  return item.direction === "Outbound" ? __("Calling…") : __("Incoming");
});

const callTimer = computed(() => {
  const item = focus.value;
  if (!item) return "";
  if (item.status === "ended") {
    const start = item.answeredAt || item.startedAt;
    const end = item.endedAt || now.value;
    if (!start) return "";
    const seconds = Math.max(0, Math.floor((end - start) / 1000));
    return `${Math.floor(seconds / 60)}:${String(seconds % 60).padStart(2, "0")}`;
  }
  if (item.status === "active") return elapsed(item.answeredAt || item.startedAt);
  return elapsed(item.startedAt);
});

const callDot = computed(() => {
  if (focus.value?.status === "ended") return "bg-surface-red-5";
  if (focus.value?.status === "active") return "bg-surface-green-3";
  return "bg-surface-amber-3 animate-pulse";
});

const focusBadge = computed(() =>
  focusRow.value ? reconciliationBadge(focusRow.value) : null
);

function callerName(item: CallView | null) {
  if (!item) return "";
  if (item.panel?.call_log && item.panel.contact?.label) return item.panel.contact.label;
  const contacts = callerContacts(item);
  const chosen = item.contact ? contacts.find((c) => c.name === item.contact) : null;
  if (chosen) return chosen.label;
  return contacts.length === 1 && !item.contact ? contacts[0]!.label : "";
}

function callerContacts(item: CallView) {
  if (item.panel?.call_log) return item.panel.contacts || [];
  return item.lookup?.contacts ?? [];
}

function needsContactChoice(item: CallView) {
  if (item.ticket || item.contact) return false;
  if (item.panel?.call_log) return Boolean(item.panel.needs_contact);
  return callerContacts(item).length > 1;
}

function unknownCaller(item: CallView) {
  if (needsContactChoice(item)) return false;
  if (item.panel?.call_log) return Boolean(item.panel.unknown_caller);
  return Boolean(item.lookup && !item.lookup.contacts.length);
}

function canOfferTickets(item: CallView) {
  return Boolean(item.logName && !item.ticket && !needsContactChoice(item));
}

function showTicketTools(item: CallView) {
  return (item.status === "active" || item.status === "ended") && canOfferTickets(item);
}

function ringPreview(item: CallView): TicketChoice | null {
  if (item.status !== "ringing" || item.ticket) return null;
  return ticketChoices(item)[0] ?? null;
}

function linkedTicket(item: CallView) {
  return item.panel?.ticket?.name === item.ticket ? item.panel.ticket : null;
}

function ticketChoices(item: CallView): TicketChoice[] {
  if (!canOfferTickets(item)) return [];
  if (unknownCaller(item)) return drafts.get(item.callId)?.searchResults ?? [];
  if (item.panel?.call_log) return item.panel.tickets || [];
  const contact =
    item.contact ||
    (callerContacts(item).length === 1 ? callerContacts(item)[0]!.name : "");
  if (!contact) return [];
  return (item.lookup?.tickets ?? []).filter((t) => t.contact === contact);
}

function selectOptions(options?: string) {
  return (options || "")
    .split("\n")
    .map((option) => option.trim())
    .filter(Boolean);
}

function originReason(code: string) {
  const reasons: Record<string, string> = {
    not_permitted: __("you may not edit it"),
    ticket_not_found: __("it was not found"),
    contact_mismatch: __("it belongs to a different contact"),
  };
  return reasons[code] || code;
}

function initials(label: string) {
  const parts = label.trim().split(/\s+/).filter(Boolean).slice(0, 2);
  if (!parts.length) return "#";
  const letters = parts.map((part) => part[0] || "").join("");
  return /[0-9+]/.test(letters) ? "#" : letters.toUpperCase();
}

let focusToken = 0;
async function loadFocusContext() {
  const logName = focus.value?.logName;
  if (!isZiwoEnabled.value || !open.value || vendorVisible.value) return;
  if (!logName) {
    focusRow.value = null;
    return;
  }
  const mine = ++focusToken;
  try {
    const rows = await call<HistoryRow[]>(`${API}get_call_history`, { limit: 20 });
    if (mine !== focusToken) return;
    focusRow.value = (rows || []).find((row) => row.name === logName) || null;
  } catch {
    if (mine !== focusToken) return;
    focusRow.value = null;
  }
}

watch(
  [open, vendorVisible, () => focus.value?.logName, ziwoHistoryVersion],
  () => void loadFocusContext()
);

watch(
  () => view.value.ringingCall?.callId || "",
  (id) => {
    if (!id || announcedRings.has(id)) return;
    announcedRings.add(id);
    showZiwo();
  }
);

function warnBeforeLeaving(event: BeforeUnloadEvent) {
  if (view.value.unsaved.count) {
    event.preventDefault();
    event.returnValue = "";
  }
}

onMounted(() => window.addEventListener("beforeunload", warnBeforeLeaving));

onBeforeUnmount(() => {
  window.removeEventListener("beforeunload", warnBeforeLeaving);
  stopSdkWatch();
  controller.dispose();
});

defineExpose({ makeOutgoingCall });
</script>
