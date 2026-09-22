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

import { LAYOUT_FILE, emptyLayout, parseLayout, serializeLayout } from "@skema/diagram";

import {
  MODEL_REQUEST,
  type DiagramPreferences,
  type HostMessage,
  type DiagramLayout,
  type ModelResponse,
  type RemoteDrag,
  type WebviewMessage,
} from "../../shared/protocol";
import { readHostProject, writeProjectToDisk } from "../collab/projectHost";
import { adoptProject, seedProject } from "../collab/projectSync";
import {
  currentDoc,
  endSession,
  publishDrag,
  role,
  setListener,
  type Listener,
  type SessionRole,
} from "../collab/session";
import { TextBinding } from "../collab/textBinding";

export class DiagramPanel implements Listener {
  private static current: DiagramPanel | undefined;

  private readonly disposables: vscode.Disposable[] = [];
  /** The file the model was last asked about - kept so a refresh triggered
   *  by the server still knows which project to ask about when the active
   *  editor is something else entirely (a terminal, a settings tab). */
  private subject: vscode.Uri | undefined;
  private latest: ModelResponse | undefined;
  private ready = false;
  private textBinding: TextBinding | undefined;
  private undoWarning: vscode.StatusBarItem | undefined;
  /** This session's project root, as an absolute URI - independent of
   *  `latest`, which the webview's own "ready" round trip fills in on its
   *  own schedule and must not be raced for text-sync to bind the document
   *  already open when a session starts. Set once seeding (host) or
   *  adoption (guest) knows it, cleared in `teardownCollabSync`. */
  private collabRootUri: string | undefined;
  /** Where a guest's adopted project is written - the folder the join flow
   *  confirmed with the user (`extension.ts`), never read from
   *  `workspaceFolders` here. Unused by a host. */
  private guestTargetFolder: vscode.Uri | undefined;

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

  /** `extension.ts`'s `skema.collab.endSession` command has no panel
   *  reference of its own - this is the same lookup `refreshCurrent` uses. */
  static endCollabSync(): void {
    DiagramPanel.current?.teardownCollabSync();
  }

  private constructor(
    private readonly context: vscode.ExtensionContext,
    private readonly client: LanguageClient,
    private readonly panel: vscode.WebviewPanel,
    subject: vscode.Uri | undefined,
  ) {
    this.subject = subject;
    this.panel.webview.html = this.html();
    // Exactly one panel exists at a time (`show()` reuses `current`), so
    // this is the only place a listener is ever registered.
    setListener(this);

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
    // Presence has no UI surface outside this panel, and this is the only
    // registered `Listener` - closing it without ending the session would
    // leave a WebRTC link running with nowhere to show what it reports.
    endSession();
    this.teardownCollabSync();
    for (const disposable of this.disposables.splice(0)) disposable.dispose();
    this.panel.dispose();
  }

  /**
   * Starts task 20's live text co-editing on top of the transport
   * `startHosting`/`joinSession` just brought up (`extension.ts`).
   *
   * Binding open documents works the same for both roles; seeding the
   * shared project only happens for the host, since a guest's project is
   * whatever it adopts once sync completes (`onProjectSynced` below). A
   * seeding failure (no elected root, the server not answering) degrades to
   * presence-only rather than aborting the session - task 19's diagram
   * sharing must keep working even when this cannot.
   *
   * `targetFolder` is where a guest's adopted project will be written -
   * required for that role, since the confirmed target is the whole point
   * of the join flow that calls this (`extension.ts`); unused by a host.
   */
  async beginCollabSync(sessionRole: SessionRole, targetFolder?: vscode.Uri): Promise<void> {
    const doc = currentDoc();
    if (!doc) return;
    this.textBinding = new TextBinding(doc, () => this.collabRootUri);
    this.showUndoWarning();
    if (sessionRole !== "host") {
      this.guestTargetFolder = targetFolder;
      return;
    }

    try {
      const subject = this.subject ?? activeSkemaFile();
      if (!subject) return;
      const project = await readHostProject(this.client, subject);
      if (!project) {
        void vscode.window.showWarningMessage(
          "This file has no elected project root, so this session shares diagram presence only - " +
            "open the project's root file to also share live text.",
        );
        return;
      }
      seedProject(doc, project.rootPath, project.files);
      this.collabRootUri = project.rootUri;
      this.textBinding.refresh();
    } catch (error) {
      void vscode.window.showWarningMessage(
        `Could not share this project's text: ${String(error)}. Diagram presence is still active.`,
      );
    }
  }

  /** `Listener`: the guest side of task 20 - the moment sync completes,
   *  write what the host seeded to real files and start editing it live.
   *  A no-op for the host, whose project was already seeded and is already
   *  on disk. */
  onProjectSynced(): void {
    if (role() !== "guest") return;
    void this.adoptProjectToDisk();
  }

  private async adoptProjectToDisk(): Promise<void> {
    const doc = currentDoc();
    const folder = this.guestTargetFolder;
    if (!doc) return;
    if (!folder) {
      void vscode.window.showWarningMessage(
        "No target folder was confirmed for this session - it shares diagram presence only.",
      );
      return;
    }
    try {
      const adopted = adoptProject(doc);
      if (adopted.files.length === 0) return;
      await writeProjectToDisk(folder, adopted.files);
      if (adopted.rootPath) {
        const rootUri = vscode.Uri.joinPath(folder, ...adopted.rootPath.split("/"));
        this.collabRootUri = rootUri.toString();
        this.textBinding?.refresh();
        const document = await vscode.workspace.openTextDocument(rootUri);
        await vscode.window.showTextDocument(document, {
          viewColumn: vscode.ViewColumn.One,
          preserveFocus: false,
        });
      } else {
        this.textBinding?.refresh();
      }
    } catch (error) {
      void vscode.window.showErrorMessage(`Could not write the shared project to disk: ${String(error)}`);
    }
  }

  /** Ends task 20's co-editing without closing the panel itself - a
   *  collaboration session ending is not a reason to close the diagram. */
  teardownCollabSync(): void {
    this.textBinding?.dispose();
    this.textBinding = undefined;
    this.undoWarning?.dispose();
    this.undoWarning = undefined;
    this.collabRootUri = undefined;
    this.guestTargetFolder = undefined;
  }

  private showUndoWarning(): void {
    if (!this.undoWarning) {
      this.undoWarning = vscode.window.createStatusBarItem(vscode.StatusBarAlignment.Left);
      this.undoWarning.text = "$(warning) skema co-editing";
      this.undoWarning.tooltip =
        "Live co-editing is active. A collaborator's edit lands in your undo stack like your own edits - " +
        "undo can revert their change without warning (no VSCode API excludes it; see brain/tasks/20).";
    }
    this.undoWarning.show();
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
      void this.readLayout();
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
        void this.readLayout();
        break;
      case "reveal":
        void this.reveal(message);
        break;
      case "layout":
        void this.writeLayout(message.layout);
        break;
      case "setPreference":
        void vscode.workspace
          .getConfiguration("skema.diagram")
          .update(message.key, message.value, vscode.ConfigurationTarget.Workspace);
        break;
      case "publishDrag":
        publishDrag(message.positions);
        break;
    }
  }

  /** `Listener`: relayed to the webview the same way model/layout data
   *  already is - the webview never touches Yjs/awareness directly. */
  onRemoteDragsChanged(remoteDrags: RemoteDrag[]): void {
    this.post({ type: "presence", remoteDrags });
  }

  /** `Listener`: reuses the diagram's own status line rather than adding a
   *  second one just for collaboration notices. */
  onStatusChanged(message: string): void {
    this.post({ type: "status", message });
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

  /** Where this project keeps its arrangement: beside the root document,
   *  the same rule the browser editor follows. */
  private layoutUri(): vscode.Uri | undefined {
    const root = this.latest?.rootUri;
    if (!root) return undefined;
    return vscode.Uri.joinPath(vscode.Uri.parse(root), "..", LAYOUT_FILE);
  }

  /** A missing or unreadable file simply means no arrangement yet. */
  private async readLayout(): Promise<void> {
    const uri = this.layoutUri();
    if (!uri) return;
    try {
      const bytes = await vscode.workspace.fs.readFile(uri);
      this.post({ type: "layout", layout: parseLayout(new TextDecoder().decode(bytes)) });
    } catch {
      this.post({ type: "layout", layout: emptyLayout() });
    }
  }

  /**
   * Writes the arrangement to that file, as a `WorkspaceEdit`.
   *
   * A plain `fs.writeFile` would be shorter and would put a drag outside
   * VSCode's undo history, which is the one thing this extension has been
   * careful about everywhere else.
   */
  private async writeLayout(layout: DiagramLayout): Promise<void> {
    const uri = this.layoutUri();
    if (!uri) return;
    const text = serializeLayout(layout);

    const edit = new vscode.WorkspaceEdit();
    try {
      // Replacing the text of an existing document is what undo understands;
      // re-creating the file would undo as a deletion.
      const document = await vscode.workspace.openTextDocument(uri);
      const whole = new vscode.Range(
        new vscode.Position(0, 0),
        document.lineAt(document.lineCount - 1).range.end,
      );
      edit.replace(uri, whole, text);
    } catch {
      edit.createFile(uri, { contents: new TextEncoder().encode(text), overwrite: true });
    }
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
  };
}

function activeSkemaFile(): vscode.Uri | undefined {
  const active = vscode.window.activeTextEditor;
  if (active?.document.languageId === "skema") return active.document.uri;
  return vscode.window.visibleTextEditors.find((e) => e.document.languageId === "skema")?.document
    .uri;
}
