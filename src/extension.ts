/**
 * skema for VSCode: a language client and a live diagram.
 *
 * Everything the editor shows about the language - errors, hover,
 * completion, go-to-definition, colouring, the outline - comes from
 * `skema-lsp`, which is the language's own frontend rather than a
 * re-description of it in TypeScript. There is deliberately no TextMate
 * grammar in this extension: a regex grammar cannot tell a type reference
 * from a field name, and it would be a second definition of the syntax to
 * keep in step with the first.
 *
 * The diagram is a webview fed by three custom `skema/` requests on the same
 * server (`shared/protocol.ts`).
 */
import { dirname } from "node:path";

import * as vscode from "vscode";
import {
  LanguageClient,
  TransportKind,
  type LanguageClientOptions,
  type ServerOptions,
} from "vscode-languageclient/node";

import { MODEL_CHANGED_NOTIFICATION } from "../shared/protocol";
import { editorInviteUrl } from "./collab/editorLink";
import { runEndOfSession } from "./collab/endSession";
import { loadIdentity } from "./collab/identity";
import {
  confirmed,
  decideFolder,
  joinConfirmation,
  parseJoinInvite,
  type FolderDecision,
} from "./collab/joinFlow";
import {
  completeHosting,
  createInvite,
  endSession,
  isActive,
  joinSession,
  mode,
  startHosting,
} from "./collab/session";
import { DiagramPanel, readPreferences } from "./diagram/panel";
import { DocumentationProvider, renderDocumentation } from "./docs/provider";
import { ServerNotFound, resolveServer } from "./server";

let client: LanguageClient | undefined;
let output: vscode.OutputChannel;
/** Set once a join wrote into a folder that was not already open, so
 *  `endCollabSession` can offer to open it now that reloading is harmless. */
let unopenedJoinFolder: vscode.Uri | undefined;

export async function activate(context: vscode.ExtensionContext): Promise<void> {
  output = vscode.window.createOutputChannel("skema");
  context.subscriptions.push(output);
  void vscode.commands.executeCommand("setContext", "skema.collab.hosting", false);

  DocumentationProvider.register(context);

  context.subscriptions.push(
    vscode.commands.registerCommand("skema.showDiagram", () => {
      if (!client) {
        void vscode.window.showWarningMessage("The skema language server is not running.");
        return;
      }
      DiagramPanel.show(context, client, vscode.window.activeTextEditor?.document.uri);
    }),
    vscode.commands.registerCommand("skema.showDocumentation", () => {
      if (!client) {
        void vscode.window.showWarningMessage("The skema language server is not running.");
        return;
      }
      void DocumentationProvider.show(vscode.window.activeTextEditor?.document.uri);
    }),
    vscode.commands.registerCommand("skema.exportDocumentation", () => exportDocumentation()),
    vscode.commands.registerCommand("skema.restartServer", async () => {
      await stop();
      await start(context);
    }),
    vscode.commands.registerCommand("skema.collab.startSession", () => startCollabSession(context)),
    vscode.commands.registerCommand("skema.collab.invite", () => inviteToCollabSession()),
    vscode.commands.registerCommand("skema.collab.completeSession", () => completeCollabSession()),
    vscode.commands.registerCommand("skema.collab.joinSession", () => joinCollabSession(context)),
    vscode.commands.registerCommand("skema.collab.endSession", () => endCollabSession()),
    // Closing the panel ends any session it is showing exactly like the
    // command above does (task 108) - the panel has no reference to the
    // context key, message or "Open folder" offer that belong to it alone.
    DiagramPanel.onDidDispose(() => endCollabSession()),
    // A changed server path means a different server; a changed diagram
    // option has to reach the open panel.
    vscode.workspace.onDidChangeConfiguration(async (event) => {
      if (event.affectsConfiguration("skema.serverPath")) {
        await stop();
        await start(context);
      }
      if (event.affectsConfiguration("skema.diagram")) {
        DiagramPanel.sendPreferences(readPreferences());
      }
    }),
  );

  // Registered before the server start is awaited: an empty window activates
  // on "onUri" alone, and the handler waits out `starting` itself rather
  // than assuming the client is already there.
  const starting = start(context);
  context.subscriptions.push(
    vscode.window.registerUriHandler({
      handleUri: (uri) => void handleUri(context, uri, starting),
    }),
  );
  await starting;
}

/** Only `/join` is recognized; everything else this extension might one day
 *  route through `vscode://` is out of scope for now. */
async function handleUri(
  context: vscode.ExtensionContext,
  uri: vscode.Uri,
  starting: Promise<void>,
): Promise<void> {
  if (uri.path !== "/join") return;
  await starting;
  // `start()` already reported why, if the server never came up.
  if (!client) return;
  await runJoin(context, client, uri.toString());
}

export async function deactivate(): Promise<void> {
  await stop();
}

async function start(context: vscode.ExtensionContext): Promise<void> {
  let location;
  try {
    location = resolveServer(context);
  } catch (error) {
    if (error instanceof ServerNotFound) {
      void vscode.window.showErrorMessage(error.message);
      return;
    }
    throw error;
  }

  output.appendLine(`Starting ${location.command} (${location.origin})`);

  const run = { command: location.command, transport: TransportKind.stdio };
  const serverOptions: ServerOptions = { run, debug: run };

  const clientOptions: LanguageClientOptions = {
    documentSelector: [{ scheme: "file", language: "skema" }],
    outputChannel: output,
    synchronize: {
      // The server elects a project's root file by scanning the workspace,
      // so it has to hear about `.skema` files appearing, moving or being
      // deleted - not only about the ones an editor has open.
      fileEvents: vscode.workspace.createFileSystemWatcher("**/*.skema"),
    },
  };

  client = new LanguageClient("skema", "skema", serverOptions, clientOptions);

  try {
    await client.start();
  } catch (error) {
    client = undefined;
    void vscode.window.showErrorMessage(
      `Could not start the skema language server (${location.command}, ${location.origin}): ${String(error)}. ` +
        "Set skema.serverPath to a skema-lsp binary.",
    );
    return;
  }

  DocumentationProvider.setClient(client);

  context.subscriptions.push(
    // The server re-analyzes on every edit and says so; the panel answers by
    // asking for the model, but only while one is open - a notification is
    // cheap, a model is not.
    client.onNotification(MODEL_CHANGED_NOTIFICATION, () => {
      if (DiagramPanel.isOpen()) DiagramPanel.refreshCurrent();
      DocumentationProvider.refresh();
    }),
  );
}

async function stop(): Promise<void> {
  const running = client;
  client = undefined;
  DocumentationProvider.setClient(undefined);
  if (running) await running.stop();
}

async function exportDocumentation(): Promise<void> {
  if (!client) {
    void vscode.window.showWarningMessage("The skema language server is not running.");
    return;
  }
  const document = vscode.window.activeTextEditor?.document;
  if (!document || document.languageId !== "skema") {
    void vscode.window.showWarningMessage("Open a .skema file first.");
    return;
  }

  const markdown = await renderDocumentation(client, document.uri);
  const base = document.uri.path.split("/").pop()?.replace(/\.skema$/, "") ?? "model";
  const defaultUri = vscode.Uri.joinPath(vscode.Uri.file(dirname(document.uri.fsPath)), `${base}.md`);

  const target = await vscode.window.showSaveDialog({
    defaultUri,
    filters: { Markdown: ["md"] },
  });
  if (!target) return;

  await vscode.workspace.fs.writeFile(target, Buffer.from(markdown, "utf8"));
  void vscode.window.showInformationMessage(`Exported skema documentation to ${target.fsPath}`);
}

const OPEN_IN_BROWSER = "Open in browser";

/** How to use a copied invite or answer link, appended to the "copied"
 *  message - shared because `startCollabSession` and `inviteToCollabSession`
 *  both hand out the host's link. */
const HOW_TO_JOIN =
  'It opens directly in a browser; from VS Code, open it and choose "Open in VS Code", ' +
  'or paste it into "skema: Join collaboration session".';

/** Wraps a bare token from `session.ts` as a link `skema-editor` can open,
 *  per `skema.collab.editorUrl`. */
function editorLink(token: string): string {
  const editorUrl = vscode.workspace.getConfiguration("skema.collab").get<string>("editorUrl", "");
  return editorInviteUrl(editorUrl, token);
}

/** The host's "copied" message: an "Open in browser" action alongside the
 *  usual dismiss, since the clipboard now holds a link rather than a bare
 *  token. */
async function showHostLinkCopied(message: string, link: string): Promise<void> {
  const selection = await vscode.window.showInformationMessage(message, OPEN_IN_BROWSER);
  if (selection === OPEN_IN_BROWSER) void vscode.env.openExternal(vscode.Uri.parse(link));
}

/**
 * Starts hosting: opens the diagram (a session is only visible through its
 * presence on the canvas) and hands out an invite - a reusable one through
 * the public broker, or a one-time manual offer if the broker cannot be
 * reached (`session.ts`'s `Session.start`). `showInputBox`/the clipboard
 * stand in for `skema-editor`'s `CollabPanel`: enough for a first version,
 * not a full panel.
 */
async function startCollabSession(context: vscode.ExtensionContext): Promise<void> {
  if (!client) {
    void vscode.window.showWarningMessage("The skema language server is not running.");
    return;
  }
  if (isActive()) {
    void vscode.window.showWarningMessage("A collaboration session is already active.");
    return;
  }
  const panel = DiagramPanel.show(context, client, vscode.window.activeTextEditor?.document.uri);
  try {
    const invite = await startHosting(loadIdentity(context.globalState));
    const link = editorLink(invite);
    await panel.beginCollabSync("host");
    await vscode.env.clipboard.writeText(link);
    void vscode.commands.executeCommand("setContext", "skema.collab.hosting", true);
    void showHostLinkCopied(
      mode() === "auto"
        ? `Collaboration invite copied to clipboard as a link. ${HOW_TO_JOIN} Run "skema: Invite someone to the collaboration session" for another copy.`
        : `Collaboration invite copied to clipboard as a link - send it to whoever is joining. ${HOW_TO_JOIN} ` +
            'Once they answer, run "skema: Complete collaboration session" with what they send back.',
      link,
    );
  } catch (error) {
    void vscode.window.showErrorMessage(
      `Could not start a collaboration session: ${String(error)}`,
    );
  }
}

/** Hands out another way to join the session already being hosted: the same
 *  reusable invitation again in auto mode, one more one-time offer in
 *  manual mode. Visible only while hosting (`skema.collab.hosting`,
 *  `package.json`'s `commandPalette` `when`). */
async function inviteToCollabSession(): Promise<void> {
  try {
    const invite = await createInvite();
    const link = editorLink(invite);
    await vscode.env.clipboard.writeText(link);
    void showHostLinkCopied(
      mode() === "auto"
        ? `Invitation copied to clipboard as a link. ${HOW_TO_JOIN}`
        : `Invite copied to clipboard as a link - send it to whoever is joining. ${HOW_TO_JOIN} ` +
            'Once they answer, run "skema: Complete collaboration session" with what they send back.',
      link,
    );
  } catch (error) {
    void vscode.window.showErrorMessage(`Could not create an invitation: ${String(error)}`);
  }
}

/** The host side of completing a handshake: the guest's answer, pasted back. */
async function completeCollabSession(): Promise<void> {
  const answer = await vscode.window.showInputBox({
    prompt: "Paste the answer your collaborator sent back",
    ignoreFocusOut: true,
  });
  if (!answer) return;
  try {
    await completeHosting(answer);
  } catch (error) {
    void vscode.window.showErrorMessage(`Could not complete the session: ${String(error)}`);
  }
}

/** Joins a session from an invite pasted in - the command palette's way
 *  into the same flow the `vscode://.../join` URI uses (`runJoin`). */
async function joinCollabSession(context: vscode.ExtensionContext): Promise<void> {
  if (!client) {
    void vscode.window.showWarningMessage("The skema language server is not running.");
    return;
  }
  if (isActive()) {
    void vscode.window.showWarningMessage("A collaboration session is already active.");
    return;
  }
  const invite = await vscode.window.showInputBox({
    prompt: "Paste the collaboration invite you were sent",
    ignoreFocusOut: true,
  });
  if (!invite) return;
  await runJoin(context, client, invite);
}

interface JoinTarget {
  uri: vscode.Uri;
  /** Whether this was already an open workspace folder - if not, the folder
   *  is written into but never opened as a workspace mid-session (that
   *  reloads the window and would end the session just confirmed). */
  workspaceAlreadyOpen: boolean;
}

/** The confirmed decision's `"use"` folder, or a picker the user can
 *  cancel - run only after the modal above, so cancelling either one is
 *  the same as never having been asked. */
async function resolveJoinTarget(
  decision: FolderDecision,
  workspaceFolders: readonly vscode.WorkspaceFolder[],
): Promise<JoinTarget | undefined> {
  if (decision.kind === "use" && workspaceFolders[0]) {
    return { uri: workspaceFolders[0].uri, workspaceAlreadyOpen: true };
  }

  const picked = await vscode.window.showOpenDialog({
    canSelectFolders: true,
    canSelectFiles: false,
    canSelectMany: false,
    openLabel: "Join here",
  });
  const folder = picked?.[0];
  return folder ? { uri: folder, workspaceAlreadyOpen: false } : undefined;
}

/**
 * The one join path shared by the `vscode://.../join` URI and
 * `skema.collab.joinSession`: decode, confirm in a mandatory modal, resolve
 * the target folder, then join and start co-editing as a guest. Nothing
 * here writes a file before "Join" is clicked - any web page can fire the
 * URI, and joining is what puts the host's project on disk.
 */
async function runJoin(
  context: vscode.ExtensionContext,
  activeClient: LanguageClient,
  rawText: string,
): Promise<void> {
  const invite = parseJoinInvite(rawText);
  if (!invite) {
    void vscode.window.showErrorMessage("That does not look like a valid collaboration invite.");
    return;
  }
  if (isActive()) {
    void vscode.window.showWarningMessage("A collaboration session is already active.");
    return;
  }

  const workspaceFolders = vscode.workspace.workspaceFolders ?? [];
  const decision = decideFolder(workspaceFolders.map((folder) => folder.uri.fsPath));

  const { message, detail } = joinConfirmation(invite.name, decision);
  const choice = await vscode.window.showWarningMessage(message, { modal: true, detail }, "Join");
  if (!confirmed(choice)) return;

  const target = await resolveJoinTarget(decision, workspaceFolders);
  if (!target) return;

  const panel = DiagramPanel.show(context, activeClient, vscode.window.activeTextEditor?.document.uri);
  try {
    const answer = await joinSession(loadIdentity(context.globalState), rawText);
    await panel.beginCollabSync("guest", target.uri);
    if (!target.workspaceAlreadyOpen) unopenedJoinFolder = target.uri;
    if (!answer) {
      void vscode.window.showInformationMessage("Joined the collaboration session.");
      return;
    }
    await vscode.env.clipboard.writeText(editorLink(answer));
    void vscode.window.showInformationMessage(
      "Answer copied to clipboard as a link - send it back to whoever invited you.",
    );
  } catch (error) {
    void vscode.window.showErrorMessage(`Could not join the session: ${String(error)}`);
  }
}

function endCollabSession(): void {
  runEndOfSession<vscode.Uri>({
    isSessionActive: isActive,
    teardownCollabSync: () => DiagramPanel.endCollabSync(),
    endSession,
    setHostingContext: (hosting) =>
      void vscode.commands.executeCommand("setContext", "skema.collab.hosting", hosting),
    takeUnopenedJoinFolder: () => {
      const folder = unopenedJoinFolder;
      unopenedJoinFolder = undefined;
      return folder;
    },
    showSessionEnded: () => void vscode.window.showInformationMessage("Collaboration session ended."),
    offerToOpenFolder,
  });
}

const OPEN_FOLDER = "Open folder";

/** Reloading the window is harmless now that the session it would have
 *  ended has already ended. */
async function offerToOpenFolder(folder: vscode.Uri): Promise<void> {
  const choice = await vscode.window.showInformationMessage(
    "Collaboration session ended. The shared project's files are on disk.",
    OPEN_FOLDER,
  );
  if (choice === OPEN_FOLDER) void vscode.commands.executeCommand("vscode.openFolder", folder);
}
