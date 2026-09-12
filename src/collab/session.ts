/**
 * The extension host's collaboration session: a `Y.Doc`/`Awareness` pair
 * plus exactly one WebRTC link, negotiated by hand.
 *
 * All of it runs here, in the extension host, never in the webview - the
 * webview's CSP has no `connect-src` (`diagram/panel.ts`'s `html()`) and
 * this keeps that boundary untouched. Presence reaches the webview the same
 * way model/layout data already does: a `HostMessage` over `postMessage`.
 *
 * Deliberately simpler than `skema-editor`'s `session.ts` in three ways
 * this task does not need yet:
 * - No broker/auto-link mode - see `link.ts` for why.
 * - No shared-text binding. The `Y.Doc` exists so the wire protocol has
 *   something to synchronize, and so [task
 *   20](../../../../brain/tasks/20-vscode-live-text-coediting.md) can reuse
 *   this same session and transport instead of standing up a second one;
 *   nothing in this task writes to it.
 * - Exactly one link, not a host's several: a VSCode user and a browser
 *   user pairing off, not a multi-guest star hosted from this side.
 */
import { Awareness } from "y-protocols/awareness";
import * as Y from "yjs";

import type { Position, RemoteDrag } from "@skema/diagram";
import {
  awarenessUpdate,
  decodeInvite,
  encodeInvite,
  forgetAwareness,
  inviteId,
  readAwareness,
  readSync,
  syncStep1,
  syncUpdate,
  tokenFromText,
  type Invite,
  type Link,
  type LinkEvents,
} from "@skema/collab-protocol";

import type { CollabUser } from "./identity";
import { WeriftLink } from "./link";

export type SessionRole = "host" | "guest";

const DRAG_FIELD = "drag";
const USER_FIELD = "user";

export interface Listener {
  onRemoteDragsChanged(drags: RemoteDrag[]): void;
  /** A human-readable line for the status bar / an information message -
   *  connected, disconnected, why a link never came up. */
  onStatusChanged(message: string): void;
}

class Session {
  readonly role: SessionRole;
  readonly doc = new Y.Doc();
  readonly awareness = new Awareness(this.doc);
  private link: Link | undefined;

  constructor(
    role: SessionRole,
    private readonly user: CollabUser,
    private readonly listener: Listener,
  ) {
    this.role = role;
    this.awareness.setLocalStateField(USER_FIELD, this.user);

    this.doc.on("update", (update: Uint8Array, origin: unknown) => {
      if (origin === this.link) return;
      this.link?.sendDoc(syncUpdate(update));
    });

    this.awareness.on(
      "update",
      (changes: { added: number[]; updated: number[]; removed: number[] }, origin: unknown) => {
        if (origin === this.link) return;
        const clients = [...changes.added, ...changes.updated, ...changes.removed];
        this.link?.sendAwareness(awarenessUpdate(this.awareness, clients));
      },
    );

    let knownDrags = "";
    this.awareness.on("change", () => {
      const drags = this.remoteDrags();
      const signature = JSON.stringify(drags);
      if (signature === knownDrags) return;
      knownDrags = signature;
      this.listener.onRemoteDragsChanged(drags);
    });
  }

  private remoteDrags(): RemoteDrag[] {
    const drags: RemoteDrag[] = [];
    this.awareness.getStates().forEach((raw, client) => {
      if (client === this.doc.clientID) return;
      const state = raw as { [DRAG_FIELD]?: Record<string, Position> | null; user?: CollabUser };
      const positions = state[DRAG_FIELD];
      if (!positions || Object.keys(positions).length === 0) return;
      drags.push({
        name: state.user?.name ?? "Anonymous",
        color: state.user?.color ?? "#30bced",
        positions,
      });
    });
    return drags;
  }

  private events(): LinkEvents {
    return {
      onDoc: (message, link) => {
        const { reply, complete } = readSync(this.doc, message, link);
        if (reply) link.sendDoc(reply);
        if (complete) this.listener.onStatusChanged(`Connected to ${link.name}.`);
      },
      onAwareness: (message, link) => readAwareness(this.awareness, message, link),
      onAwarenessReady: (link) => {
        const clients = [...this.awareness.getStates().keys()];
        if (clients.length > 0) link.sendAwareness(awarenessUpdate(this.awareness, clients));
      },
      onStatus: (link) => {
        if (link.status === "connected") link.sendDoc(syncStep1(this.doc));
        if (link.status === "failed") {
          link.close();
          return;
        }
        if (link.status === "closed") {
          this.link = undefined;
          forgetAwareness(this.awareness, [...this.awareness.getStates().keys()], "link-closed");
          this.listener.onStatusChanged(
            link.everConnected
              ? `${link.name} left the session.`
              : unreachable(link),
          );
        }
      },
    };
  }

  /** Host side: creates an invitation for one guest. */
  async createInvite(): Promise<string> {
    const id = inviteId();
    const { peer, sdp } = await WeriftLink.offer(id, this.user.name, this.events());
    this.link = peer;
    return encodeInvite({ kind: "offer", id, name: this.user.name, sdp });
  }

  /** Host side: the answer that came back for the invitation above. */
  async acceptAnswer(token: string): Promise<void> {
    const invite = decode(token);
    if (!invite || invite.kind !== "answer") {
      throw new Error("That does not look like an answer.");
    }
    if (!this.link || !(this.link instanceof WeriftLink) || this.link.id !== invite.id) {
      throw new Error("That answer belongs to an invitation this session no longer has.");
    }
    this.link.name = invite.name;
    await this.link.acceptAnswer(invite.sdp);
  }

  /** Guest side: joins the session an offer invites this window to, and
   *  returns the answer to hand back. */
  async join(token: string): Promise<string> {
    const invite = decode(token);
    if (!invite || invite.kind !== "offer") {
      throw new Error("That does not look like a session invitation.");
    }
    const { peer, sdp } = await WeriftLink.answer(
      invite.id,
      invite.name,
      invite.sdp,
      this.events(),
    );
    this.link = peer;
    return encodeInvite({ kind: "answer", id: invite.id, name: this.user.name, sdp });
  }

  publishDrag(positions: Record<string, Position> | null): void {
    this.awareness.setLocalStateField(DRAG_FIELD, positions);
  }

  end(): void {
    forgetAwareness(this.awareness, [this.doc.clientID], "leaving");
    this.link?.close();
    this.awareness.destroy();
    this.doc.destroy();
  }
}

function decode(text: string): Invite | undefined {
  const token = tokenFromText(text);
  return token ? decodeInvite(token) : undefined;
}

/** Same story `skema-editor`'s session tells: without a relay, a link that
 *  never connects has hit one of exactly two walls. */
function unreachable(link: Link): string {
  return link.publicAddress
    ? "Could not reach the other side. There is no relay to fall back on, so a network that refuses a direct connection cannot be worked around."
    : "Could not reach the other side, and this window found no public address of its own.";
}

let current: Session | undefined;
let listener: Listener | undefined;

/** Registers what the session reports to - the diagram panel, to relay as
 *  `HostMessage`s. Exactly one subscriber; a second `setListener` call
 *  replaces the first rather than adding to it, since there is only ever
 *  one panel. */
export function setListener(next: Listener): void {
  listener = next;
}

function need(): Listener {
  if (!listener) throw new Error("No collaboration listener registered yet.");
  return listener;
}

export function isActive(): boolean {
  return current !== undefined;
}

export function role(): SessionRole | undefined {
  return current?.role;
}

/** Host side: starts a session and returns the invite to hand to a guest. */
export async function startHosting(user: CollabUser): Promise<string> {
  if (current) throw new Error("A collaboration session is already active.");
  current = new Session("host", user, need());
  try {
    return await current.createInvite();
  } catch (error) {
    current = undefined;
    throw error;
  }
}

/** Host side: completes the invite with the guest's answer. */
export async function completeHosting(answerToken: string): Promise<void> {
  if (!current || current.role !== "host") throw new Error("No invitation is waiting.");
  await current.acceptAnswer(answerToken);
}

/** Guest side: joins from an offer, returns the answer to send back. */
export async function joinSession(user: CollabUser, offerToken: string): Promise<string> {
  if (current) throw new Error("A collaboration session is already active.");
  current = new Session("guest", user, need());
  try {
    return await current.join(offerToken);
  } catch (error) {
    current = undefined;
    throw error;
  }
}

export function publishDrag(positions: Record<string, Position> | null): void {
  current?.publishDrag(positions);
}

export function endSession(): void {
  current?.end();
  current = undefined;
}
