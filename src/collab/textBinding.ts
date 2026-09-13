/**
 * Live text co-editing: binds every open `.skema` document the shared
 * project map already carries to its `Y.Text`, in both directions - the
 * role `y-codemirror.next` plays for `skema-editor`'s CodeMirror
 * (`textSync.ts`'s own header). Only documents actually open in an editor
 * are bound; a shared file nobody has opened yet is bound the moment
 * `onDidOpenTextDocument` fires for it.
 *
 * A remote delta becomes a `WorkspaceEdit`, so it lands in VSCode's own undo
 * stack like any edit - Option A, decided for brain/tasks/20: there is no
 * documented API to exclude one edit from a user's undo history, so the
 * risk is accepted and surfaced instead (`extension.ts`'s status bar item),
 * not hidden or worked around.
 */
import * as vscode from "vscode";
import * as Y from "yjs";

import { sharedFiles } from "@skema/collab-protocol";

import { relativePath } from "./projectPaths";
import {
  applyLocalChange,
  editsFromDelta,
  localEditsFromContentChanges,
  type OffsetEdit,
} from "./textSync";

const LOCAL_ORIGIN = Symbol("skema.collab.textBinding.local");

interface Binding {
  text: Y.Text;
  /** How many remote `WorkspaceEdit`s from this binding are in flight, so
   *  the `onDidChangeTextDocument` they cause is not fed straight back in -
   *  otherwise a remote edit would echo back onto itself. A count rather
   *  than a flag: two remote deltas can arrive before the first's
   *  `applyEdit` resolves, and the first one finishing must not reopen the
   *  window while the second is still in flight. */
  remoteEditsInFlight: number;
  observer: (event: Y.YTextEvent, transaction: Y.Transaction) => void;
}

export class TextBinding implements vscode.Disposable {
  private readonly bindings = new Map<string, Binding>();
  private readonly subscriptions: vscode.Disposable[];

  constructor(
    private readonly doc: Y.Doc,
    private readonly rootUri: () => string | undefined,
  ) {
    this.subscriptions = [
      vscode.workspace.onDidOpenTextDocument((document) => this.bindIfShared(document)),
      vscode.workspace.onDidCloseTextDocument((document) => this.unbind(document)),
      vscode.workspace.onDidChangeTextDocument((event) => this.onLocalChange(event)),
    ];
    for (const document of vscode.workspace.textDocuments) this.bindIfShared(document);
  }

  /** Call once the shared map gains files it did not carry before (seeding,
   *  or a guest's sync completing) - an already-open document only becomes
   *  bindable at that point, and would otherwise wait for a close/reopen. */
  refresh(): void {
    for (const document of vscode.workspace.textDocuments) this.bindIfShared(document);
  }

  private bindIfShared(document: vscode.TextDocument): void {
    if (document.languageId !== "skema") return;
    const key = document.uri.toString();
    if (this.bindings.has(key)) return;
    const root = this.rootUri();
    if (!root) return;
    const path = relativePath(root, key);
    if (!path) return;
    const text = sharedFiles(this.doc).get(path);
    if (!text) return;

    const binding: Binding = {
      text,
      remoteEditsInFlight: 0,
      observer: (event, transaction) => {
        if (transaction.local) return;
        void this.applyRemote(document, binding, editsFromDelta(event.delta));
      },
    };
    text.observe(binding.observer);
    this.bindings.set(key, binding);
  }

  private unbind(document: vscode.TextDocument): void {
    const key = document.uri.toString();
    const binding = this.bindings.get(key);
    if (!binding) return;
    binding.text.unobserve(binding.observer);
    this.bindings.delete(key);
  }

  private async applyRemote(
    document: vscode.TextDocument,
    binding: Binding,
    edits: OffsetEdit[],
  ): Promise<void> {
    if (edits.length === 0) return;
    binding.remoteEditsInFlight += 1;
    try {
      const edit = new vscode.WorkspaceEdit();
      for (const change of edits) {
        edit.replace(
          document.uri,
          new vscode.Range(document.positionAt(change.start), document.positionAt(change.end)),
          change.text,
        );
      }
      await vscode.workspace.applyEdit(edit);
    } finally {
      binding.remoteEditsInFlight -= 1;
    }
  }

  private onLocalChange(event: vscode.TextDocumentChangeEvent): void {
    const binding = this.bindings.get(event.document.uri.toString());
    if (!binding || binding.remoteEditsInFlight > 0 || event.contentChanges.length === 0) return;
    for (const edit of localEditsFromContentChanges(event.contentChanges)) {
      applyLocalChange(this.doc, binding.text, edit, LOCAL_ORIGIN);
    }
  }

  dispose(): void {
    for (const binding of this.bindings.values()) binding.text.unobserve(binding.observer);
    this.bindings.clear();
    for (const subscription of this.subscriptions.splice(0)) subscription.dispose();
  }
}
