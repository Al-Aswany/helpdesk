const AUDIO_EXTENSIONS = new Set([
  "m4a",
  "mp3",
  "ogg",
  "wav",
  "aac",
  "oga",
  "opus",
]);

// Filename-only types. The ticket timeline receives a file name, not a MIME header.
const AUDIO_MIME_BY_EXTENSION: Record<string, string> = {
  m4a: "audio/mp4",
  mp3: "audio/mpeg",
  ogg: "audio/ogg",
  oga: "audio/ogg",
  opus: "audio/ogg",
  wav: "audio/wav",
  aac: "audio/aac",
};

function basename(fileName: string): string {
  const path = fileName.split("?")[0].split("#")[0];
  const slash = Math.max(path.lastIndexOf("/"), path.lastIndexOf("\\"));
  return (slash >= 0 ? path.slice(slash + 1) : path).trim().toLowerCase();
}

/** True for a voice note the ticket timeline can play inline.
 *
 * `.mp4` is audio only when the stored name is a generated voice file.
 * Any other `.mp4` stays a video preview or a normal download.
 */
export function isInlineAudioAttachment(
  fileName: string | null | undefined
): boolean {
  const base = basename(fileName || "");
  if (!base) return false;
  const dot = base.lastIndexOf(".");
  const ext = dot >= 0 ? base.slice(dot + 1) : "";
  if (AUDIO_EXTENSIONS.has(ext)) return true;
  const mime = AUDIO_MIME_BY_EXTENSION[ext] || "";
  if (mime.startsWith("audio/")) return true;
  return ext === "mp4" && /(?:^|[-_])voice\.mp4$/.test(base);
}

/** Same-origin file path only. Absolute and protocol-relative URLs are not playable. */
export function sameOriginFileUrl(
  url: string | null | undefined
): string | null {
  const value = (url || "").trim();
  if (!value.startsWith("/") || value.startsWith("//") || value.includes("://")) {
    return null;
  }
  return value;
}
