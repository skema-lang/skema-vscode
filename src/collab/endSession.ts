/**
 * The one end-of-session procedure both the `skema.collab.endSession`
 * command and closing the diagram panel run (task 108) - kept `vscode`-free,
 * like `joinFlow.ts`, so the branch between "just ended" and "guest whose
 * files are in an unopened folder" (task 101) is testable without an editor.
 * `isSessionActive` doubles as the re-entrancy guard: whichever trigger runs
 * second finds no session left and does nothing.
 */
export interface EndOfSessionActions<Folder> {
  isSessionActive(): boolean;
  teardownCollabSync(): void;
  endSession(): void;
  setHostingContext(hosting: boolean): void;
  takeUnopenedJoinFolder(): Folder | undefined;
  showSessionEnded(): void;
  offerToOpenFolder(folder: Folder): void;
}

export function runEndOfSession<Folder>(actions: EndOfSessionActions<Folder>): void {
  if (!actions.isSessionActive()) return;
  actions.teardownCollabSync();
  actions.endSession();
  actions.setHostingContext(false);

  const folder = actions.takeUnopenedJoinFolder();
  if (folder !== undefined) actions.offerToOpenFolder(folder);
  else actions.showSessionEnded();
}
