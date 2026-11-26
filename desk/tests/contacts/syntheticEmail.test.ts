import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { test } from "node:test";
import {
  customerFacingEmail,
  isSyntheticContactEmail,
} from "../../src/syntheticContactEmail.ts";

const contactPage = readFileSync(
  new URL("../../src/pages/contact/Contact.vue", import.meta.url),
  "utf8"
);

test("synthetic identity domains are hidden and real addresses are kept", () => {
  for (const address of [
    "c-abc@platform.inchaa.invalid",
    "fb-abc@fb.inchaa.invalid",
    "ig-abc@ig.inchaa.invalid",
    "wa-abc@wa.inchaa.invalid",
    "WA-ABC@WA.INCHAA.INVALID",
  ]) {
    assert.equal(isSyntheticContactEmail(address), true);
    assert.equal(customerFacingEmail(address), "");
  }
  assert.equal(isSyntheticContactEmail("wa-support@example.com"), false);
  assert.equal(isSyntheticContactEmail("c-ops@example.com"), false);
  assert.equal(customerFacingEmail("wa-support@example.com"), "wa-support@example.com");
  assert.equal(
    customerFacingEmail("fb-abc@fb.inchaa.invalid", ["person@example.com"]),
    "person@example.com"
  );
  assert.equal(
    customerFacingEmail("person@example.com", ["wa-abc@wa.inchaa.invalid"]),
    "person@example.com"
  );
});

test("the contact page shows the shared customer address", () => {
  assert.match(contactPage, /customerFacingEmail\(/);
  assert.match(contactPage, /shownEmail\.value/);
});
