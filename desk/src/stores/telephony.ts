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

export const useTelephonyStore = defineStore("telephony", {
  state: () => ({
    isLoading: false,
    isCallingEnabled: false,
    isTwilioEnabled: false,
    isExotelEnabled: false,
    // ZIWO is an optional custom-app-owned integration (inchaa_custmization).
    // Its enabled/usable state is fetched separately from that app's own API,
    // never from the `telephony` app, so this native app's behavior is
    // unaffected when the custom app or connector is absent/disabled.
    isZiwoEnabled: false,
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
        const data = await call(
          "inchaa_custmization.integrations.ziwo.api.get_config"
        );
        this.isZiwoEnabled = Boolean(data?.enabled && data?.can_use);
      } catch (error) {
        // The custom app providing ZIWO may not be installed/enabled; that is
        // a normal, expected state, not an error for the native call UI.
        this.isZiwoEnabled = false;
      }
    },
    setLinkDoc(params: SetLinkDocParams) {
      this.linkDoc.docname = params.docname;
      this.linkDoc.doctype = params.doctype;
    },
  },
});
