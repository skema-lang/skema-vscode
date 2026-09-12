/**
 * One WebRTC link to one other person, negotiated by hand - the extension
 * host's counterpart to `skema-editor`'s `PeerLink` (`connection.ts`).
 *
 * VSCode's extension API has no networking or WebRTC primitive, and the
 * extension host is a plain Node.js process, so this uses `werift` - a
 * pure-JS/TS WebRTC implementation - instead of the browser's built-in
 * `RTCPeerConnection`. werift's public API mirrors the W3C shape closely
 * enough (`createOffer`/`createAnswer`/`setLocalDescription`/
 * `setRemoteDescription`, the same `"datachannel"`/`"icecandidate"`/
 * `"connectionstatechange"`/`"iceconnectionstatechange"` event names on
 * `addEventListener`, the same `"open"`/`"close"`/`"message"` on a data
 * channel) that this is a port, not a rewrite - see `PeerLink` for the
 * design this follows.
 *
 * Only the manual, hand-carried-offer/answer mode is implemented here.
 * There is no broker/PeerJS-equivalent path: PeerJS's own client assumes a
 * browser, and the task this exists for only asks for compatibility with
 * `PeerLink`'s fallback, STUN-only mode.
 *
 * There is deliberately no TURN relay, for the same reason `PeerLink` has
 * none: two peers behind NATs that will not hole-punch simply cannot reach
 * each other over this path.
 */
import {
  RTCPeerConnection,
  type RTCDataChannel,
  type RTCIceServer,
  type RTCPeerConnectionIceEvent,
} from "werift";

import type { Link, LinkEvents, LinkStatus } from "@skema/collab-protocol";

const ICE_SERVERS: RTCIceServer[] = [
  { urls: ["stun:stun.l.google.com:19302", "stun:stun.cloudflare.com:3478"] },
];

/** How long gathering may stay silent before it is taken to be finished. */
const QUIET_MS = 1200;
/** And the point at which it has had long enough regardless. */
const GATHERING_CAP_MS = 8000;

const DOC_CHANNEL = "skema-doc";
const AWARENESS_CHANNEL = "skema-awareness";

/**
 * Resolves once the local description has the candidates worth waiting for.
 *
 * Waiting for `complete` alone is not good enough in practice: a STUN
 * server that never answers keeps the agent gathering until its own
 * timeout, which is far longer than anyone will watch a spinner, and the
 * candidates that matter have long since arrived. So the end of gathering
 * is whichever comes first - the end-of-candidates signal, the state
 * saying `complete`, gathering going quiet, or a hard cap.
 */
function gathered(connection: RTCPeerConnection): Promise<void> {
  if (connection.iceGatheringState === "complete") return Promise.resolve();
  return new Promise((resolve) => {
    const finish = (): void => {
      clearTimeout(quiet);
      clearTimeout(cap);
      connection.removeEventListener("icecandidate", onCandidate);
      connection.removeEventListener("icegatheringstatechange", onState);
      resolve();
    };
    const onCandidate = (event: RTCPeerConnectionIceEvent): void => {
      // No candidate is the agent saying there will be no more.
      if (!event.candidate) {
        finish();
        return;
      }
      clearTimeout(quiet);
      quiet = setTimeout(finish, QUIET_MS);
    };
    const onState = (): void => {
      if (connection.iceGatheringState === "complete") finish();
    };

    let quiet = setTimeout(finish, QUIET_MS * 2);
    const cap = setTimeout(finish, GATHERING_CAP_MS);
    connection.addEventListener("icecandidate", onCandidate);
    connection.addEventListener("icegatheringstatechange", onState);
  });
}

export class WeriftLink implements Link {
  readonly id: string;
  readonly kind = "manual" as const;
  name: string;
  status: LinkStatus = "connecting";
  /** Whether gathering found an address reachable from outside this
   *  network. Without one, only a peer on the same network can answer this
   *  link at all - worth saying out loud when nothing connects. */
  publicAddress = false;
  /** Distinguishes "they left" from "we never got through". */
  everConnected = false;

  private readonly connection: RTCPeerConnection;
  private readonly events: LinkEvents;
  private doc: RTCDataChannel | undefined;
  private awareness: RTCDataChannel | undefined;

  private constructor(id: string, name: string, events: LinkEvents) {
    this.id = id;
    this.name = name;
    this.events = events;
    this.connection = new RTCPeerConnection({ iceServers: ICE_SERVERS });
    this.connection.addEventListener("datachannel", (event) => this.adopt(event.channel));
    // `disconnected` is deliberately not terminal: ICE recovers from a
    // short network drop on its own, with the candidates it already has,
    // and there is no second chance to renegotiate if this gives up early.
    this.connection.addEventListener("connectionstatechange", () => {
      const state = this.connection.connectionState;
      if (state === "closed") this.close();
      else if (state === "failed") this.settle("failed");
    });
    this.connection.addEventListener("iceconnectionstatechange", () => {
      if (this.connection.iceConnectionState === "failed") this.settle("failed");
    });
  }

  /** The inviting side: both channels exist before the offer, so they are
   *  part of what the other side accepts. */
  static async offer(
    id: string,
    name: string,
    events: LinkEvents,
  ): Promise<{ peer: WeriftLink; sdp: string }> {
    const peer = new WeriftLink(id, name, events);
    peer.adopt(peer.connection.createDataChannel(DOC_CHANNEL, { ordered: true }));
    peer.adopt(
      peer.connection.createDataChannel(AWARENESS_CHANNEL, { ordered: false, maxRetransmits: 0 }),
    );
    await peer.connection.setLocalDescription(await peer.connection.createOffer());
    await gathered(peer.connection);
    return { peer, sdp: peer.localSdp() };
  }

  /** The invited side: the channels arrive with the offer. */
  static async answer(
    id: string,
    name: string,
    offerSdp: string,
    events: LinkEvents,
  ): Promise<{ peer: WeriftLink; sdp: string }> {
    const peer = new WeriftLink(id, name, events);
    await peer.connection.setRemoteDescription({ type: "offer", sdp: offerSdp });
    await peer.connection.setLocalDescription(await peer.connection.createAnswer());
    await gathered(peer.connection);
    return { peer, sdp: peer.localSdp() };
  }

  async acceptAnswer(sdp: string): Promise<void> {
    await this.connection.setRemoteDescription({ type: "answer", sdp });
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
    void this.connection.close();
    this.events.onStatus(this);
  }

  /** Moves the link on and tells the session, once per state. Closed is
   *  final: a link that has been taken down says nothing more. */
  private settle(next: LinkStatus): void {
    if (this.status === next || this.status === "closed") return;
    this.status = next;
    if (next === "connected") this.everConnected = true;
    this.events.onStatus(this);
  }

  private localSdp(): string {
    const sdp = this.connection.localDescription?.sdp;
    if (!sdp) throw new Error("The connection produced no description to share");
    // The one thing about this description worth reporting in plain words:
    // whether STUN answered at all.
    this.publicAddress = sdp.includes(" typ srflx");
    return sdp;
  }

  private adopt(channel: RTCDataChannel): void {
    const document = channel.label === DOC_CHANNEL;
    if (document) this.doc = channel;
    else this.awareness = channel;

    channel.addEventListener("message", (event: { data: string | Buffer }) => {
      if (typeof event.data === "string") return;
      if (document) this.events.onDoc(event.data, this);
      else this.events.onAwareness(event.data, this);
    });
    // The document channel decides whether the link is up: awareness is
    // useless on its own. Each channel still announces itself, because
    // each is only safe to write to once it is open.
    if (document) {
      channel.addEventListener("open", () => this.settle("connected"));
      channel.addEventListener("close", () => this.close());
    } else {
      channel.addEventListener("open", () => this.events.onAwarenessReady(this));
    }
  }
}
