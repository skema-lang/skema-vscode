/**
 * Markdown documentation: a virtual `skema-docs:` document rendered through
 * VSCode's own built-in Markdown preview, kept in step with the language
 * server's analysis - and the same content, written to disk on request.
 *
 * No webview, unlike the diagram (`diagram/panel.ts`): the output is plain
 * Markdown, and the built-in previewer already renders that, in the user's
 * own theme, with none of react-markdown/Mantine to bundle or keep in step
 * with `skema-editor`'s copy.
 */
import * as vscode from "vscode";
import type { LanguageClient } from "vscode-languageclient/node";

import { MODEL_REQUEST, type ModelResponse } from "../../shared/protocol";
import { modelToMarkdown } from "../../shared/markdown";

export const SCHEME = "skema-docs";
export const PREVIEW_URI = vscode.Uri.parse(`${SCHEME}:/Model.md`);

/** Asks the server for the model around `uri` and renders it as Markdown -
 *  the one function both the live preview and the file export go through,
 *  so the two can never show different content for the same project. */
export async function renderDocumentation(
  client: LanguageClient,
  uri: vscode.Uri | undefined,
): Promise<string> {
  if (!uri) return "_Open a `.skema` file to see its documentation._";
  try {
    const response = await client.sendRequest<ModelResponse | null>(MODEL_REQUEST, {
      uri: uri.toString(),
    });
    if (!response) return "_No model for this file yet._";
    return modelToMarkdown(response.model, response.metas);
  } catch (error) {
    return `_Could not read the model: ${String(error)}_`;
  }
}

export class DocumentationProvider implements vscode.TextDocumentContentProvider {
  private static instance: DocumentationProvider | undefined;

  private readonly emitter = new vscode.EventEmitter<vscode.Uri>();
  readonly onDidChange = this.emitter.event;
  private client: LanguageClient | undefined;
  /** The file the preview's model was last asked about - same reason the
   *  diagram panel keeps one (`diagram/panel.ts`). */
  private subject: vscode.Uri | undefined;

  private constructor() {}

  /**
   * Once per activation, not once per server start:
   * `registerTextDocumentContentProvider` throws on a second registration
   * of the same scheme, so the provider has to survive a
   * `skema.restartServer` rather than being recreated by one - only its
   * `client` reference changes, via `setClient`.
   */
  static register(context: vscode.ExtensionContext): void {
    const provider = new DocumentationProvider();
    DocumentationProvider.instance = provider;
    context.subscriptions.push(
      vscode.workspace.registerTextDocumentContentProvider(SCHEME, provider),
      // Following the editor is the whole point of a panel beside it - same
      // reasoning as the diagram (`diagram/panel.ts`).
      vscode.window.onDidChangeActiveTextEditor((editor) => {
        if (editor?.document.languageId === "skema") provider.follow(editor.document.uri);
      }),
    );
  }

  static setClient(client: LanguageClient | undefined): void {
    const provider = DocumentationProvider.instance;
    if (!provider) return;
    provider.client = client;
    provider.emitter.fire(PREVIEW_URI);
  }

  static async show(subject: vscode.Uri | undefined): Promise<void> {
    const provider = DocumentationProvider.instance;
    if (provider && subject) provider.subject = subject;
    await vscode.commands.executeCommand("markdown.showPreviewToSide", PREVIEW_URI);
  }

  /** `skema/modelChanged`: a no-op unless the preview tab is actually open -
   *  VSCode only re-invokes `provideTextDocumentContent` for a URI it
   *  currently has open, so this costs nothing when nothing is looking. */
  static refresh(): void {
    DocumentationProvider.instance?.emitter.fire(PREVIEW_URI);
  }

  private follow(subject: vscode.Uri): void {
    this.subject = subject;
    this.emitter.fire(PREVIEW_URI);
  }

  provideTextDocumentContent(): Promise<string> {
    if (!this.client) return Promise.resolve("_The skema language server is not running._");
    return renderDocumentation(this.client, this.subject ?? activeSkemaFile());
  }
}

function activeSkemaFile(): vscode.Uri | undefined {
  const active = vscode.window.activeTextEditor;
  if (active?.document.languageId === "skema") return active.document.uri;
  return vscode.window.visibleTextEditors.find((e) => e.document.languageId === "skema")?.document
    .uri;
}
