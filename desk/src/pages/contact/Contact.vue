<template>
  <div
    class="flex h-full flex-col overflow-y-hidden max-w-screen-xl mx-auto w-full"
  >
    <LayoutHeader>
      <template #left-header>
        <Breadcrumbs :items="breadcrumbs" class="-ml-[2px]" />
      </template>
    </LayoutHeader>
    <div
      class="gap-5 flex flex-col flex-1 min-h-0"
      v-if="!contact.loading && contact.doc"
    >
      <!-- ContactInfo -->
      <PageInfo
        :avatar="{
          label: `${contact.doc.full_name}`.trim(),
          image: contact.doc.image ?? undefined,
          shape: 'circle',
        }"
        :doc-info="contactInfo"
        :badge="invitationBadge"
      >
        <template #actions>
          <div class="flex gap-2 items-center">
            <ContactCallButton
              :contact-id="id"
              :phones="phones"
              :shared="outreach.data?.shared_contacts || []"
              :last-outcome="outreach.data?.summary?.inchaa_last_outcome || ''"
            />
            <Button
              variant="subtle"
              @click="showEditDialog = true"
              v-if="hasPermission()"
            >
              <div class="flex gap-1 items-center">
                <LucideSquarePen class="h-4 w-4" />
                <span>{{ __("Edit") }}</span>
              </div>
            </Button>
            <Dropdown
              :options="dropdownActions"
              align="end"
              v-if="hasPermission()"
            >
              <Button icon="lucide-more-horizontal" variant="subtle" />
            </Dropdown>
          </div>
        </template>
      </PageInfo>
      <div class="flex flex-wrap items-center gap-3 px-5">
        <span
          v-for="customer in companyTypes"
          :key="customer.name"
          class="rounded bg-surface-gray-2 px-2 py-0.5 text-sm text-ink-gray-7"
        >
          {{ customer.name }}
          <template v-if="customer.company_type">
            · {{ customer.company_type }}
          </template>
        </span>
        <ContactOutreachSummary :summary="outreach.data?.summary" />
      </div>
      <div
        v-if="outreach.data?.open_callback"
        class="mx-5 flex flex-wrap items-center justify-between gap-2 rounded-4 border border-outline-gray-1 bg-surface-elevation-2 px-4 py-3"
      >
        <div>
          <p class="font-medium text-ink-gray-9">{{ __("Follow-up due") }}</p>
          <p class="text-sm text-ink-gray-7">
            {{ formatWhen(outreach.data.open_callback.due_at) }}
            — {{ outreach.data.open_callback.summary }}
          </p>
        </div>
      </div>
      <div class="overflow-y-auto overscroll-y-contain flex-1 flex flex-col">
        <TicketStats :dt="'Contact'" :dn="id" v-if="!isMobileView" />
        <Tabs
          v-model="activeTab"
          :tabs="tabs"
          size="md"
          class="tabs-sticky-header flex-1 overflow-hidden [&_[role='tablist']]:!bg-surface-base [&_[role='tablist']]:px-5 [&_[role='tablist']]:py-1.5 max-sm:[&_[role='tablist']]:px-3 [&_[role='tabpanel'][data-state='active']]:flex-1 [&_[role='tabpanel'][data-state='active']]:flex [&_[role='tabpanel'][data-state='active']]:flex-col [&_[role='tabpanel'][data-state='active']]:overflow-auto [&_[role='tabpanel'][data-state='active']]:min-h-0"
        >
          <template #tab-label="{ tab }: any">
            <span class="group flex items-center gap-2">
              {{ __(tab.label) }}
              <Badge
                class="group-hover:bg-surface-gray-10 !bg-surface-gray-2 !text-ink-gray-7"
                variant="solid"
                theme="gray"
                size="sm"
              >
                {{ tab.count }}
              </Badge>
            </span>
          </template>
          <template #tab-panel="{ tab }">
            <div class="p-5 flex flex-col flex-1 min-h-0">
              <TicketsTab
                v-if="tab.label === __('Tickets')"
                :ticketsListResource="ticketsListResource"
                :ticketsCountResource="ticketsCountResource"
                :baseFilter="{ contact: props.id }"
                :additionalFilter="
                (contactInfoResource.data?.customers?.length ?? 0) > 1
                  ? {
                      key: 'customer',
                      placeholder: __('Customer'),
                      doctype: 'HD Customer',
                      filters: {
                        name: ['in', contactInfoResource.data.customers.map((c: { name: string }) => c.name)],
                      },
                    }
                  : undefined
              "
              />
              <div v-if="tab.label === __('Feedback')">
                <!-- Feedback tab content -->
                <ContactFeedback :name="props.id" />
              </div>
              <ContactCalls
                v-if="tab.label === __('Calls')"
                :calls="outreach.data?.calls || []"
                :loading="outreach.loading && !outreach.data"
                :error="outreach.error?.messages?.[0] || ''"
                @record="openOutcome"
              />
            </div>
          </template>
        </Tabs>
      </div>
    </div>
    <DeleteWithTicketsDialog
      v-model="showDeleteDialog"
      :name="id"
      link-field="contact"
      :message="
        __(
          'Are you sure you want to delete this contact? The contact will be permanently deleted and unlinked from any associated customers and tickets.'
        )
      "
      :on-delete="handleDelete"
    />
    <MergeContactDialog
      v-if="isManager"
      v-model:open="showMergeDialog"
      :source="id"
      :source-label="contact.doc?.full_name || id"
    />
    <EditContactDialog
      v-if="showEditDialog"
      v-model="showEditDialog"
      :name="id"
    />
    <ContactCallOutcomeDialog
      v-model:open="outcomeOpen"
      :contact="id"
      :call-log="outcomeCall?.name || ''"
      :timezone="outreach.data?.site_timezone"
      :ticket="outcomeCall?.ticket || outcomeCall?.outcome_ticket || ''"
      :disposition="outcomeCall?.outcome || ''"
      :note="outcomeCall?.outcome_note || ''"
      :zoho-lead-entered="Boolean(outcomeCall?.zoho_lead_entered)"
      @saved="onOutcomeSaved"
    />
  </div>
</template>

<script setup lang="ts">
import ContactCallButton from "@/components/contact/ContactCallButton.vue";
import ContactCallOutcomeDialog from "@/components/contact/ContactCallOutcomeDialog.vue";
import ContactCalls from "@/components/contact/ContactCalls.vue";
import ContactCustomers from "@/components/contact/ContactCustomers.vue";
import ContactFeedback from "@/components/contact/ContactFeedback.vue";
import ContactOutreachSummary from "@/components/contact/ContactOutreachSummary.vue";
import TicketsTab from "@/components/customer/TicketsTab.vue";
import DeleteWithTicketsDialog from "@/components/DeleteWithTicketsDialog.vue";
import ModifiedIcon from "@/components/icons/ModifiedIcon.vue";
import TicketFeedbackIcon from "@/components/icons/TicketFeedbackIcon.vue";
import TicketHashIcon from "@/components/icons/TicketHashIcon.vue";
//@ts-ignore
import EditContactDialog from "@/components/contact/EditContactDialog.vue";
import MergeContactDialog from "@/components/contact/MergeContactDialog.vue";
import { useAuthStore } from "@/stores/auth";
import LayoutHeader from "@/components/LayoutHeader.vue";
import PageInfo from "@/components/PageInfo.vue";
import {
  useContact,
  useContactFeedback,
  useContactInvite,
  useContactResetPassword,
} from "@/composables/contact";
import { useScreenSize } from "@/composables/screen";
import { useTelephonyStore } from "@/stores/telephony";
import { __ } from "@/translation";
import { hasPermission } from "@/utils";
import { storeToRefs } from "pinia";
import {
  Breadcrumbs,
  Button,
  Dropdown,
  Tabs,
  createResource,
  dayjs,
  usePageMeta,
} from "frappe-ui";
import {
  computed,
  h,
  markRaw,
  onBeforeUnmount,
  onMounted,
  ref,
  watch,
} from "vue";
import { useRoute, useRouter } from "vue-router";
import LucideMail from "~icons/lucide/mail";
import LucideMapPin from "~icons/lucide/map-pin";
import LucidePhone from "~icons/lucide/phone";

function formatWhen(value: string) {
  return dayjs(value).format("DD MMM YYYY, HH:mm");
}

function openOutcome(row: any) {
  outcomeCall.value = row;
  outcomeOpen.value = true;
  if (activeTab.value !== "calls") activeTab.value = "calls";
  if (route.query.call) {
    const query = { ...route.query };
    delete query.call;
    void router.replace({ query });
  }
}

async function onOutcomeSaved() {
  await outreach.reload();
  const query = { ...route.query };
  delete query.call;
  void router.replace({ query });
}
import LucideTrash2 from "~icons/lucide/trash-2";
import { getTicketListResource } from "../../stores/docTickets";

const props = defineProps<{
  id: string;
}>();

const route = useRoute();
const router = useRouter();
const { isMobileView } = useScreenSize();

const {
  doc: contact,
  contactInfoResource,
  handleDelete,
} = useContact(props.id);

const { feedbackCount } = useContactFeedback(props.id);

const { ticketsListResource, ticketsCountResource } = getTicketListResource();

const outreach = createResource({
  url: "inchaa_custmization.integrations.ziwo.api.get_contact_calls",
  method: "GET",
  params: { contact: props.id, limit: 50 },
  auto: true,
});
const outcomeOpen = ref(false);
const { isManager } = useAuthStore();
const showMergeDialog = ref(false);
const outcomeCall = ref<any>(null);

// The softphone saves call events while this page is open. Each save changes this Contact's
// calls and totals, so the list is reloaded. Saves arrive in bursts, so they become one reload.
const { ziwoHistoryVersion } = storeToRefs(useTelephonyStore());
let refreshTimer: ReturnType<typeof setTimeout> | undefined;
function scheduleRefresh() {
  clearTimeout(refreshTimer);
  refreshTimer = setTimeout(() => {
    if (outreach.loading) return scheduleRefresh();
    void outreach.reload();
  }, 800);
}
watch(ziwoHistoryVersion, scheduleRefresh);
onBeforeUnmount(() => clearTimeout(refreshTimer));
const phones = computed(() => {
  const numbers = (contact.doc?.phone_nos || [])
    .map((row: { phone?: string }) => (row.phone || "").trim())
    .filter(Boolean);
  const mobile = (contact.doc?.mobile_no || "").trim();
  if (mobile && !numbers.includes(mobile)) numbers.unshift(mobile);
  return [...new Set(numbers)];
});
const companyTypes = computed(
  () => contactInfoResource.data?.customers || []
);

const tabs = computed(() => [
  {
    label: __("Tickets"),
    value: "tickets",
    count: ticketsCountResource.data ?? 0,
    iconLeft: h(TicketHashIcon, { class: "size-4" }),
  },
  {
    label: __("Calls"),
    value: "calls",
    count: outreach.data?.summary?.inchaa_call_attempts ?? 0,
    iconLeft: h(LucidePhone, { class: "size-4" }),
  },
  {
    label: __("Feedback"),
    value: "feedback",
    count: feedbackCount.data ?? 0,
    iconLeft: h(TicketFeedbackIcon, { class: "size-4" }),
  },
]);

const activeTab = computed<string>({
  get() {
    const hash = route.hash.slice(1);
    const tab = tabs.value.find((t) => t.value === hash);
    return tab?.value ?? tabs.value[0].value;
  },
  set(value) {
    router.replace({ hash: value === tabs.value[0].value ? "" : `#${value}` });
  },
});

const contactInfo = computed(() => {
  if (
    contactInfoResource.loading ||
    !contactInfoResource.data ||
    !contact.doc?.name
  ) {
    return [];
  }
  const info = [
    {
      icon: markRaw(LucideMail),
      value: contact.doc?.email_id,
      condition: !!contact.doc?.email_id,
    },
    {
      icon: markRaw(LucidePhone),
      value: contact.doc?.mobile_no,
      condition: !!contact.doc?.mobile_no,
    },
    {
      icon: markRaw(LucideMapPin),
      value: contactInfoResource.data?.country,
      condition: !!contactInfoResource.data?.country,
    },
    {
      icon: markRaw(ModifiedIcon),
      value: __("Last seen {0}", [
        dayjs(contactInfoResource.data?.last_seen).fromNow(),
      ]),
      condition: !!contactInfoResource.data?.last_seen,
    },
    {
      component: markRaw(
        h(ContactCustomers, {
          customers: contactInfoResource.data?.customers ?? [],
        })
      ),
      condition: (contactInfoResource.data?.customers?.length ?? 0) > 0,
    },
  ];
  return info;
});

const { resendInvite, inviteAsUser } = useContactInvite();
const { resetPassword } = useContactResetPassword(() => contact.doc?.user);

const showEditDialog = ref(false);

const invitation = computed(() => contactInfoResource.data?.invitation);

const invitationBadge = computed(() => {
  const inv = invitation.value;
  if (!inv?.name) return null;
  if (inv.status === "Expired") {
    return {
      label: __("Invitation Expired"),
      theme: "red" as const,
      tooltip: __("Invitation expired. Resend to invite again."),
    };
  }
  return {
    label: __("Invited"),
    theme: "amber" as const,
    tooltip: __("Invite sent. Waiting for the user to accept."),
  };
});

const showDeleteDialog = ref(false);

const dropdownActions = computed(() => {
  const baseActions = [];
  if (!contact.doc?.user && !invitation.value?.name) {
    baseActions.push({
      label: __("Invite as User"),
      icon: "lucide-user-plus",
      onClick: async () => {
        await inviteAsUser(props.id, contact.doc?.email_id);
        contactInfoResource.reload();
      },
    });
  }
  if (invitation.value?.name) {
    baseActions.push({
      label: __("Resend Invite"),
      icon: "lucide-mail",
      onClick: async () => {
        await resendInvite(
          invitation.value!.name,
          invitation.value!.status,
          props.id,
          contact.doc?.email_id
        );
        contactInfoResource.reload();
      },
    });
  }
  if (contact.doc?.user) {
    baseActions.push({
      label: __("Send reset password email"),
      icon: "lucide-mail",
      onClick: () => {
        resetPassword();
      },
    });
  }
  return [
    {
      group: __("Actions"),
      hideLabel: true,
      options: baseActions,
    },
    {
      group: __("Danger"),
      hideLabel: true,
      options: [
        ...(isManager
          ? [
              {
                label: __("Merge into another contact"),
                icon: "lucide-git-merge",
                onClick: () => {
                  showMergeDialog.value = true;
                },
              },
            ]
          : []),
        {
          label: __("Delete"),
          icon: LucideTrash2,
          theme: "red",
          onClick: () => {
            showDeleteDialog.value = true;
          },
        },
      ],
    },
  ];
});

const breadcrumbs = [
  {
    label: __("Contacts"),
    route: { name: "ContactList" },
  },
  {
    label: props.id,
  },
];

let reloadedFor = "";
watch(
  () => [outreach.data, route.query.call, route.query.callback],
  () => {
    const callName = route.query.call;
    if (typeof callName !== "string" || !callName || !outreach.data?.calls) return;
    const row = outreach.data.calls.find((item: { name: string }) => item.name === callName);
    if (row) return openOutcome(row);
    // The call was saved after this list was loaded. Reload once per call, so a call that
    // belongs to someone else cannot cause a loop.
    if (reloadedFor !== callName && !outreach.loading) {
      reloadedFor = callName;
      void outreach.reload();
    }
  }
);

onMounted(() => {
  ticketsListResource.update({
    filters: {
      contact: props.id,
    },
  });
  ticketsListResource.fetch();
  ticketsCountResource.fetch();
});

usePageMeta(() => {
  return {
    title: `Contact: ${props.id}`,
  };
});
</script>

<style scoped>
/* frappe-ui's TabsRoot clips with overflow-hidden, which traps the sticky
   tablist. Let it overflow so the tablist sticks to the page scroll container. */
.tabs-sticky-header {
  overflow: visible !important;
}
/* Same for the tab panels, so sticky children (e.g. the ticket filter bar)
   can stick to the page scroll container instead of being clipped. */
.tabs-sticky-header :deep([role="tabpanel"]) {
  overflow: visible !important;
}
.tabs-sticky-header :deep([role="tablist"]) {
  position: sticky;
  top: 0;
  z-index: 10;
  background-color: white;
}
</style>
