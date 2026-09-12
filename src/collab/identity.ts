/**
 * Who this VSCode window is to the other people in a session.
 *
 * The browser side keeps this in `localStorage`; the extension host's
 * equivalent is `ExtensionContext.globalState` - both are per-installation,
 * not per-project, storage.
 */
import * as os from "node:os";
import type * as vscode from "vscode";

const STORAGE_KEY = "skema.collab.identity.v1";

/** The same palette `skema-editor` picks from, so a cursor's colour means
 *  the same thing regardless of which host drew it. */
const COLORS = [
  "#30bced",
  "#6eeb83",
  "#ffbc42",
  "#ecd444",
  "#ee6352",
  "#9ac2c9",
  "#c792ea",
  "#f78c6c",
];

export interface CollabUser {
  name: string;
  color: string;
}

function fresh(): CollabUser {
  const color = COLORS[Math.floor(Math.random() * COLORS.length)] ?? "#30bced";
  const name = os.userInfo().username || "VSCode";
  return { name, color };
}

export function loadIdentity(state: vscode.Memento): CollabUser {
  const stored = state.get<CollabUser>(STORAGE_KEY);
  if (stored?.name && stored.color) return stored;
  const user = fresh();
  void state.update(STORAGE_KEY, user);
  return user;
}
