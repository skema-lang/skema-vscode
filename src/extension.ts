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
import { DiagramPanel, readPreferences } from "./diagram/panel";
import { DocumentationProvider, renderDocumentation } from "./docs/provider";
import { ServerNotFound, resolveServer } from "./server";

let client: LanguageClient | undefined;
let output: vscode.OutputChannel;

export async function activate(context: vscode.ExtensionContext): Promise<void> {
  output = vscode.window.createOutputChannel("skema");
  context.subscriptions.push(output);

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

  await start(context);
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
