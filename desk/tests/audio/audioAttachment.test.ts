import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { test } from "node:test";
import {
  isInlineAudioAttachment,
  sameOriginFileUrl,
} from "../../src/audioAttachment.ts";

const attachmentItem = readFileSync(
  new URL("../../src/components/AttachmentItem.vue", import.meta.url),
  "utf8"
);

test("voice files play inline and ordinary files do not", () => {
  for (const name of [
    "messenger-voice.m4a",
    "instagram-voice.mp3",
    "note.ogg",
    "note.wav",
    "note.aac",
    "messenger-voice.mp4",
    "instagram-voice.mp4",
  ]) {
    assert.equal(isInlineAudioAttachment(name), true, name);
  }
  assert.equal(isInlineAudioAttachment("clip.mp4"), false);
  assert.equal(isInlineAudioAttachment("holiday-video.mp4"), false);
  assert.equal(isInlineAudioAttachment("photo.jpg"), false);
  assert.equal(isInlineAudioAttachment("notes.pdf"), false);
  assert.equal(
    sameOriginFileUrl("/private/files/messenger-voice.m4a"),
    "/private/files/messenger-voice.m4a"
  );
  assert.equal(sameOriginFileUrl("https://cdn.example/voice.m4a"), null);
  assert.equal(sameOriginFileUrl("//cdn.example/voice.m4a"), null);
});

test("the attachment row uses a private audio element", () => {
  assert.match(attachmentItem, /<audio/);
  assert.match(attachmentItem, /controls/);
  assert.match(attachmentItem, /preload="metadata"/);
  assert.match(attachmentItem, /:src="audioSrc"/);
  assert.match(attachmentItem, /sameOriginFileUrl/);
  assert.doesNotMatch(attachmentItem, /https?:\/\//);
});
