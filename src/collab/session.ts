/**
 * A session: one shared document, and the links that carry it - a star, the
 * same topology `skema-editor`'s `session.ts` uses and for the same reason:
 * with no server, only the host can afford to know everyone, so every guest
 * connects to it and the host passes on what it receives.
 *
 * All of it runs in the extension host, never the webview - the webview's
 * CSP has no `connect-src` (`diagram/panel.ts`'s `html()`) and this keeps
 * that boundary untouched. Presence reaches the webview the same way
 * model/layout data already does: a `HostMessage` over `postMessage`.
 *
 * Hosting tries the public broker first (`broker.ts`/`autoLink.ts`, task 98)
 * for one reusable invitation several guests can use, and falls back to a
 * manual offer/answer per guest - today's only path - when the broker cannot
 * be reached. Joining accepts either kind. The `Session` class is exported,
 * rather than only the module-level functions below it, so a test can hold
 * several independent sessions at once (a host and its guests) and drive
 * them with fake `Link`s or a fake broker, with no network involved.
 *
 * The shared-text binding [task
 * 20](../../../../brain/tasks/20-vscode-live-text-coediting.md) needed is
 * layered on top rather than living here: `projectSync.ts`/`projectHost.ts`
 * seed and adopt the project map, `textBinding.ts` binds it to open
 * documents, and `extension.ts` wires both to `onProjectSynced` below. This
 * module stays the transport, relaying and presence.
 */
import { Awareness } from "y-protocols/awareness";
import type { RTCIceServer } from "werift";
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

import { AutoLinks } from "./autoLink";
import { Broker, type BrokerServer } from "./broker";
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
  /** Fires once per link, the moment this side has everything the other
   *  side had when it came up (`readSync`'s `complete`). A host's project is
   *  already seeded by then (`extension.ts` seeds before handing out the
   *  first invite); a guest uses this moment to adopt it. Only a guest's own
   *  sync matters - `panel.ts` already ignores this for a host. */
  onProjectSynced(): void;
}

/** Overrides for tests: a fake broker server and, since `werift`'s STUN/TURN
 *  defaults need a real network, no ICE servers at all. */
export interface TransportOptions {
  server?: BrokerServer;
  newId?: () => string;
  iceServers?: RTCIceServer[];
}

function isLink(value: unknown): value is Link {
  return typeof value === "object" && value !== null && typeof (value as Link).sendDoc === "function";
}

export class Session {
  readonly role: SessionRole;
  readonly doc = new Y.Doc();
  readonly awareness = new Awareness(this.doc);
  /** Which handshake this session is using - set once a broker attempt has
   *  settled, one way or the other. */
  mode: "manual" | "auto" | undefined;

  /** By link id: the host's several, a guest's one. A manual link's id is
   *  the invitation it answered; an auto link's id is the remote peer's
   *  broker id. */
  private readonly links = new Map<string, Link>();
  /** Which awareness clients each link speaks for, so their cursors can go
   *  the moment the link does instead of timing out half a minute later. */
  private readonly clients = new Map<string, Set<number>>();
  /** The broker connection, host or guest side, only once `mode` is
   *  `"auto"`. */
  private broker: Broker | undefined;

  constructor(
    role: SessionRole,
    private readonly user: CollabUser,
    private readonly listener: Listener,
  ) {
    this.role = role;
    this.awareness.setLocalStateField(USER_FIELD, this.user);

    this.doc.on("update", (update: Uint8Array, origin: unknown) => {
      const message = syncUpdate(update);
      for (const link of this.links.values()) if (link !== origin) link.sendDoc(message);
    });

    this.awareness.on(
      "update",
      (changes: { added: number[]; updated: number[]; removed: number[] }, origin: unknown) => {
        if (isLink(origin)) this.remember(origin, changes);
        const clients = [...changes.added, ...changes.updated, ...changes.removed];
        const message = awarenessUpdate(this.awareness, clients);
        for (const link of this.links.values()) if (link !== origin) link.sendAwareness(message);
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

  private remember(
    link: Link,
    changes: { added: number[]; updated: number[]; removed: number[] },
  ): void {
    const clients = this.clients.get(link.id) ?? new Set<number>();
    for (const client of [...changes.added, ...changes.updated]) clients.add(client);
    for (const client of changes.removed) clients.delete(client);
    this.clients.set(link.id, clients);
  }

  events(): LinkEvents {
    return {
      onDoc: (message, link) => {
        const { reply, complete } = readSync(this.doc, message, link);
        if (reply) link.sendDoc(reply);
        if (complete) this.listener.onProjectSynced();
      },
      onAwareness: (message, link) => readAwareness(this.awareness, message, link),
      onAwarenessReady: (link) => {
        const clients = [...this.awareness.getStates().keys()];
        if (clients.length > 0) link.sendAwareness(awarenessUpdate(this.awareness, clients));
      },
      onStatus: (link) => {
        if (link.status === "connected") {
          link.sendDoc(syncStep1(this.doc));
          this.listener.onStatusChanged(`Connected to ${link.name}.`);
        }
        // ICE giving up is not a state worth sitting in: take the link down
        // and let the closing below say what happened.
        if (link.status === "failed") {
          link.close();
          return;
        }
        if (link.status === "closed") {
          this.links.delete(link.id);
          const clients = this.clients.get(link.id);
          this.clients.delete(link.id);
          if (clients && clients.size > 0) forgetAwareness(this.awareness, [...clients], "link-closed");
          this.listener.onStatusChanged(
            link.everConnected ? `${link.name} left the session.` : unreachable(link),
          );
        }
      },
    };
  }

  attach(link: Link): void {
    this.links.set(link.id, link);
  }

  /** Host side: tries the broker for one reusable invitation, falling back
   *  to a manual offer when it cannot be reached. Returns the first
   *  invitation to hand to a guest. */
  async start(transport: TransportOptions = {}): Promise<string> {
    const broker = await Broker.open({
      ...(transport.server ? { server: transport.server } : {}),
      ...(transport.newId ? { newId: transport.newId } : {}),
      onLost: () =>
        this.listener.onStatusChanged(
          "The invitation relay was lost. Already-connected guests are unaffected, but the invitation no longer works for new ones.",
        ),
    });
    if (broker) {
      this.mode = "auto";
      this.broker = broker;
      new AutoLinks(broker, this.events(), {
        onGuest: (link) => this.attach(link),
        ...(transport.iceServers ? { iceServers: transport.iceServers } : {}),
      });
    } else {
      this.mode = "manual";
    }
    return this.createInvite();
  }

  /** Another way to join: the same reusable invitation in auto mode, one
   *  more one-time offer - a new `WeriftLink` keyed by its invite id - in
   *  manual mode. */
  async createInvite(): Promise<string> {
    if (this.mode === "auto") {
      if (!this.broker) throw new Error("The broker connection is not open.");
      return encodeInvite({ kind: "auto", id: this.broker.id, name: this.user.name });
    }
    const id = inviteId();
    const { peer, sdp } = await WeriftLink.offer(id, this.user.name, this.events());
    this.attach(peer);
    return encodeInvite({ kind: "offer", id, name: this.user.name, sdp });
  }

  /** Host side: the answer that came back for one manual invitation,
   *  matched to its pending link by invite id. */
  async acceptAnswer(token: string): Promise<void> {
    const invite = decode(token);
    if (!invite || invite.kind !== "answer") {
      throw new Error("That does not look like an answer.");
    }
    const link = this.links.get(invite.id);
    if (!link || !(link instanceof WeriftLink)) {
      throw new Error("That answer belongs to an invitation this session no longer has.");
    }
    link.name = invite.name;
    await link.acceptAnswer(invite.sdp);
  }

  /** Guest side: joins from an `auto` or `offer` invitation. An auto join
   *  needs no answer sent back - `undefined` says so explicitly. */
  async join(token: string, transport: TransportOptions = {}): Promise<string | undefined> {
    const invite = decode(token);
    if (!invite || (invite.kind !== "offer" && invite.kind !== "auto")) {
      throw new Error("That does not look like a session invitation.");
    }
    if (invite.kind === "auto") {
      const broker = await Broker.open({
        ...(transport.server ? { server: transport.server } : {}),
        ...(transport.newId ? { newId: transport.newId } : {}),
      });
      if (!broker) {
        throw new Error(
          "Could not reach the relay this link needs to connect. Ask whoever invited you for a manual link instead.",
        );
      }
      this.mode = "auto";
      this.broker = broker;
      const link = new AutoLinks(broker, this.events(), {
        ...(transport.iceServers ? { iceServers: transport.iceServers } : {}),
      }).dial(invite.id, invite.name);
      this.attach(link);
      return undefined;
    }
    this.mode = "manual";
    const { peer, sdp } = await WeriftLink.answer(invite.id, invite.name, invite.sdp, this.events());
    this.attach(peer);
    return encodeInvite({ kind: "answer", id: invite.id, name: this.user.name, sdp });
  }

  publishDrag(positions: Record<string, Position> | null): void {
    this.awareness.setLocalStateField(DRAG_FIELD, positions);
  }

  end(): void {
    forgetAwareness(this.awareness, [this.doc.clientID], "leaving");
    for (const link of [...this.links.values()]) link.close();
    this.broker?.close();
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

/** Which handshake the active session is using - `undefined` until hosting
 *  or joining has settled on one. `extension.ts` uses this to word its
 *  messages differently for a reusable broker invitation and a one-time
 *  manual offer. */
export function mode(): "manual" | "auto" | undefined {
  return current?.mode;
}

/** The active session's shared document - `undefined` when there is no
 *  session, the same lifetime `isActive()` already describes. Exposed so
 *  `textBinding.ts` can bind open documents to it and `projectHost.ts` can
 *  seed/adopt it, without either owning the session's lifecycle. */
export function currentDoc(): Y.Doc | undefined {
  return current?.doc;
}

/** Host side: starts a session and returns the invite to hand to the first
 *  guest. */
export async function startHosting(user: CollabUser): Promise<string> {
  if (current) throw new Error("A collaboration session is already active.");
  const session = new Session("host", user, need());
  current = session;
  try {
    return await session.start();
  } catch (error) {
    current = undefined;
    throw error;
  }
}

/** Host side: another invitation for another guest - see `Session.createInvite`. */
export async function createInvite(): Promise<string> {
  if (!current || current.role !== "host") throw new Error("No active hosting session.");
  return current.createInvite();
}

/** Host side: completes one manual invitation with the guest's answer. */
export async function completeHosting(answerToken: string): Promise<void> {
  if (!current || current.role !== "host") throw new Error("No invitation is waiting.");
  await current.acceptAnswer(answerToken);
}

/** Guest side: joins from an invite, returns the answer to send back - or
 *  `undefined` for an auto invite, which needs none. */
export async function joinSession(user: CollabUser, token: string): Promise<string | undefined> {
  if (current) throw new Error("A collaboration session is already active.");
  const session = new Session("guest", user, need());
  current = session;
  try {
    return await session.join(token);
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
