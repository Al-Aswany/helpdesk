import assert from "node:assert/strict";
import { test } from "node:test";
import {
  AttachmentComposer,
  type StagedAttachment,
} from "../../src/composables/ticketChannel/attachmentComposer.ts";
import type { SubmitOutcome } from "../../src/composables/ticketChannel/replyController.ts";

function file(token: string, name = "roof.png"): StagedAttachment {
  return { token, name, size: 1200, type: "image/png" };
}

function saved(message = ""): SubmitOutcome {
  return { kind: "saved" };
}

function harness(pending: string | null = null) {
  const uploads: string[] = [];
  const texts: string[] = [];
  const files: { file: string; caption: string }[] = [];
  let pendingFile = pending;
  let uploadImpl = async (token: string) => {
    uploads.push(token);
    return "FILE-1";
  };
  const composer = new AttachmentComposer({
    upload: (token) => uploadImpl(token),
    submitText: async () => {
      texts.push("text");
      return saved();
    },
    submitFile: async (name, caption) => {
      files.push({ file: name, caption });
      return saved(caption);
    },
    pendingFile: () => pendingFile,
  });
  return {
    composer,
    uploads,
    texts,
    files,
    setPending: (value: string | null) => {
      pendingFile = value;
    },
    setUpload: (impl: typeof uploadImpl) => {
      uploadImpl = impl;
    },
  };
}

test("choosing, cancelling, replacing and removing a file does not upload or send", () => {
  const { composer, uploads, texts, files } = harness();
  composer.stage(file("local-1"));
  assert.equal(composer.cancelPicker()?.token, "local-1");
  composer.replace(file("local-2", "other.png"));
  composer.remove();
  assert.equal(uploads.length, 0);
  assert.equal(texts.length, 0);
  assert.equal(files.length, 0);
  assert.equal(composer.staged, null);
});

test("an attachment-only send uploads once and sends the empty caption", async () => {
  const { composer, uploads, files } = harness();
  composer.stage(file("local-1"));
  const outcome = await composer.send("");
  assert.equal(outcome.kind, "saved");
  assert.deepEqual(uploads, ["local-1"]);
  assert.deepEqual(files, [{ file: "FILE-1", caption: "" }]);
});

test("a captioned image sends that exact caption", async () => {
  const { composer, files } = harness();
  composer.stage(file("local-1"));
  await composer.send("70d7c1f276");
  assert.deepEqual(files, [{ file: "FILE-1", caption: "70d7c1f276" }]);
});

test("a double send performs one upload and one recipient send", async () => {
  const { composer, uploads, files, setUpload } = harness();
  composer.stage(file("local-1"));
  let release: (name: string) => void = () => undefined;
  setUpload(
    (token) =>
      new Promise((resolve) => {
        uploads.push(token);
        release = resolve;
      })
  );
  const first = composer.send("");
  const second = composer.send("typed too late");
  assert.equal(uploads.length, 1);
  release("FILE-1");
  const [a, b] = await Promise.all([first, second]);
  assert.equal(a.kind, "saved");
  assert.equal(b.kind, "saved");
  assert.deepEqual(files, [{ file: "FILE-1", caption: "" }]);
});

test("a failed upload does not send and keeps the staged file", async () => {
  const { composer, files, setUpload } = harness();
  composer.stage(file("local-1"));
  setUpload(async () => {
    throw new Error("network");
  });
  const outcome = await composer.send("roof");
  assert.equal(outcome.kind, "upload_failed");
  assert.equal(files.length, 0);
  assert.equal(composer.staged?.token, "local-1");
});

test("a lost response retries the uploaded file without uploading again", async () => {
  const { composer, uploads, texts, files, setPending } = harness();
  composer.stage(file("local-1"));
  await composer.send("roof");
  assert.deepEqual(uploads, ["local-1"]);
  setPending("FILE-1");
  await composer.send("roof");
  assert.deepEqual(uploads, ["local-1"]);
  assert.equal(files.length, 1);
  assert.equal(texts.length, 1);
});

test("a rejected attempt reuses the uploaded file for the next explicit send", async () => {
  const { composer, uploads, files } = harness();
  composer.stage(file("local-1"));
  await composer.send("");
  await composer.send("");
  assert.deepEqual(uploads, ["local-1"]);
  assert.deepEqual(files, [
    { file: "FILE-1", caption: "" },
    { file: "FILE-1", caption: "" },
  ]);
});

test("replacing a file after an upload does not reuse the previous file", async () => {
  const { composer, uploads, files } = harness();
  composer.stage(file("local-1"));
  await composer.send("one");
  composer.replace(file("local-2", "next.png"));
  await composer.send("two");
  assert.deepEqual(uploads, ["local-1", "local-2"]);
  assert.equal(files[1]!.file, "FILE-1");
  assert.equal(files[1]!.caption, "two");
});

test("text-only send does not upload", async () => {
  const { composer, uploads, texts, files } = harness();
  await composer.send("Hello customer");
  assert.equal(uploads.length, 0);
  assert.equal(files.length, 0);
  assert.deepEqual(texts, ["text"]);
});
