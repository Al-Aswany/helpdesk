import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { test } from "node:test";

const read = (path: string) =>
  readFileSync(new URL(`../../src/${path}`, import.meta.url), "utf8");
const bytes = (path: string) =>
  readFileSync(new URL(`../../src/${path}`, import.meta.url));

const panel = read("components/telephony/ZiwoCallUI.vue");
const callUi = read("components/telephony/CallUI.vue");
const list = read("components/telephony/ZiwoCallList.vue");
const ticketCalls = read("components/ticket-agent/ZiwoTicketCalls.vue");
const details = read("components/ticket-agent/TicketDetailsTab.vue");
const header = read("components/layouts/AppHeader.vue");
const store = read("stores/telephony.ts");
const controller = read("composables/ziwoCall/controller.ts");
const player = read("components/telephony/ZiwoRecordingPlayer.vue");
const recording = read("composables/ziwoCall/recording.ts");
const history = read("composables/ziwoCall/history.ts");
const callLogs = read("pages/call-logs/CallLogs.vue");
const ziwoLogs = read("pages/call-logs/ZiwoCallLogs.vue");

/** The source with comments removed, so a rule is checked against code, not prose. */
function code(source: string) {
  return source
    .replace(/<!--[\s\S]*?-->/g, "")
    .replace(/\/\*[\s\S]*?\*\//g, "")
    .replace(/^\s*\/\/.*$/gm, "");
}

const NEW_FILES = [
  "components/telephony/ZiwoCallUI.vue",
  "components/telephony/ZiwoCallList.vue",
  "components/telephony/ZiwoRecordingPlayer.vue",
  "components/ticket-agent/ZiwoTicketCalls.vue",
  "composables/ziwoCall/logic.ts",
  "composables/ziwoCall/controller.ts",
  "composables/ziwoCall/recording.ts",
  "composables/ziwoCall/history.ts",
  "stores/telephony.ts",
  "components/telephony/CallUI.vue",
  "pages/call-logs/CallLogs.vue",
  "pages/call-logs/ZiwoCallLogs.vue",
];

test("every changed file is valid UTF-8 with no stray single bytes", () => {
  for (const path of NEW_FILES) {
    const buffer = bytes(path);
    assert.doesNotThrow(
      () => new TextDecoder("utf-8", { fatal: true }).decode(buffer),
      `${path} is not valid UTF-8`
    );
    assert.equal(buffer.includes(0x0d), false, `${path} has CR characters`);
    assert.equal(
      buffer.toString("utf8").includes("\ufffd"),
      false,
      `${path} contains the Unicode replacement character`
    );
  }
});

test("no credential or session value is kept in browser storage", () => {
  for (const [name, source] of [
    ["ZiwoCallUI.vue", panel],
    ["controller.ts", controller],
    ["ZiwoTicketCalls.vue", ticketCalls],
  ] as const) {
    const body = code(source);
    for (const store of [
      "localStorage",
      "sessionStorage",
      "indexedDB",
      "document.cookie",
    ]) {
      assert.equal(body.includes(store), false, `${name} uses ${store}`);
    }
  }
});

test("the session token and the password are never read or logged", () => {
  const body = code(panel) + code(controller);
  assert.equal(/\.token\b/.test(body), false, "reads session token");
  assert.equal(/ccLogin/.test(body), false);
  assert.equal(
    /console\.(log|info|debug|warn|error)/.test(body),
    false,
    "logs from the call code"
  );
});

test("the panel does not collect a ZIWO password; sign-in stays in the ZIWO panel", () => {
  const body = code(panel);
  assert.equal(/type="password"|ziwo-password|controller\.login\(/.test(body), false);
  assert.match(panel, /Open ZIWO panel/);
  assert.match(panel, /data-testid="ziwo-show-vendor"/);
  assert.match(panel, /@click="showZiwo"/);
  assert.match(body, /Sign in and change your status in the ZIWO panel/);
});

test("the panel never calls an SDK dial method itself", () => {
  const body = code(panel);
  assert.equal(
    /startCall|clickToCall|hangUpCall|answerCall|rejectCall/.test(body),
    false
  );
  assert.match(body, /controller\.dial\(/);
});

test("hiding the panel changes nothing about the session or the calls", () => {
  const body = code(panel);
  const close = body.slice(
    body.indexOf("function closePanel"),
    body.indexOf("function togglePanel")
  );
  assert.equal(/dispose|logout|detach|hangup|frameKey|password/.test(close), false);
  // The controller is torn down only when the whole component is removed.
  assert.equal((body.match(/controller\.dispose\(\)/g) ?? []).length, 1);
  const unmount = body.slice(body.indexOf("onBeforeUnmount"));
  assert.match(unmount, /controller\.dispose\(\)/);
  // The SDK frame does not depend on the panel being open.
  assert.match(panel, /v-if="isZiwoEnabled && hostPageUrl"/);
  assert.match(panel, /v-if="isZiwoEnabled && open"/);
});

test("the softphone lives in the persistent app header, so it survives ticket navigation", () => {
  assert.match(header, /<CallUI/);
  assert.match(callUi, /<ZiwoCallUI ref="ziwo" \/>/);
  // Not the ticket page: that is what unmounts on navigation.
  assert.equal(/ZiwoCallUI/.test(details), false);
});

test("the SDK address comes from the server, not from the desk bundle", () => {
  // No ZIWO URL and no loader file in the desk code. (The failure hint names hosts for the
  // network team to allow; that is text, not an address the bundle loads.)
  for (const source of [panel, controller]) {
    assert.equal(/https?:\/\/[^\s"'`]*ziwo/i.test(code(source)), false);
    assert.equal(
      /ziwo-bridge|ziwo\.plugin|ziwo\.polyfills/.test(code(source)),
      false
    );
  }
  assert.match(panel, /ziwoConfig\.value\?\.host_page_url/);
  assert.match(panel, /allow="microphone; autoplay"/);
});

test("each form action fires once: a submit button with no extra click handler", () => {
  assert.equal(/@click="onDial"|@click="onCreate"|@click="onSearch"/.test(panel), false);
  assert.equal(/@click="saveNote"/.test(panel), false);
  const note = panel.slice(panel.indexOf('data-testid="ziwo-note"'));
  assert.match(note.slice(0, note.indexOf("</form>")), /type="submit"/);
  const create = panel.slice(panel.indexOf('data-testid="ziwo-create-form"'));
  assert.match(create.slice(0, create.indexOf("</form>")), /type="submit"/);
});

test("ending a call goes through the controller with that call's own id", () => {
  const body = code(panel);
  assert.match(body, /controller\.hangup\(activeCall\.callId\)/);
  assert.match(panel, /Ending…/);
  assert.match(body, /if \(!activeCall \|\| !canEnd\.value\) return;/);
  assert.equal(
    /controller\.(answer|reject|toggleMute|toggleHold|sendDtmf)\(/.test(body),
    false
  );
});

test("saving problems are shown to the agent and cannot be hidden", () => {
  assert.match(panel, /data-testid="ziwo-unsaved"/);
  assert.match(panel, /role="alert"/);
  assert.match(panel, /controller\.retryUnsaved\(\)/);
  assert.match(panel, /beforeunload/);
  assert.match(panel, /data-testid="ziwo-unparsed"/);
  // The header indicator reflects it even while the panel is hidden.
  assert.match(
    panel,
    /view\.value\.unsaved\.count\) return "bg-surface-red-7"/
  );
});

test("a call is only linked by an explicit click, and the originating ticket is shown", () => {
  assert.match(panel, /@click="useContact\(focus\.callId, c\.name\)"/);
  // Selecting a ticket does not link it. A second click confirms.
  assert.match(panel, /@click="draft\.pending = t"/);
  assert.match(panel, /@click="linkTicket"/);
  assert.match(panel, /data-testid="ziwo-link-confirm"/);
  assert.match(panel, /data-testid="ziwo-create-ticket"/);
  assert.match(panel, /data-testid="ziwo-create-form"/);
  assert.match(panel, /data-testid="ziwo-link-unavailable"/);
  assert.match(panel, /data-testid="ziwo-open-ticket"/);
  assert.equal(/@click="linkTicket\(focus\.callId, t\.name\)"/.test(panel), false);
  assert.match(code(panel), /controller\.linkTicket\(callId, ticket, \{ callLog \}\)/);
  assert.match(panel, /data-testid="ziwo-origin-error"/);
  // Opening the ticket stays inside Helpdesk. The call panel does not navigate itself.
  assert.equal(/router\.push/.test(code(panel)), false);
  // Looking a number up never links anything.
  assert.equal(/link_call_ticket|set_call_contact|create_call_ticket/.test(code(panel)), false);
});

test("the ticket for an outgoing call is read once, from the click, and only for tickets", () => {
  assert.match(
    callUi,
    /const \{ doctype, docname \} = telephonyStore\.linkDoc/
  );
  assert.match(callUi, /ticket: doctype === "HD Ticket" \? docname : ""/);
  // A Contact page passes the contact the same way, and never as a ticket.
  assert.match(callUi, /contact: doctype === "Contact" \? docname : ""/);
});

test("Twilio and Exotel wiring is intact and ZIWO is only added", () => {
  assert.match(callUi, /<TwilioCallUI ref="twilio" \/>/);
  assert.match(callUi, /<ExotelCallUI ref="exotel" \/>/);
  assert.match(callUi, /twilio\.value\.setup\(\)/);
  assert.match(callUi, /exotel\.value\.setup\(props\.userEmail\)/);
  assert.match(callUi, /callMedium\.value !== "Ziwo"/);
  assert.match(store, /telephony\.api\.is_call_integration_enabled/);
  assert.match(store, /ziwo\.api\.get_config/);
  // Without ZIWO the dialog still offers the original two media.
  assert.match(
    callUi,
    /return options\.length \? options : \["Twilio", "Exotel"\]/
  );
});

test("the ticket sidebar keeps the company panel and gains the call history after it", () => {
  const company = details.indexOf("<InchaaCompanyPanel />");
  const calls = details.indexOf("<ZiwoTicketCalls />");
  assert.ok(company > 0 && calls > company);
  assert.match(details, /import InchaaCompanyPanel from/);
  assert.match(details, /import ZiwoTicketCalls from/);
});

test("the call history refreshes after saving and ignores answers for a ticket the agent left", () => {
  assert.match(ticketCalls, /ziwoHistoryVersion/);
  assert.match(ticketCalls, /if \(mine !== token\) return/);
  assert.match(ticketCalls, /isZiwoConnectorEnabled/);
  assert.match(controller, /this\.deps\.onPersisted\?\.\(\)/);
});

test("history rows say they are browser observations and hold no recording address", () => {
  assert.match(list, /__\("Observed"\)/);
  assert.match(list, /Not confirmed by ZIWO/);
  // The list never holds audio, a link or a credential. It only hosts the player.
  assert.equal(
    /\.mp3|<audio|recording_url|token|href=/i.test(code(list)),
    false
  );
  assert.match(
    list,
    /<ZiwoRecordingPlayer v-if="hasEnded\(row\)" :call="row\.name" \/>/
  );
  // Only a finished call is offered a recording, and playing says nothing about its outcome.
  assert.match(list, /row\.status === "Ended" && !row\.not_confirmed_ended/);
});

test("the list shows the browser's account and ZIWO's side by side, each labelled", () => {
  const body = code(list);
  // Both accounts of a confirmed call are on the row, and the browser's is named as such.
  assert.match(body, /data-testid="ziwo-evidence-browser"/);
  assert.match(body, /data-testid="ziwo-evidence-durations"/);
  assert.match(body, /data-testid="ziwo-evidence-checked"/);
  assert.match(body, /__\("Browser saw"\)/);
  assert.match(body, /__\("Last confirmed by ZIWO"\)/);
  // "Observed" is shown only while nothing from ZIWO has been attributed to this agent.
  assert.match(
    body,
    /<span\s+v-if="!isProviderConfirmed\(row\)"[\s\S]*?__\("Observed"\)/
  );
  // The reconciliation state has its own badge with its own test id per state.
  assert.match(body, /ziwo-reconciliation-\$\{badge\(row\)\.kind\}/);
});

test("provider values reach the list only through the tested helpers", () => {
  const body = code(list);
  // The list never reads a provider field itself, so it cannot blend or relabel one.
  assert.equal(
    /provider_(duration|talk|ring|hold|outcome|result|started|answered|ended|direction)/.test(
      body
    ),
    false
  );
  assert.match(body, /providerDurations/);
  assert.match(body, /providerOutcomeLabel/);
  assert.match(body, /reconciliationBadge/);
  // No total is computed here from other numbers, and nothing is called billable.
  assert.equal(/billable/i.test(body.replace(/<!--[\s\S]*?-->/g, "")), false);
  assert.equal(/reduce\(|\+ *row\./.test(body), false);
  // Durations in the helpers are labelled separately and never summed.
  const helper = code(history);
  assert.match(helper, /key: "total"/);
  assert.equal(/reduce\(|\+= *row\./.test(helper), false);
  assert.equal(/billable/i.test(helper), false);
  assert.equal(/\.mp3|recording_(url|file)|recordingFile/i.test(helper), false);
});

test("the manual check sends only the local call name and refreshes the lists", () => {
  const body = code(list);
  assert.match(
    body,
    /"inchaa_custmization\.integrations\.ziwo\.api\.reconcile_call",\s*\{ call: row\.name \}/
  );
  // No provider id, address or account is sent from the browser.
  assert.equal(
    /provider_call_id\s*[:,]/.test(
      body.slice(body.indexOf("async function check"))
    ),
    false
  );
  assert.match(body, /store\.bumpZiwoHistory\(\)/);
  assert.match(body, /v-if="canCheck\(row\)"/);
  // One check per row at a time, and the outcome is told to the agent where it happened.
  assert.match(body, /if \(checking\[row\.name\]\) return/);
  assert.match(body, /data-testid="ziwo-check-result"/);
  assert.match(body, /:role="results\[row\.name\]\.ok \? 'status' : 'alert'"/);
});

test("a provider record never decides audio: playback is still found by retrieving it", () => {
  const body = code(list) + code(history);
  assert.match(
    list,
    /<ZiwoRecordingPlayer v-if="hasEnded\(row\)" :call="row\.name" \/>/
  );
  // Ended means ended by the browser or by ZIWO's own record; never a recording field.
  assert.match(
    code(list),
    /\(row\.status === "Ended" && !row\.not_confirmed_ended\) \|\|\s*isProviderConfirmed\(row\)/
  );
  assert.equal(/recording_status\s*===\s*["']Available/.test(body), false);
  assert.equal(
    /recording_(url|file)|recordingFile|surveyRecording/i.test(body),
    false
  );
});

test("an older server that sends none of the provider fields still renders", () => {
  assert.match(history, /reconciliation_status\?:/);
  const body = code(history);
  // Every reader tolerates an absent field.
  assert.match(body, /row\.reconciliation_status \|\| "Not Checked"/);
  assert.match(body, /row\.provider_confirmed === true/);
});

test("the recording player talks only to the same-origin Helpdesk endpoint", () => {
  const body = code(player) + code(recording);
  assert.match(
    recording,
    /\/api\/method\/inchaa_custmization\.integrations\.ziwo\.api\.get_recording_audio/
  );
  // No absolute address, provider host, or credential name anywhere in the player code.
  assert.equal(/https?:\/\//i.test(body), false);
  assert.equal(
    /aswat|ziwo\.io|access_token|callHistory|Authorization/i.test(body),
    false
  );
  // The only thing sent is the local call name, from the row, never an id or address typed in.
  assert.match(player, /defineProps<\{ call: string \}>\(\)/);
  assert.match(player, /loadRecording\(props\.call/);
  assert.equal(
    /localStorage|sessionStorage|indexedDB|document\.cookie/.test(body),
    false
  );
  assert.equal(/console\.(log|info|debug|warn|error)/.test(body), false);
});

test("the player has Play and Pause, plays a Blob, and cleans up after itself", () => {
  assert.match(player, /__\("Play recording"\)/);
  assert.match(player, /__\("Pause recording"\)/);
  assert.match(player, /data-testid="ziwo-recording-toggle"/);
  assert.match(player, /@click="onToggle"/);
  assert.match(player, /URL\.createObjectURL\(blob\)/);
  assert.match(player, /:src="objectUrl"/);
  // Leaving the row stops the download and the sound and frees the audio.
  const unmount = code(player).slice(
    code(player).indexOf("onBeforeUnmount(() =>")
  );
  assert.match(unmount, /abort\?\.abort\(\)/);
  assert.match(unmount, /audio\.value\?\.pause\(\)/);
  assert.match(unmount, /URL\.revokeObjectURL\(objectUrl\.value\)/);
  // One recording at a time.
  assert.match(player, /playbackSlot\.claim\(slotHandle\)/);
});

test("playback is shown as not set up, and cannot be started, until the server says it can play", () => {
  assert.match(player, /:disabled="!recordingsEnabled"/);
  assert.match(player, /data-testid="ziwo-recording-unavailable"/);
  assert.match(
    player,
    /if \(!recordingsEnabled\.value \|\| state\.value === "loading"\) return;/
  );
  assert.match(store, /isZiwoRecordingsEnabled/);
  assert.match(
    store,
    /Boolean\(\s*data\?\.enabled && data\?\.rest\?\.recordings\s*\)/
  );
  // A failed config read turns it off again.
  const catchBlock = store.slice(
    store.indexOf("} catch (error) {\n        // The custom app")
  );
  assert.match(catchBlock, /this\.isZiwoRecordingsEnabled = false/);
});

test("playback failures are shown to the agent where they happen", () => {
  assert.match(player, /role="alert"/);
  assert.match(player, /data-testid="ziwo-recording-error"/);
  assert.match(player, /data-testid="ziwo-recording-none"/);
  assert.match(
    player,
    /state\.value = failure\?\.kind === "not-found" \? "none" : "error"/
  );
});

test("the player's position readout is not presented as a call duration", () => {
  // Neither the player nor its helpers read, show or write any call duration.
  const body = code(player) + code(recording);
  assert.equal(/duration|talk|billable/i.test(body), false);
  assert.equal(/observed_duration|provider_duration/.test(body), false);
  // The row's own "Answered, m:ss" still comes from the browser-observed figure alone.
  assert.match(code(list), /row\.observed_duration_seconds/);
  assert.equal(/provider_duration/.test(code(list)), false);
});

test("the phone panel is not offered to the browser as the Helpdesk login", () => {
  assert.equal(/type="password"|type="email"/.test(panel), false);
  assert.equal(
    /autocomplete="(current-password|username|email)"/.test(panel),
    false
  );
});

test("the phone icon, a new ring and a ticket call all use the same ZIWO open", () => {
  const body = code(panel);
  assert.match(
    body,
    /function showZiwo\(\) \{\s*open\.value = true;\s*vendorVisible\.value = canShowVendor\.value;/
  );
  assert.match(
    body,
    /const canShowVendor = computed\(\s*\(\) => Boolean\(hostPageUrl\.value\) && view\.value\.sdk !== "failed"/
  );
  assert.match(
    body,
    /function togglePanel\(\) \{\s*if \(open\.value\) closePanel\(\);\s*else showZiwo\(\);/
  );
  assert.match(
    body,
    /if \(!id \|\| announcedRings\.has\(id\)\) return;\s*announcedRings\.add\(id\);\s*showZiwo\(\);/
  );
  assert.match(body, /function makeOutgoingCall[\s\S]*showZiwo\(\);/);
  assert.match(panel, /data-testid="ziwo-vendor-bar"/);
  assert.match(panel, /data-testid="ziwo-open-helpdesk"/);
  assert.match(panel, /__\("Call & ticket"\)/);
  assert.match(panel, /@click="showCallTicket"/);
  assert.match(panel, /data-testid="ziwo-show-vendor"/);
  assert.match(panel, /Open ZIWO panel/);
  assert.match(panel, /@click="showZiwo"/);
  assert.match(panel, /data-testid="ziwo-vendor-hide"/);
  assert.equal(/data-testid="ziwo-dial"|data-testid="ziwo-recents"|data-testid="ziwo-contacts"/.test(panel), false);
});

test("ZIWO's own panel stays up after sign-in, and a failed SDK falls back to Helpdesk's panel", () => {
  const body = code(panel);
  // Nothing hides ZIWO's panel because the agent signed in (the old behaviour).
  assert.equal(
    /session === "signed-in"\) vendorVisible\.value = false/.test(body),
    false
  );
  assert.match(
    body,
    /watch\(\s*\(\) => view\.value\.sdk,\s*\(sdk\) => \{\s*if \(sdk === "failed"\) vendorVisible\.value = false;/
  );
  // Helpdesk's history is only loaded while Helpdesk's panel is the one showing.
  assert.match(body, /!open\.value \|\| vendorVisible\.value\) return;/);
});

test("the SDK frame is mounted for any permitted agent and never depends on a panel", () => {
  const frameTag = panel.slice(
    panel.indexOf("<iframe"),
    panel.indexOf("/>", panel.indexOf("<iframe"))
  );
  assert.match(frameTag, /v-if="isZiwoEnabled && hostPageUrl"/);
  assert.equal(
    /\bopen\b|vendorVisible && /.test(frameTag.split(":class")[0]),
    false
  );
  // Hiding only changes how it looks.
  assert.match(
    frameTag,
    /pointer-events-none fixed bottom-0 end-0 size-px border-0 opacity-0/
  );
  // Closing a panel never detaches, reloads or disposes the SDK; only leaving the app does.
  const close = code(panel).slice(
    code(panel).indexOf("function closePanel()"),
    code(panel).indexOf("function togglePanel()")
  );
  assert.equal(
    /detach|dispose|frameKey|logout|stopSdkWatch/.test(close),
    false
  );
  const bar = code(panel).slice(code(panel).indexOf("onBeforeUnmount(() =>"));
  assert.match(bar, /controller\.dispose\(\)/);
});

test("an incoming call opens ZIWO once, and Call & ticket only points back to it", () => {
  const body = code(panel);
  const rings = body.match(/showZiwo\(\);/g) || [];
  assert.ok(rings.length >= 3);
  assert.match(panel, /data-testid="ziwo-answer-in-ziwo"/);
  assert.match(panel, /@click="showZiwo"/);
  assert.equal(/data-testid="ziwo-answer"|data-testid="ziwo-reject"/.test(panel), false);
  assert.equal(/:disabled="!focus\.lookup"|:disabled="!live\.lookup"/.test(panel), false);
});

test("the ticket call button keeps its ticket and places one call", () => {
  const body = code(panel);
  const entry = body.slice(
    body.indexOf("async function makeOutgoingCall("),
    body.indexOf("function onHangup(")
  );
  assert.match(entry, /view\.value\.session === "signed-in"/);
  assert.match(entry, /view\.value\.sdk === "ready"/);
  assert.match(entry, /if \(!ready\) \{\s*showZiwo\(\);\s*toast\.error\(/);
  assert.match(entry, /if \(dialing\.value\) return;/);
  assert.match(
    entry,
    /controller\.dial\(number, \{\s*ticket: options\.ticket \|\| "",\s*contact: options\.contact \|\| "",?\s*\}\)/
  );
  assert.equal((entry.match(/controller\.dial\(/g) || []).length, 1);
  assert.match(entry, /showZiwo\(\);/);
  assert.match(entry, /toast\.error\(result\.error\)/);
  // CallUI passes the ticket only for a ticket, and only to ZIWO.
  assert.match(callUi, /ticket: doctype === "HD Ticket" \? docname : ""/);
});

test("the live call's link to a ticket is visible while ZIWO's panel is up", () => {
  assert.match(panel, /data-testid="ziwo-bar-status"/);
  assert.match(panel, /data-testid="ziwo-bar-attention"/);
  const body = code(panel);
  assert.match(
    body,
    /return __\("Linked to ticket #\{0\}", \[current\.ticket\]\)/
  );
  assert.match(body, /return __\("Not linked to a ticket yet"\)/);
  // The bar only reports; linking is still an explicit click in Helpdesk's panel.
  assert.equal(
    /linkTicket\(/.test(
      panel.slice(
        panel.indexOf('data-testid="ziwo-vendor-bar"'),
        panel.indexOf("<section")
      )
    ),
    false
  );
});

test("Details describe the settings the server reports now, never a stale sentence", () => {
  const body = code(panel);
  // The text comes from the server's flags, and the settings are read again when a panel
  // opens and when Details is opened.
  assert.match(body, /restStatusLines\(ziwoConfig\.value\?\.rest\)/);
  assert.equal(/ziwoConfig\?\.rest\?\.reason/.test(panel), false);
  assert.match(
    body,
    /function showZiwo\(\)[\s\S]*void store\.fetchZiwoStatus\(\)/
  );
  assert.match(
    body,
    /function onDetailsToggle\(event: Event\)[\s\S]*void store\.fetchZiwoStatus\(\)/
  );
  assert.match(panel, /@toggle="onDetailsToggle"/);
  // A failed refresh keeps what the page already shows, so the SDK frame is never removed by it.
  const failure = store.slice(
    store.indexOf("} catch (error) {\n        // The custom app")
  );
  assert.match(failure, /if \(!this\.ziwoStatusLoaded\) \{/);
});

test("a rejected sign-in explains itself, and the plugin's own lines are in Details", () => {
  assert.match(panel, /data-testid="ziwo-auth-error"/);
  assert.match(panel, /data-testid="ziwo-sdk-messages"/);
  assert.match(panel, /view\.sdkMessages/);
  assert.match(controller, /rejected this email or password/);
  assert.match(controller, /single sign-on/);
  // The controller reads the plugin's console by wrapping error() and still calls the original.
  assert.match(controller, /original\.apply\(target, args\)/);
});

test("the Call Logs page offers a ZIWO view, chosen by default only for permitted agents", () => {
  const body = code(callLogs);
  assert.match(body, /<ZiwoCallLogs v-else-if="activeView === 'ziwo'" \/>/);
  // The default is the ZIWO view for a permitted agent; a manager who is not one starts on the
  // standard page but may open the other; everyone else never sees the switch.
  assert.match(
    body,
    /chosenView\.value \?\? \(isZiwoEnabled\.value \? "ziwo" : "standard"\)/
  );
  assert.match(body, /if \(!canUseZiwoView\.value\) return "standard"/);
  assert.match(
    body,
    /isZiwoEnabled\.value \|\|\s*\(isZiwoConnectorEnabled\.value && ziwoCanViewAllCalls\.value\)/
  );
  assert.match(callLogs, /<TabButtons\s+v-if="canUseZiwoView"/);
  // Nothing is chosen before the first answer about ZIWO, so the page does not jump views.
  assert.match(callLogs, /v-if="!ziwoStatusLoaded"/);
  assert.match(store, /ziwoStatusLoaded: false/);
});

test("the standard Call Logs view is still the TP Call Log list, unchanged", () => {
  const body = code(callLogs);
  assert.match(body, /doctype: "TP Call Log"/);
  assert.match(
    body,
    /<ListViewBuilder\s+ref="listViewRef"\s+:options="options"\s+@row-click="openCallLog"/
  );
  assert.match(body, /<CallLogModal/);
  assert.match(body, /<CallLogDetailModal/);
  // Only the standard view can create a manual TP Call Log, and only it mounts the TP list.
  assert.match(
    callLogs,
    /v-if="activeView === 'standard'"\s+label="New Call Log"/
  );
  assert.match(callLogs, /<template v-else>\s*<ListViewBuilder/);
});

test("the ZIWO view reads the call log one server page at a time", () => {
  const body = code(ziwoLogs);
  assert.match(body, /get_call_log_page/);
  for (const param of [
    "page: page.value",
    "page_size: pageSize.value",
    "scope: scope.value",
  ])
    assert.ok(body.includes(param), `missing ${param}`);
  // The browser never asks for everything and slices it: one request, one page.
  assert.equal(/get_call_history|limit:/.test(body), false);
  assert.match(body, /PAGE_SIZES\.map/);
  // A changed filter starts at page one, before the loader runs; a stale answer is ignored.
  assert.match(
    body,
    /watch\(\[pageSize, direction, reconciliation, scope, appliedSearch\], \(\) => \{\s*page\.value = 1;/
  );
  assert.match(body, /if \(mine !== token\) return;/);
  // The search is debounced and the server decides what matches.
  assert.match(body, /useDebounceFn/);
});

test("the ZIWO view shows the fields an agent needs, labelled by where they came from", () => {
  for (const id of [
    "ziwo-log-time",
    "ziwo-log-direction",
    "ziwo-log-party",
    "ziwo-log-durations",
    "ziwo-log-ticket",
    "ziwo-log-recording",
    "ziwo-log-browser-duration",
  ])
    assert.ok(ziwoLogs.includes(`data-testid="${id}"`), `missing ${id}`);
  assert.match(ziwoLogs, /ziwo-log-outcome-provider/);
  assert.match(ziwoLogs, /ziwo-log-reconciliation-\$\{badge\(row\)\.kind\}/);
  const body = code(ziwoLogs);
  // Contact name, else the number; the browser's duration is always named as the browser's.
  assert.match(body, /row\.contact_label/);
  assert.match(body, /row\.customer_number_raw/);
  assert.match(ziwoLogs, /__\("Browser"\)/);
  assert.match(ziwoLogs, /__\("ZIWO"\)/);
  assert.match(
    body,
    /:to="\{ name: 'TicketAgent', params: \{ ticketId: row\.ticket \} \}"/
  );
  // The same helpers as the ticket's Calls section, so a row is read the same way everywhere.
  for (const helper of [
    "providerDurations",
    "providerOutcomeLabel",
    "reconciliationBadge",
    "isProviderConfirmed",
  ])
    assert.ok(body.includes(helper), `does not use ${helper}`);
});

test("recordings play through the existing player and authenticated endpoint", () => {
  assert.match(
    ziwoLogs,
    /<ZiwoRecordingPlayer v-if="hasEnded\(row\)" :call="row\.name" \/>/
  );
  const body = code(ziwoLogs);
  assert.equal(
    /get_recording|<audio|new Audio|createObjectURL/.test(body),
    false
  );
  assert.equal(/https?:\/\//i.test(body), false);
  assert.equal(
    /aswat|ziwo\.io|access_token|api_key|Authorization/i.test(body),
    false
  );
  assert.equal(
    /localStorage|sessionStorage|indexedDB|document\.cookie/.test(body),
    false
  );
  assert.equal(/console\.(log|info|debug|warn|error)/.test(body), false);
});

test("the ZIWO view refreshes when a call is saved and while recent calls are unsettled", () => {
  const body = code(ziwoLogs);
  assert.match(body, /watch\(ziwoHistoryVersion, \(\) => reloadSoon\(\)\)/);
  assert.match(body, /useIntervalFn/);
  assert.match(body, /!document\.hidden/);
  // Leaving the page stops the timer and drops a late answer.
  assert.match(
    body,
    /onBeforeUnmount\(\(\) => \{\s*token \+= 1;[\s\S]*pause\(\);/
  );
});

test("events that did not reach Helpdesk stay visible while ZIWO's own panel is showing", () => {
  assert.match(panel, /data-testid="ziwo-vendor-alert"/);
  const strip = panel.slice(
    panel.indexOf('data-testid="ziwo-vendor-alert"') - 400,
    panel.indexOf('data-testid="ziwo-vendor-alert"') + 1800
  );
  assert.match(strip, /vendorVisible &&/);
  assert.match(strip, /view\.unsaved\.count \|\| view\.unparsedEvents/);
  assert.match(strip, /role="alert"/);
  assert.match(strip, /controller\.retryUnsaved\(\)/);
  assert.match(strip, /not saved in Helpdesk/);
  // Helpdesk's panel keeps its own, in place.
  assert.match(panel, /data-testid="ziwo-unsaved"/);
});

test("ticket work stays on the call it was started for, and the frame is not rebuilt", () => {
  const body = code(panel);
  assert.match(body, /const callLog = activeCall\.logName/);
  assert.match(body, /controller\.linkTicket\(callId, ticket, \{ callLog \}\)/);
  assert.match(body, /controller\.createTicket\(\s*callId,/);
  assert.match(body, /\{ callLog \}/);
  assert.match(body, /const same = drafts\.get\(callId\)/);
  assert.match(body, /drafts = reactive\(new Map/);
  assert.match(body, /if \(draftIsOpen\(drafts\.get\(ticketCallId\.value\)\)\) return;/);
  assert.match(panel, /data-testid="ziwo-new-call"/);
  assert.match(panel, /data-testid="ziwo-switch-call"/);
  assert.match(body, /get_call_history/);
  assert.equal(/primaryCallId|primary_call_id/.test(body), false);
  assert.equal(/data-testid="ziwo-transfer"|data-testid="ziwo-dtmf"/.test(panel), false);
  assert.match(body, /method: "new_comment"/);
  assert.equal(/reply_via_agent|send_reply/.test(body), false);
  assert.match(body, /same\.note = text/);
  assert.match(body, /internalNoteHtml\(text\)/);
  assert.match(panel, /'ziwo-confirmed'/);
  assert.match(body, /focusBadge\.kind === 'confirmed'/);
  assert.match(body, /presenceKind\(/);
  assert.match(body, /ziwoStatus: view\.value\.ziwoStatus/);
  assert.match(body, /controller\.pin\(id \|\| null\)/);
  // Closing or switching panels does not rebuild the frame.
  assert.equal(/frameKey\.value \+= 1/.test(body.slice(body.indexOf("function closePanel"))), false);
  assert.equal(/frameKey/.test(body.slice(body.indexOf("function showZiwo("), body.indexOf("function closePanel("))), false);
});

test("the footer describes the rows on screen, not the page that was just asked for", () => {
  const body = code(ziwoLogs);
  assert.match(body, /shownPage\.value = answer\.page \|\| 1;/);
  assert.match(
    body,
    /shownPageSize\.value = answer\.page_size \|\| pageSize\.value;/
  );
  assert.match(
    body,
    /pageSummary\(\s*total\.value,\s*shownPage\.value,\s*shownPageSize\.value,\s*rows\.value\.length\s*\)/
  );
});

test("every function the ZIWO panel template calls is defined in the panel", () => {
  // A template that calls an undefined function throws while rendering. Vue then unmounts the
  // panel, which destroys the softphone frame and drops a live call, so this is checked in source.
  const source = code(panel);
  const template = source.slice(source.indexOf("<template>"), source.indexOf("<script"));
  const script = source.slice(source.indexOf("<script"));
  const called = new Set<string>();
  for (const match of template.matchAll(/(^|[^.\w$])([a-z_][A-Za-z0-9_]*)\(/g)) {
    called.add(match[2]!);
  }
  // CSS functions in class strings and the word "event(s)" in translated text are not calls.
  const builtin = new Set(["if", "for", "switch", "function", "return", "typeof", "calc", "min", "max", "clamp", "event"]);
  const missing = [...called].filter((name) => {
    if (builtin.has(name)) return false;
    const defined = new RegExp(
      `(function\\s+${name}\\b|(const|let|var)\\s+${name}\\b|\\b${name}\\s*[,}]|import[^;]*\\b${name}\\b)`
    );
    return !defined.test(script);
  });
  assert.deepEqual(missing, []);
});

test("the Contact page refreshes its calls when the softphone saves events", () => {
  const page = code(read("pages/contact/Contact.vue"));
  // Saved events bump the store's version. The page listens and reloads, in one debounced step.
  assert.match(page, /storeToRefs\(useTelephonyStore\(\)\)/);
  assert.match(page, /watch\(ziwoHistoryVersion, scheduleRefresh\)/);
  assert.match(page, /setTimeout\(\(\) => \{[\s\S]*?outreach\.reload\(\)/);
  assert.match(page, /onBeforeUnmount\(\(\) => clearTimeout\(refreshTimer\)\)/);
  // The list stays on screen during a background reload instead of flashing "Loading".
  assert.match(page, /:loading="outreach\.loading && !outreach\.data"/);
});

test("a Record outcome link to a call the page has not loaded reloads once, never in a loop", () => {
  const page = code(read("pages/contact/Contact.vue"));
  const watcher = page.slice(page.indexOf("let reloadedFor"), page.indexOf("onMounted("));
  assert.match(watcher, /if \(row\) return openOutcome\(row\);/);
  assert.match(watcher, /reloadedFor !== callName && !outreach\.loading/);
  assert.match(watcher, /reloadedFor = callName;[\s\S]*?outreach\.reload\(\)/);
  assert.equal((watcher.match(/outreach\.reload\(\)/g) || []).length, 1);
});

test("a finished ticket call offers Record outcome for the call's contact", () => {
  const source = code(panel);
  assert.match(
    source,
    /v-if="focus\.ticket && focus\.logName && outcomeContact\(focus\)"[\s\S]*?query: \{ call: focus\.logName \}/
  );
  assert.match(source, /item\.contact \|\| item\.panel\?\.contact\?\.name/);
});

test("Call Logs and call cards label missed calls and the Missed filter asks the server", () => {
  const logs = code(ziwoLogs);
  assert.match(logs, /\{ label: __\("Missed"\), value: "missed" \}/);
  assert.match(logs, /outcome: direction\.value === "missed" \? "missed" : undefined/);
  for (const source of [logs, code(list)])
    assert.match(source, /function headline\([^)]*\) \{\s*if \(showsAsMissed\(row\)\) return __\("Missed"\);/);
});

test("an unknown caller's ticket form asks for an optional caller name", () => {
  const source = code(panel);
  assert.match(source, /v-if="unknownCaller\(focus\)"\s*v-model="draft\.callerName"/);
  assert.match(source, /const callerName = unknownCaller\(activeCall\) \? held\.callerName : "";/);
  assert.match(code(controller), /caller_name: fields\.callerName \?\? ""/);
});

test("agents keep the full name the server sends", () => {
  assert.match(
    code(read("stores/user.ts")),
    /user\.full_name = user\.full_name \|\| formatFullName\(user\.email\);/
  );
});

test("an unknown caller can be added to an existing contact from the panel", () => {
  const source = code(panel);
  assert.match(source, /v-if="unknownCaller\(focus\) && focus\.logName"[\s\S]*?data-testid="ziwo-contact-search"/);
  assert.match(source, /call\("helpdesk\.api\.contact\.find_contacts", \{ txt \}\)/);
  assert.match(source, /controller\.chooseContact\(callId, contact, \{ callLog, addNumber: true \}\)/);
  assert.match(code(controller), /\.\.\.\(options\.addNumber \? \{ add_number: 1 \} : \{\}\)/);
});

test("the dashboard shows contact-centre numbers for the chosen period and agent", () => {
  const page = code(read("pages/dashboard/Dashboard.vue"));
  assert.match(page, /<ContactCentreSection\s+v-if="filters\.period"\s+:filters="parseFilters\(filters\)"/);
  const section = code(read("components/ContactCentreSection.vue"));
  assert.match(section, /url: "inchaa_custmization\.integrations\.contact_centre\.get_stats"/);
  assert.match(section, /\(\) => \[props\.filters\.from_date, props\.filters\.to_date, props\.filters\.agent\]/);
});

test("only managers are offered Merge contacts", () => {
  const page = code(read("pages/contact/Contact.vue"));
  assert.match(page, /<MergeContactDialog\s+v-if="isManager"/);
  assert.match(page, /\.\.\.\(isManager\s+\? \[\s+\{\s+label: __\("Merge into another contact"\)/);
  const dialog = code(read("components/contact/MergeContactDialog.vue"));
  assert.match(dialog, /call\("helpdesk\.api\.contact\.merge_contacts"/);
  assert.match(dialog, /row\.name !== props\.source/);
});

test("a call that just ended asks once for its outcome and can be skipped", () => {
  const source = code(panel);
  const prompt = source.slice(source.indexOf("const outcomePrompt"), source.indexOf("const newerCall"));
  assert.match(prompt, /const item = wrapUp\.value;/);
  assert.match(prompt, /if \(!item\.answered && item\.direction !== "Outbound"\) return null;/);
  assert.match(prompt, /if \(!ready \|\| outcomeAsked\.has\(ready\.logName\)\) return;/);
  assert.match(source, /<ContactCallOutcomeDialog\s+v-model:open="outcomePrompt\.open"[\s\S]*?:cancel-label="__\('Skip'\)"/);
  const dialog = code(read("components/contact/ContactCallOutcomeDialog.vue"));
  assert.match(dialog, /:label="cancelLabel \|\| __\('Cancel'\)"/);
});

test("each contact call card carries its own outcome action", () => {
  const calls = code(read("components/contact/ContactCalls.vue"));
  assert.match(code(list), /<slot name="actions" :row="row" \/>/);
  assert.match(calls, /<template #actions="\{ row \}">[\s\S]*?\$emit\('record', row\)/);
});

test("the outreach summary joins its sentences with a space in script", () => {
  const summary = code(read("components/contact/ContactOutreachSummary.vue"));
  assert.match(summary, /parts\.join\(" "\)/);
  assert.match(summary, /\{\{ text \}\}/);
  // No sentence is left to the template, which dropped the spaces between them.
  assert.doesNotMatch(summary, /<template v-if=/);
});

test("saveNote posts an internal comment through frappe-ui call and does not shadow it", () => {
  const body = code(panel);
  const start = body.indexOf("async function saveNote()");
  const end = body.indexOf("\nconst liveCalls", start);
  assert.ok(start > 0 && end > start, "saveNote() is in the panel");
  const save = body.slice(start, end);

  assert.match(save, /const activeCall = focus\.value;/);
  assert.equal(
    /\b(?:const|let|var)\s+call\b|function\s+saveNote\s*\([^)]*\bcall\b/.test(save),
    false,
    "saveNote redeclares call"
  );
  assert.match(save, /await call\(\s*"run_doc_method",/);
  assert.match(save, /dt:\s*"HD Ticket"/);
  assert.match(save, /dn:\s*ticket/);
  assert.match(save, /method:\s*"new_comment"/);
  assert.match(save, /content:\s*internalNoteHtml\(text\)/);
  assert.match(save, /attachments:\s*\[\]/);
  assert.equal(/reply_via_agent|send_reply/.test(save), false);

  // The same import must stay reachable in every other panel function.
  const script = body.slice(body.indexOf("<script")).replace(/^import\s.+;$/gm, "");
  assert.match(body, /import \{[^}]*\bcall\b[^}]*\btoast\b[^}]*\} from "frappe-ui"/);
  assert.equal(/\b(?:const|let|var|function)\s+(?:call|toast)\b/.test(script), false);
  assert.equal(/function\s+\w+\s*\([^)]*\b(?:call|toast)\b/.test(script), false);
  assert.equal(/\(\s*(?:call|toast)\s*[,)]|,\s*(?:call|toast)\s*[,)]/.test(script), false);

  const twilio = code(read("components/telephony/TwilioCallUI.vue"));
  const twilioScript = twilio.slice(twilio.indexOf("<script")).replace(/^import\s.+;$/gm, "");
  assert.match(twilioScript, /function handleIncomingCall\(incoming\)/);
  assert.equal(/\b(?:const|let|var|function)\s+(?:call|toast)\b/.test(twilioScript), false);
  assert.equal(/function\s+\w+\s*\([^)]*\b(?:call|toast)\b/.test(twilioScript), false);
});
