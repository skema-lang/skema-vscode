/**
 * The one join path the `vscode://` handler and `skema.collab.joinSession`
 * both go through: decode, decide the target folder, and word the mandatory
 * confirmation - kept `vscode`-free, like `session.ts` and `editorLink.ts`,
 * so it is unit-testable without an editor. The `vscode` calls it decides
 * for (`showWarningMessage`, `showOpenDialog`) belong to `extension.ts`.
 */
import { decodeInvite, tokenFromText, type Invite } from "@skema/collab-protocol";

/** Untrusted plain text from whoever sent the invite - long enough to read,
 *  short enough that a modal cannot be used to hide the rest of its text. */
const MAX_INVITER_NAME_LENGTH = 60;

/**
 * The invite a join may proceed with, or `undefined` for anything unusable:
 * no token found, an undecodable token, or a kind this flow does not join -
 * an `answer` token (the host's side of a manual handshake) most of all,
 * since a browser never builds a `vscode://` link carrying one.
 */
export function parseJoinInvite(text: string): Invite | undefined {
  const token = tokenFromText(text);
  if (!token) return undefined;
  const invite = decodeInvite(token);
  if (!invite || (invite.kind !== "offer" && invite.kind !== "auto")) return undefined;
  return invite;
}

function truncateInviterName(name: string): string {
  return name.length > MAX_INVITER_NAME_LENGTH
    ? `${name.slice(0, MAX_INVITER_NAME_LENGTH)}…`
    : name;
}

export type FolderDecision = { kind: "use"; path: string } | { kind: "ask" };

/** `workspaceFolders[0]` if one is open; otherwise the caller has to ask
 *  with `showOpenDialog`, after the modal below is confirmed. Takes paths
 *  rather than `vscode.WorkspaceFolder`s so this stays free of the
 *  `vscode` type, too. */
export function decideFolder(openWorkspaceFolderPaths: readonly string[]): FolderDecision {
  const first = openWorkspaceFolderPaths[0];
  return first !== undefined ? { kind: "use", path: first } : { kind: "ask" };
}

export interface JoinConfirmation {
  message: string;
  detail: string;
}

const OVERWRITE_WARNING = "Files there with the same relative path will be overwritten.";

/**
 * The text for the mandatory `showWarningMessage(message, { modal: true,
 * detail }, "Join")` - the only place a join may be approved. The detail
 * names the target folder when one is already open; otherwise the folder
 * picker runs only after this same modal is confirmed, so it says that
 * instead.
 */
export function joinConfirmation(inviterName: string, folder: FolderDecision): JoinConfirmation {
  const detail =
    folder.kind === "use"
      ? `The shared project will be written into ${folder.path}. ${OVERWRITE_WARNING}`
      : `You will be asked to choose a folder for the shared project. ${OVERWRITE_WARNING}`;
  return {
    message: `${truncateInviterName(inviterName)} invited you to a skema collaboration session. Join?`,
    detail,
  };
}

/** Whether `showWarningMessage`'s answer was the one button that proceeds -
 *  anything else, including the modal being dismissed, is "no join". */
export function confirmed(choice: string | undefined): boolean {
  return choice === "Join";
}
