// Verified non-routable identity domains. A local part such as "wa-" or "c-"
// on any other domain is a customer mailbox and stays visible.
const SYNTHETIC_CONTACT_DOMAINS = new Set([
  "platform.inchaa.invalid",
  "fb.inchaa.invalid",
  "ig.inchaa.invalid",
  "wa.inchaa.invalid",
]);

function bareEmail(address: string | null | undefined): string {
  let text = (address || "").trim().toLowerCase();
  if (text.includes("<") && text.endsWith(">")) {
    text = text.slice(text.lastIndexOf("<") + 1, -1).trim();
  }
  return text;
}

export function isSyntheticContactEmail(
  address: string | null | undefined
): boolean {
  const email = bareEmail(address);
  const at = email.indexOf("@");
  if (at <= 0 || at !== email.lastIndexOf("@")) return false;
  return SYNTHETIC_CONTACT_DOMAINS.has(email.slice(at + 1).replace(/\.$/, ""));
}

export function customerFacingEmail(
  primary: string | null | undefined,
  others: Array<string | null | undefined> = []
): string {
  const candidates: string[] = [];
  if (primary && primary.trim()) candidates.push(primary.trim());
  for (const item of others) {
    const text = (item || "").trim();
    if (text && !candidates.includes(text)) candidates.push(text);
  }
  for (const address of candidates) {
    if (!isSyntheticContactEmail(address)) return address;
  }
  return "";
}
