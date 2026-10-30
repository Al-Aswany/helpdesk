import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { test } from "node:test";

const panel = readFileSync(
  new URL(
    "../../src/components/ticket-agent/InchaaAdminTaskPanel.vue",
    import.meta.url
  ),
  "utf8"
);
const details = readFileSync(
  new URL(
    "../../src/components/ticket-agent/TicketDetailsTab.vue",
    import.meta.url
  ),
  "utf8"
);
const message = readFileSync(
  new URL(
    "../../src/components/channel/ChannelMessageArea.vue",
    import.meta.url
  ),
  "utf8"
);

test("Inchaa admin task panel is mounted on the agent ticket sidebar", () => {
  assert.match(details, /InchaaAdminTaskPanel/);
  assert.match(panel, /data-testid="inchaa-admin-task"/);
  assert.match(panel, /Create Inchaa admin task/);
  assert.match(panel, /Mark Won’t Resolve in Inchaa/);
  assert.match(panel, /get_ticket_panel/);
  assert.match(panel, /create_admin_task/);
  assert.match(panel, /refresh_admin_task/);
  assert.match(panel, /mark_wont_resolve/);
});

test("uncertain Inchaa replies can be retried only after a warning", () => {
  assert.match(message, /Retry anyway/);
  assert.match(message, /Uncertain/);
});
