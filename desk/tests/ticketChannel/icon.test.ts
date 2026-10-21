import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { test } from "node:test";

const iconComponent = readFileSync(
  new URL("../../src/components/channel/ChannelIcon.vue", import.meta.url),
  "utf8"
);
const instagramSvg = readFileSync(
  new URL("../../src/components/icons/InstagramIcon.vue", import.meta.url),
  "utf8"
);

test("Instagram uses its repository icon with an accessible label", () => {
  assert.match(
    iconComponent,
    /props\.name === "instagram"\) return InstagramIcon/
  );
  assert.match(iconComponent, /role="img"/);
  assert.match(iconComponent, /:aria-label="accessibleLabel"/);
  assert.match(iconComponent, /instagram: "Instagram"/);
  assert.match(instagramSvg, /viewBox="0 0 24 24"/);
  assert.match(instagramSvg, /<rect/);
  assert.match(instagramSvg, /<circle/);
});
