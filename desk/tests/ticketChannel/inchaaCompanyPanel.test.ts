import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { test } from "node:test";

const panel = readFileSync(
  new URL(
    "../../src/components/ticket-agent/InchaaCompanyPanel.vue",
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

test("company panel is on the agent ticket sidebar", () => {
  assert.match(details, /InchaaCompanyPanel/);
  assert.match(panel, /data-testid="inchaa-company-panel"/);
  assert.match(panel, /get_company_panel/);
  assert.match(panel, /Company linking is turned off/);
});

test("lookup shows the person, company, membership and failure text", () => {
  assert.match(panel, /data-testid="inchaa-company-person"/);
  assert.match(panel, /data-testid="inchaa-company-name"/);
  assert.match(panel, /data-testid="inchaa-company-membership"/);
  assert.match(panel, /data-testid="inchaa-company-message"/);
  assert.match(panel, /data-testid="inchaa-company-error"/);
  assert.match(panel, /lookup_company_identity/);
});

test("a lookup cannot link until the agent confirms, and the link checks again", () => {
  assert.match(panel, /A lookup does not link this ticket/);
  assert.match(panel, /I confirmed this sender is this Inchaa account/);
  assert.match(panel, /data-testid="inchaa-company-confirm"/);
  assert.match(panel, /!confirmed \|\| !preview.linkable/);
  assert.match(panel, /\{ ticket: name, user_id: userId, relationship_confirmed: 1 \}/);
});
