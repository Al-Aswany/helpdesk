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

test("agents can edit a contact while delete and merge stay with managers", () => {
  assert.match(contactPage, /v-if="isAgent"/);
  assert.match(contactPage, /const \{ isManager, isAgent \} = useAuthStore\(\)/);
  assert.match(contactPage, /v-if="hasPermission\(\)"/);
  assert.match(contactPage, /__\("Merge into another contact"\)/);
  assert.match(contactPage, /__\("Delete"\)/);
  const editAt = contactPage.indexOf('v-if="isAgent"');
  const deleteAt = contactPage.indexOf('__("Delete")');
  const dropdownAt = contactPage.indexOf('v-if="hasPermission()"');
  assert.ok(editAt > 0 && dropdownAt > editAt && deleteAt > dropdownAt);
});

test("the contacts list offers create to the signed-in agent", () => {
  const listPage = readFileSync(
    new URL("../../src/pages/contact/Contacts.vue", import.meta.url),
    "utf8"
  );
  assert.ok(listPage.includes("__('Create')"));
  assert.equal(listPage.includes("hasPermission"), false);
  const dialog = readFileSync(
    new URL("../../src/components/contact/EditContactDialog.vue", import.meta.url),
    "utf8"
  );
  assert.ok(dialog.includes("__('Company Name')"));
  assert.ok(dialog.includes("__('Designation')"));
});
