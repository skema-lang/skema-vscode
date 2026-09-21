/**
 * The broker path's `Link`, mirroring skema-editor's `AutoLink`: like PeerJS, each channel is its
 * own data connection on its own peer connection, so one peer is two of them.
 */
import { RTCPeerConnection, type RTCDataChannel, type RTCIceServer } from "werift";

import {
  AWARENESS_CHANNEL_LABEL,
  DOC_CHANNEL_LABEL,
  type Link,
  type LinkEvents,
  type LinkStatus,
} from "@skema/collab-protocol";

import {
  PEERJS_ICE_SERVERS,
  newConnectionId,
  type Answer,
  type Broker,
  type BrokerListener,
  type Candidate,
  type IceCandidate,
  type Offer,
  type SessionDescription,
} from "./broker";

type Signalling = Pick<Broker, "listen" | "sendOffer" | "sendAnswer" | "sendCandidate">;

/** Same wording as skema-editor's `AutoLink`. */
const RELAY_UNREACHABLE =
  "The host is not reachable through the relay anymore - they may have ended the session, or this link may be old.";

/** What skema-editor's host names a guest before presence says otherwise. */
const GUEST_NAME = "Invited";

function description(value: { type: string; sdp: string } | null): SessionDescription {
  if (!value || (value.type !== "offer" && value.type !== "answer")) {
    throw new Error("The connection produced no description to share");
  }
  return { type: value.type, sdp: value.sdp };
}

/** One PeerJS data connection. Remote candidates wait for the remote description. */
class Leg {
  private remoteSet = false;
  private readonly early: IceCandidate[] = [];

  constructor(readonly connection: RTCPeerConnection) {}

  async setRemote(sdp: SessionDescription): Promise<void> {
    await this.connection.setRemoteDescription(sdp);
    this.remoteSet = true;
    for (const candidate of this.early.splice(0)) await this.apply(candidate).catch(() => undefined);
  }

  async addCandidate(candidate: IceCandidate): Promise<void> {
    if (this.remoteSet) await this.apply(candidate);
    else this.early.push(candidate);
  }

  private apply(candidate: IceCandidate): Promise<void> {
    return this.connection.addIceCandidate({
      candidate: candidate.candidate,
      sdpMid: candidate.sdpMid ?? null,
      sdpMLineIndex: candidate.sdpMLineIndex ?? null,
      usernameFragment: candidate.usernameFragment ?? null,
    });
  }
}

export class AutoLink implements Link {
  readonly kind = "auto" as const;
  status: LinkStatus = "connecting";
  publicAddress = false;
  everConnected = false;
  reason?: string;

  private readonly legs = new Map<string, Leg>();
  private doc: RTCDataChannel | undefined;
  private awareness: RTCDataChannel | undefined;

  constructor(
    readonly id: string,
    public name: string,
    private readonly events: LinkEvents,
    private readonly signalling: Signalling,
    private readonly iceServers: RTCIceServer[],
  ) {}

  /** Guest side: the doc channel is reliable, awareness is not, as in skema-editor's `joinAuto`. */
  dial(): void {
    void this.offer(DOC_CHANNEL_LABEL, true);
    void this.offer(AWARENESS_CHANNEL_LABEL, false);
  }

  /** Host side: one of the guest's two offers. */
  async accept(offer: Offer, early: IceCandidate[]): Promise<void> {
    if (this.legs.has(offer.connectionId)) return;
    const leg = this.addLeg(offer.connectionId);
    for (const candidate of early) void leg.addCandidate(candidate);
    try {
      await leg.setRemote(offer.sdp);
      await leg.connection.setLocalDescription(await leg.connection.createAnswer());
      this.signalling.sendAnswer(this.id, {
        connectionId: offer.connectionId,
        sdp: description(leg.connection.localDescription),
      });
    } catch {
      this.settle("failed");
    }
  }

  async answer({ connectionId, sdp }: Answer): Promise<void> {
    try {
      await this.legs.get(connectionId)?.setRemote(sdp);
    } catch {
      this.settle("failed");
    }
  }

  has(connectionId: string): boolean {
    return this.legs.has(connectionId);
  }

  async addCandidate({ connectionId, candidate }: Candidate): Promise<void> {
    try {
      await this.legs.get(connectionId)?.addCandidate(candidate);
    } catch {
      // A candidate that does not apply is just one route fewer.
    }
  }

  peerLeft(): void {
    if (this.status === "connecting") this.settle("failed");
    else this.close();
  }

  /** Once connected, the link no longer needs the broker. */
  peerUnreachable(): void {
    if (this.status !== "connecting") return;
    this.reason ??= RELAY_UNREACHABLE;
    this.settle("failed");
  }

  sendDoc(message: Uint8Array): void {
    if (this.doc?.readyState === "open") this.doc.send(Buffer.from(message));
  }

  sendAwareness(message: Uint8Array): void {
    if (this.awareness?.readyState === "open") this.awareness.send(Buffer.from(message));
  }

  close(): void {
    if (this.status === "closed") return;
    this.status = "closed";
    this.doc?.close();
    this.awareness?.close();
    for (const leg of this.legs.values()) void leg.connection.close();
    this.events.onStatus(this);
  }

  private async offer(label: string, reliable: boolean): Promise<void> {
    const connectionId = newConnectionId();
    const leg = this.addLeg(connectionId);
    this.adopt(leg.connection.createDataChannel(label, { ordered: reliable }), leg.connection);
    try {
      await leg.connection.setLocalDescription(await leg.connection.createOffer());
      this.signalling.sendOffer(this.id, {
        connectionId,
        label,
        reliable,
        sdp: description(leg.connection.localDescription),
      });
    } catch {
      this.settle("failed");
    }
  }

  private addLeg(connectionId: string): Leg {
    const connection = new RTCPeerConnection({ iceServers: this.iceServers });
    const leg = new Leg(connection);
    this.legs.set(connectionId, leg);
    connection.addEventListener("icecandidate", ({ candidate }) => {
      if (!candidate?.candidate) return;
      this.signalling.sendCandidate(this.id, {
        connectionId,
        candidate: {
          candidate: candidate.candidate,
          sdpMid: candidate.sdpMid,
          sdpMLineIndex: candidate.sdpMLineIndex,
        },
      });
    });
    connection.addEventListener("datachannel", ({ channel }) => this.adopt(channel, connection));
    connection.addEventListener("iceconnectionstatechange", () => {
      if (connection.iceConnectionState === "failed") this.settle("failed");
    });
    return leg;
  }

  private adopt(channel: RTCDataChannel, connection: RTCPeerConnection): void {
    const document = channel.label === DOC_CHANNEL_LABEL;
    if (document) this.doc = channel;
    else this.awareness = channel;

    channel.addEventListener("message", (event: { data: string | Buffer }) => {
      if (typeof event.data === "string") return;
      if (document) this.events.onDoc(event.data, this);
      else this.events.onAwareness(event.data, this);
    });
    const opened = (): void => {
      if (connection.localDescription?.sdp.includes(" typ srflx")) this.publicAddress = true;
      if (document) {
        if (this.awareness?.readyState === "open") this.settle("connected");
      } else {
        this.events.onAwarenessReady(this);
        if (this.doc?.readyState === "open") this.settle("connected");
      }
    };
    if (channel.readyState === "open") opened();
    else channel.addEventListener("open", opened);
    channel.addEventListener("close", () => this.close());
  }

  private settle(next: LinkStatus): void {
    if (this.status === next || this.status === "closed") return;
    this.status = next;
    if (next === "connected") this.everConnected = true;
    this.events.onStatus(this);
  }
}

export interface AutoLinksOptions {
  /** Makes this side a host: called for each guest that arrives. */
  onGuest?: (link: AutoLink) => void;
  iceServers?: RTCIceServer[];
}

/** Routes one broker's signals to a `Link` per remote peer. */
export class AutoLinks implements BrokerListener {
  private readonly links = new Map<string, AutoLink>();
  /** Candidates that beat their offer here, as PeerJS's `_storeMessage` keeps them. */
  private readonly early = new Map<string, IceCandidate[]>();
  private readonly linkEvents: LinkEvents;
  private readonly onGuest: ((link: AutoLink) => void) | undefined;
  private readonly iceServers: RTCIceServer[];

  constructor(
    private readonly signalling: Signalling,
    events: LinkEvents,
    options: AutoLinksOptions = {},
  ) {
    this.onGuest = options.onGuest;
    this.iceServers = options.iceServers ?? PEERJS_ICE_SERVERS;
    this.linkEvents = {
      onDoc: (message, link) => events.onDoc(message, link),
      onAwareness: (message, link) => events.onAwareness(message, link),
      onAwarenessReady: (link) => events.onAwarenessReady(link),
      onStatus: (link) => {
        if (link.status === "closed" && this.links.get(link.id) === link) this.links.delete(link.id);
        events.onStatus(link);
      },
    };
    signalling.listen(this);
  }

  dial(hostId: string, name: string): AutoLink {
    const link = this.create(hostId, name);
    link.dial();
    return link;
  }

  onOffer(src: string, offer: Offer): void {
    if (!this.onGuest) return;
    let link = this.links.get(src);
    if (!link) {
      link = this.create(src, GUEST_NAME);
      this.onGuest(link);
    }
    const early = this.early.get(offer.connectionId) ?? [];
    this.early.delete(offer.connectionId);
    void link.accept(offer, early);
  }

  onAnswer(src: string, answer: Answer): void {
    void this.links.get(src)?.answer(answer);
  }

  onCandidate(src: string, candidate: Candidate): void {
    const link = this.links.get(src);
    if (link?.has(candidate.connectionId)) {
      void link.addCandidate(candidate);
      return;
    }
    const queued = this.early.get(candidate.connectionId) ?? [];
    queued.push(candidate.candidate);
    this.early.set(candidate.connectionId, queued);
  }

  onLeave(src: string): void {
    this.links.get(src)?.peerLeft();
  }

  onExpire(src: string): void {
    this.links.get(src)?.peerUnreachable();
  }

  private create(id: string, name: string): AutoLink {
    const link = new AutoLink(id, name, this.linkEvents, this.signalling, this.iceServers);
    this.links.set(id, link);
    return link;
  }
}
