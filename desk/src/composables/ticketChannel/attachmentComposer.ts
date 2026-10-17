/**
 * Local attachment staging for one channel reply.
 *
 * Choosing, replacing, removing or cancelling a file never uploads it and never
 * sends it. Only `send` starts that work, and a second call joins the first.
 * The File document name from a completed upload is reused on a later attempt.
 * File bytes are not stored here and do not survive a reload.
 *
 * No Vue, no frappe-ui and no alias imports: it runs under `node --test`.
 */
import type { SubmitOutcome } from "./replyController";

export interface StagedAttachment {
  token: string;
  name: string;
  size: number;
  type: string;
}

export type ComposerOutcome =
  | { kind: "empty" }
  | { kind: "upload_failed" }
  | SubmitOutcome;

export interface AttachmentComposerDeps {
  upload(token: string): Promise<string>;
  submitText(): Promise<SubmitOutcome>;
  submitFile(file: string, caption: string): Promise<SubmitOutcome>;
  /** File name already bound to an unanswered request, if the controller has one. */
  pendingFile(): string | null | undefined;
}

interface SendSnapshot {
  caption: string;
  staged: StagedAttachment | null;
}

export class AttachmentComposer {
  staged: StagedAttachment | null = null;
  private uploaded: { token: string; fileName: string } | null = null;
  private flight: Promise<ComposerOutcome> | null = null;
  private deps: AttachmentComposerDeps;

  constructor(deps: AttachmentComposerDeps) {
    this.deps = deps;
  }

  /** Stage a local file. This does not upload or send. */
  stage(file: StagedAttachment) {
    if (this.uploaded && this.uploaded.token !== file.token)
      this.uploaded = null;
    this.staged = { ...file };
  }

  /** Replace the staged file. This does not upload or send. */
  replace(file: StagedAttachment) {
    this.stage(file);
  }

  /** Drop the staged file and any uploaded reference that belonged to it. */
  remove() {
    this.staged = null;
    this.uploaded = null;
  }

  /** The picker was closed without a file. The staged attachment stays. */
  cancelPicker() {
    return this.staged ? { ...this.staged } : null;
  }

  uploadedFileName(): string | null {
    if (!this.uploaded || this.uploaded.token !== this.staged?.token)
      return null;
    return this.uploaded.fileName;
  }

  /**
   * Upload, if needed, then hand one caption and one File name to the reply
   * controller. The caption and file are the values from the moment sending
   * began. An empty caption is sent as an empty string.
   */
  send(caption: string): Promise<ComposerOutcome> {
    if (this.flight) return this.flight;
    const snapshot: SendSnapshot = {
      caption,
      staged: this.staged ? { ...this.staged } : null,
    };
    const run = this.run(snapshot).finally(() => {
      this.flight = null;
    });
    this.flight = run;
    return run;
  }

  /** Drop the local attachment only after the server has kept the reply. */
  clearAfterConfirmation() {
    this.staged = null;
    this.uploaded = null;
  }

  private async run(snapshot: SendSnapshot): Promise<ComposerOutcome> {
    if (this.deps.pendingFile()) return this.deps.submitText();
    if (!snapshot.staged) {
      if (!snapshot.caption.trim()) return { kind: "empty" };
      return this.deps.submitText();
    }
    let fileName =
      this.uploaded && this.uploaded.token === snapshot.staged.token
        ? this.uploaded.fileName
        : null;
    if (!fileName) {
      try {
        fileName = await this.deps.upload(snapshot.staged.token);
      } catch {
        return { kind: "upload_failed" };
      }
      if (this.staged?.token === snapshot.staged.token) {
        this.uploaded = { token: snapshot.staged.token, fileName };
      }
    }
    return this.deps.submitFile(fileName, snapshot.caption);
  }
}
