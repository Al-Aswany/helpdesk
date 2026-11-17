import { defineStore } from "pinia";
import { call } from "frappe-ui";

interface MakeCallParams {
  number?: string;
  doctype?: string;
  docname?: string;
}

interface SetLinkDocParams {
  docname: string;
  doctype: string;
}

/** Non-secret ZIWO settings the agent app may see. See inchaa_custmization ziwo.api.get_config. */
export interface ZiwoConfig {
  enabled: boolean;
  can_use: boolean;
  /** Managers may list every agent's calls on the Call Logs page. The server checks again. */
  can_view_all_calls?: boolean;
  host_page_url?: string;
  account_name_hint?: string;
  login_email_hint?: string;
  provider_agent_name?: string;
  queue_label?: string;
  expected_caller_id?: string;
  default_region?: string;
  rest?: {
    available: boolean;
    history: boolean;
    recordings: boolean;
    configured?: boolean;
    verified?: boolean;
    reason: string;
  };
}

export const useTelephonyStore = defineStore("telephony", {
  state: () => ({
    isLoading: false,
    isCallingEnabled: false,
    isTwilioEnabled: false,
    isExotelEnabled: false,
    // ZIWO is an optional custom-app integration (inchaa_custmization). Its state comes from
    // that app's own API, never from the `telephony` app, so Twilio/Exotel behave exactly as
    // before when the custom app or the connector is absent or disabled.
    isZiwoEnabled: false,
    isZiwoConnectorEnabled: false,
    ziwoCanViewAllCalls: false,
    // Set once the first answer (or failure) is in, so a page can tell "not known yet" from "off".
    ziwoStatusLoaded: false,
    ziwoConfig: null as ZiwoConfig | null,
    // Whether the server can play recordings (a server-side credential is stored). Any active
    // agent learns this, not only those who may use the softphone, because the ticket "Calls"
    // section is shown to all of them. `ziwoRecordingsReason` is fixed server text.
    isZiwoRecordingsEnabled: false,
    ziwoRecordingsReason: "",
    // Bumped after a call or a link is saved, so call lists know to refresh.
    ziwoHistoryVersion: 0,
    defaultCallingMedium: "",
    callMethod: (params: MakeCallParams) => {},
    linkDoc: {
      doctype: "",
      docname: "",
    },
  }),
  actions: {
    setMakeCall(value: (params: MakeCallParams) => void) {
      this.callMethod = value;
    },
    setDefaultCallingMedium(value: string) {
      this.defaultCallingMedium = value;
    },
    makeCall(params: MakeCallParams) {
      this.callMethod(params);
    },
    setIsCallingEnabled(value: boolean) {
      this.isCallingEnabled = value;
    },
    async fetchCallIntegrationStatus() {
      try {
        this.isLoading = true;
        const data = await call("telephony.api.is_call_integration_enabled");
        this.isTwilioEnabled = Boolean(data.twilio_enabled);
        this.isExotelEnabled = Boolean(data.exotel_enabled);
        this.defaultCallingMedium = data.default_calling_medium;
        this.isCallingEnabled = this.isTwilioEnabled || this.isExotelEnabled;
      } catch (error) {
        console.error("Failed to fetch call integration status:", error);
      } finally {
        this.isLoading = false;
      }
      await this.fetchZiwoStatus();
      this.isCallingEnabled =
        this.isTwilioEnabled || this.isExotelEnabled || this.isZiwoEnabled;
    },
    async fetchZiwoStatus() {
      try {
        const data = await call<ZiwoConfig>(
          "inchaa_custmization.integrations.ziwo.api.get_config"
        );
        this.isZiwoConnectorEnabled = Boolean(data?.enabled);
        this.isZiwoEnabled = Boolean(data?.enabled && data?.can_use);
        this.ziwoCanViewAllCalls = Boolean(
          data?.enabled && data?.can_view_all_calls
        );
        this.ziwoConfig = this.isZiwoEnabled ? data : null;
        this.isZiwoRecordingsEnabled = Boolean(
          data?.enabled && data?.rest?.recordings
        );
        this.ziwoRecordingsReason = data?.rest?.reason || "";
      } catch (error) {
        // The custom app may not be installed or the connector may be off. That is a
        // normal state, not an error for the native calling UI. It is only the first answer
        // that decides this: once ZIWO has been shown, a failed refresh (a network blip while
        // the panel opens, say) keeps what is there, because turning ZIWO off would remove the
        // SDK frame and end a live call.
        if (!this.ziwoStatusLoaded) {
          this.isZiwoConnectorEnabled = false;
          this.isZiwoEnabled = false;
          this.ziwoCanViewAllCalls = false;
          this.ziwoConfig = null;
          this.isZiwoRecordingsEnabled = false;
          this.ziwoRecordingsReason = "";
        }
      } finally {
        this.ziwoStatusLoaded = true;
      }
    },
    bumpZiwoHistory() {
      this.ziwoHistoryVersion += 1;
    },
    setLinkDoc(params: SetLinkDocParams) {
      this.linkDoc.docname = params.docname;
      this.linkDoc.doctype = params.doctype;
    },
  },
});
