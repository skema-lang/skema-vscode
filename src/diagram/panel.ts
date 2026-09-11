/**
 * The diagram panel: a webview beside the text, and the wiring that keeps it
 * showing the project the editor is in.
 *
 * The panel owns no model of its own. It asks the language server
 * (`skema/model`) whenever something could have changed it - the server said
 * so, the active editor moved to another project, the panel was just opened -
 * and pushes the answer in. Everything the view wants done comes back as a
 * message, and is done here, where a document and a `WorkspaceEdit` exist.
 */
import * as vscode from "vscode";
import type { LanguageClient } from "vscode-languageclient/node";

import {
  MODEL_REQUEST,
  POSITION_EDIT_REQUEST,
  type DiagramPreferences,
  type HostMessage,
  type ModelResponse,
  type PositionEditResponse,
  type WebviewMessage,
} from "../../shared/protocol";

export class DiagramPanel {
  private static current: DiagramPanel | undefined;

  private readonly disposables: vscode.Disposable[] = [];
  /** The file the model was last asked about - kept so a refresh triggered
   *  by the server still knows which project to ask about when the active
   *  editor is something else entirely (a terminal, a settings tab). */
  private subject: vscode.Uri | undefined;
  private latest: ModelResponse | undefined;
  private ready = false;

  static show(
    context: vscode.ExtensionContext,
    client: LanguageClient,
    subject: vscode.Uri | undefined,
  ): DiagramPanel {
    const column = vscode.window.activeTextEditor
      ? vscode.ViewColumn.Beside
      : vscode.ViewColumn.One;

    if (DiagramPanel.current) {
      DiagramPanel.current.panel.reveal(column, true);
      if (subject) void DiagramPanel.current.refresh(subject);
      return DiagramPanel.current;
    }

    const panel = vscode.window.createWebviewPanel(
      "skema.diagram",
      "skema diagram",
      { viewColumn: column, preserveFocus: true },
      {
        enableScripts: true,
        // The model is re-requested on reveal anyway, but keeping the view
        // alive preserves the canvas' pan and zoom - losing those on every
        // tab switch makes the panel useless next to a text editor.
        retainContextWhenHidden: true,
        localResourceRoots: [vscode.Uri.joinPath(context.extensionUri, "dist")],
      },
    );

    DiagramPanel.current = new DiagramPanel(context, client, panel, subject);
    return DiagramPanel.current;
  }

  /** Whether a panel is open at all - the extension only pays for model
   *  requests while something is looking at them. */
  static isOpen(): boolean {
    return DiagramPanel.current !== undefined;
  }

  static refreshCurrent(subject?: vscode.Uri): void {
    void DiagramPanel.current?.refresh(subject);
  }

  static sendPreferences(preferences: DiagramPreferences): void {
    DiagramPanel.current?.post({ type: "preferences", preferences });
  }

  private constructor(
    private readonly context: vscode.ExtensionContext,
    private readonly client: LanguageClient,
    private readonly panel: vscode.WebviewPanel,
    subject: vscode.Uri | undefined,
  ) {
    this.subject = subject;
    this.panel.webview.html = this.html();

    this.disposables.push(
      this.panel.webview.onDidReceiveMessage((message: WebviewMessage) =>
        this.receive(message),
      ),
      this.panel.onDidDispose(() => this.dispose()),
      // Following the editor is the whole point of a panel beside it: open
      // another project's file and the diagram follows.
      vscode.window.onDidChangeActiveTextEditor((editor) => {
        if (editor?.document.languageId === "skema") void this.refresh(editor.document.uri);
      }),
    );
  }

  private dispose(): void {
    DiagramPanel.current = undefined;
    for (const disposable of this.disposables.splice(0)) disposable.dispose();
    this.panel.dispose();
  }

  /** Asks the server for the model around `subject` and pushes it in. */
  async refresh(subject?: vscode.Uri): Promise<void> {
    const uri = subject ?? this.subject ?? activeSkemaFile();
    if (!uri) {
      this.post({ type: "status", message: "Open a .skema file to see its model." });
      return;
    }
    this.subject = uri;

    try {
      const model = await this.client.sendRequest<ModelResponse | null>(MODEL_REQUEST, {
        uri: uri.toString(),
      });
      if (!model) {
        this.post({ type: "status", message: "No model for this file yet." });
        return;
      }
      this.latest = model;
      this.post({ type: "model", model });
    } catch (error) {
      this.post({ type: "status", message: `Could not read the model: ${String(error)}` });
    }
  }

  private receive(message: WebviewMessage): void {
    switch (message.type) {
      case "ready":
        this.ready = true;
        DiagramPanel.sendPreferences(readPreferences());
        void this.refresh();
        break;
      case "reveal":
        void this.reveal(message);
        break;
      case "position":
        void this.writePosition(message);
        break;
      case "setPreference":
        void vscode.workspace
          .getConfiguration("skema.diagram")
          .update(message.key, message.value, vscode.ConfigurationTarget.Workspace);
        break;
    }
  }

  /** Opens the declaration a double-click (or a clicked relationship line)
   *  points at. */
  private async reveal(message: Extract<WebviewMessage, { type: "reveal" }>): Promise<void> {
    const uri = this.uriOf(message.location.file);
    if (!uri) return;

    const document = await vscode.workspace.openTextDocument(uri);
    // Beside the diagram, not on top of it: the panel is usually the second
    // column, and stealing it would close what the user is looking at.
    const editor = await vscode.window.showTextDocument(document, {
      viewColumn: vscode.ViewColumn.One,
      preserveFocus: false,
    });

    // A `Location` counts 1-based lines and 1-based UTF-16 columns; VSCode
    // counts both from zero.
    const { line, column, endLine, endColumn } = message.location;
    const range = new vscode.Range(
      new vscode.Position(Math.max(line - 1, 0), Math.max(column - 1, 0)),
      new vscode.Position(Math.max(endLine - 1, 0), Math.max(endColumn - 1, 0)),
    );
    editor.selection = new vscode.Selection(range.start, range.end);
    editor.revealRange(range, vscode.TextEditorRevealType.InCenterIfOutsideViewport);
  }

  /**
   * Writes a dragged position into the model's source.
   *
   * The edit itself is computed by the server, against the file's current
   * text: the offsets belong to one exact revision, and the webview has
   * neither the text nor any business knowing where a `Meta` entry goes.
   * Applying it as a `WorkspaceEdit` is what puts a drag into the same undo
   * history as a keystroke - and works whether or not the file is open.
   */
  private async writePosition(
    message: Extract<WebviewMessage, { type: "position" }>,
  ): Promise<void> {
    const uri = this.uriOf(message.file);
    if (!uri) return;

    const response = await this.client.sendRequest<PositionEditResponse>(
      POSITION_EDIT_REQUEST,
      {
        uri: uri.toString(),
        kind: message.kind,
        name: message.name,
        x: message.x,
        y: message.y,
      },
    );
    if (!response?.edit) return;

    const { range, newText } = response.edit;
    const edit = new vscode.WorkspaceEdit();
    edit.replace(
      uri,
      new vscode.Range(
        new vscode.Position(range.start.line, range.start.character),
        new vscode.Position(range.end.line, range.end.character),
      ),
      newText,
    );
    await vscode.workspace.applyEdit(edit);
  }

  /** The model addresses files by path; VSCode by URI. The `files` list in
   *  the last response is the only mapping between the two. */
  private uriOf(path: string): vscode.Uri | undefined {
    const entry = this.latest?.files.find((file) => file.path === path);
    return entry ? vscode.Uri.parse(entry.uri) : undefined;
  }

  private post(message: HostMessage): void {
    if (!this.ready && message.type !== "status") return;
    void this.panel.webview.postMessage(message);
  }

  private html(): string {
    const webview = this.panel.webview;
    const asset = (...parts: string[]): vscode.Uri =>
      webview.asWebviewUri(vscode.Uri.joinPath(this.context.extensionUri, "dist", ...parts));

    // A nonce plus a CSP that allows nothing else: the view renders a model
    // read from files in the workspace, and should not be able to reach the
    // network even if something in it ever tried.
    const nonce = Array.from({ length: 32 }, () =>
      "ABCDEFGHIJKLMNOPQRSTUVWXYZabcdefghijklmnopqrstuvwxyz0123456789".charAt(
        Math.floor(Math.random() * 62),
      ),
    ).join("");

    return `<!DOCTYPE html>
<html lang="en">
  <head>
    <meta charset="utf-8" />
    <meta
      http-equiv="Content-Security-Policy"
      content="default-src 'none'; img-src ${webview.cspSource} data:; style-src ${webview.cspSource} 'unsafe-inline'; script-src 'nonce-${nonce}'; font-src ${webview.cspSource};"
    />
    <meta name="viewport" content="width=device-width, initial-scale=1.0" />
    <link rel="stylesheet" href="${asset("webview.css")}" />
    <title>skema diagram</title>
  </head>
  <body>
    <div id="root"></div>
    <script nonce="${nonce}" src="${asset("webview.js")}"></script>
  </body>
</html>`;
  }
}

export function readPreferences(): DiagramPreferences {
  const config = vscode.workspace.getConfiguration("skema.diagram");
  return {
    edgeRouting: config.get("edgeRouting", "smoothstep"),
    snapToGrid: config.get("snapToGrid", false),
    gridSize: config.get("gridSize", 16),
    autoSavePositions: config.get("autoSavePositions", false),
  };
}

function activeSkemaFile(): vscode.Uri | undefined {
  const active = vscode.window.activeTextEditor;
  if (active?.document.languageId === "skema") return active.document.uri;
  return vscode.window.visibleTextEditors.find((e) => e.document.languageId === "skema")?.document
    .uri;
}
