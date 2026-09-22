/** A PeerJS-server client: the one file holding the wire protocol, as spoken by peerjs@1.5.5. */
import { brokerRoomId } from "@skema/collab-protocol";
import type { RTCIceServer } from "werift";
import WebSocket from "ws";

export interface BrokerServer {
  host: string;
  port: number;
  secure: boolean;
}

const PEERJS_CLOUD: BrokerServer = { host: "0.peerjs.com", port: 443, secure: true };
const PEERJS_KEY = "peerjs";
const PEERJS_VERSION = "1.5.5";

export const PEERJS_ICE_SERVERS: RTCIceServer[] = [
  { urls: "stun:stun.l.google.com:19302" },
  {
    urls: ["turn:eu-0.turn.peerjs.com:3478", "turn:us-0.turn.peerjs.com:3478"],
    username: "peerjs",
    credential: "peerjsp",
  },
];

/** Matches skema-editor's `BROKER_TIMEOUT_MS`. */
export const BROKER_TIMEOUT_MS = 5000;
const HEARTBEAT_MS = 5000;
const ID_ATTEMPTS = 3;
const RECONNECT_ATTEMPTS = 3;
const RECONNECT_BACKOFF_MS = 500;

export type OpenOutcome = "open" | "id-taken" | "down";

export interface SessionDescription {
  type: "offer" | "answer";
  sdp: string;
}

export interface IceCandidate {
  candidate: string;
  sdpMid?: string | undefined;
  sdpMLineIndex?: number | undefined;
  usernameFragment?: string | undefined;
}

export interface Offer {
  connectionId: string;
  label: string;
  reliable: boolean;
  sdp: SessionDescription;
}

export interface Answer {
  connectionId: string;
  sdp: SessionDescription;
}

export interface Candidate {
  connectionId: string;
  candidate: IceCandidate;
}

export interface BrokerListener {
  onOffer(src: string, offer: Offer): void;
  onAnswer(src: string, answer: Answer): void;
  onCandidate(src: string, candidate: Candidate): void;
  /** `src`'s broker socket closed. */
  onLeave(src: string): void;
  /** A message to `src` could not be delivered. */
  onExpire(src: string): void;
}

export interface BrokerOptions {
  server?: BrokerServer;
  newId?: () => string;
  /** Reconnecting after a drop failed: only guests who have not arrived yet are affected. */
  onLost?: () => void;
}

interface ServerMessage {
  type: string;
  src?: unknown;
  payload?: unknown;
}

function randomToken(): string {
  return Math.random().toString(36).slice(2);
}

export function newConnectionId(): string {
  return `dc_${randomToken()}`;
}

function delay(ms: number): Promise<void> {
  return new Promise((resolve) => setTimeout(resolve, ms));
}

export class Broker {
  private socket: WebSocket | undefined;
  private listener: BrokerListener | undefined;
  private readonly backlog: Array<(listener: BrokerListener) => void> = [];
  private heartbeat: NodeJS.Timeout | undefined;
  private closed = false;

  private constructor(
    readonly id: string,
    private readonly token: string,
    private readonly server: BrokerServer,
    private readonly onLost: (() => void) | undefined,
  ) {}

  /** `undefined` means the broker is down; a taken id is retried with a fresh one. */
  static async open(options: BrokerOptions = {}): Promise<Broker | undefined> {
    const newId = options.newId ?? brokerRoomId;
    for (let attempt = 0; attempt < ID_ATTEMPTS; attempt += 1) {
      const broker = new Broker(newId(), randomToken(), options.server ?? PEERJS_CLOUD, options.onLost);
      const outcome = await broker.connect();
      if (outcome === "open") return broker;
      broker.close();
      if (outcome === "down") return undefined;
    }
    return undefined;
  }

  /** Signals that arrive before a listener is attached are held for it. */
  listen(listener: BrokerListener): void {
    this.listener = listener;
    for (const deliver of this.backlog.splice(0)) deliver(listener);
  }

  sendOffer(dst: string, offer: Offer): void {
    this.send("OFFER", dst, {
      sdp: { type: offer.sdp.type, sdp: offer.sdp.sdp },
      type: "data",
      connectionId: offer.connectionId,
      label: offer.label,
      reliable: offer.reliable,
      serialization: "raw",
    });
  }

  sendAnswer(dst: string, answer: Answer): void {
    this.send("ANSWER", dst, {
      sdp: { type: answer.sdp.type, sdp: answer.sdp.sdp },
      type: "data",
      connectionId: answer.connectionId,
    });
  }

  sendCandidate(dst: string, { connectionId, candidate }: Candidate): void {
    this.send("CANDIDATE", dst, {
      candidate: {
        candidate: candidate.candidate,
        sdpMid: candidate.sdpMid,
        sdpMLineIndex: candidate.sdpMLineIndex,
      },
      type: "data",
      connectionId,
    });
  }

  close(): void {
    this.closed = true;
    clearInterval(this.heartbeat);
    this.socket?.close();
    this.socket = undefined;
  }

  private url(): string {
    const { host, port, secure } = this.server;
    const scheme = secure ? "wss" : "ws";
    return `${scheme}://${host}:${port}/peerjs?key=${PEERJS_KEY}&id=${this.id}&token=${this.token}&version=${PEERJS_VERSION}`;
  }

  private connect(): Promise<OpenOutcome> {
    return new Promise((resolve) => {
      let socket: WebSocket;
      try {
        socket = new WebSocket(this.url());
      } catch {
        resolve("down");
        return;
      }
      this.socket = socket;
      let settled = false;
      let opened = false;
      const settle = (outcome: OpenOutcome): void => {
        if (settled) return;
        settled = true;
        opened = outcome === "open";
        clearTimeout(timer);
        if (opened) this.heartbeat ??= setInterval(() => this.beat(), HEARTBEAT_MS);
        else socket.terminate();
        resolve(outcome);
      };
      const timer = setTimeout(() => settle("down"), BROKER_TIMEOUT_MS);

      socket.on("error", () => settle("down"));
      socket.on("close", () => {
        if (!settled) settle("down");
        else if (opened && socket === this.socket && !this.closed) void this.reconnect();
      });
      socket.on("message", (data) => {
        const message = parse(String(data));
        if (!message) return;
        switch (message.type) {
          case "OPEN":
            settle("open");
            return;
          case "ID-TAKEN":
            settle("id-taken");
            return;
          case "INVALID-KEY":
          case "ERROR":
            settle("down");
            return;
          default:
            this.dispatch(message);
        }
      });
    });
  }

  private async reconnect(): Promise<void> {
    for (let attempt = 0; attempt < RECONNECT_ATTEMPTS; attempt += 1) {
      await delay(RECONNECT_BACKOFF_MS * 2 ** attempt);
      if (this.closed) return;
      if ((await this.connect()) === "open") return;
    }
    if (!this.closed) this.onLost?.();
  }

  private beat(): void {
    if (this.socket?.readyState === WebSocket.OPEN) this.socket.send(JSON.stringify({ type: "HEARTBEAT" }));
  }

  private send(type: string, dst: string, payload: object): void {
    if (this.socket?.readyState !== WebSocket.OPEN) return;
    this.socket.send(JSON.stringify({ type, payload, dst }));
  }

  private dispatch({ type, src, payload }: ServerMessage): void {
    if (typeof src !== "string") return;
    switch (type) {
      case "OFFER": {
        const offer = readOffer(payload);
        if (offer) this.deliver((listener) => listener.onOffer(src, offer));
        return;
      }
      case "ANSWER": {
        const answer = readAnswer(payload);
        if (answer) this.deliver((listener) => listener.onAnswer(src, answer));
        return;
      }
      case "CANDIDATE": {
        const candidate = readCandidate(payload);
        if (candidate) this.deliver((listener) => listener.onCandidate(src, candidate));
        return;
      }
      case "LEAVE":
        this.deliver((listener) => listener.onLeave(src));
        return;
      case "EXPIRE":
        this.deliver((listener) => listener.onExpire(src));
    }
  }

  private deliver(signal: (listener: BrokerListener) => void): void {
    if (this.listener) signal(this.listener);
    else this.backlog.push(signal);
  }
}

function parse(text: string): ServerMessage | undefined {
  try {
    const value: unknown = JSON.parse(text);
    if (isRecord(value) && typeof value.type === "string") return value as unknown as ServerMessage;
  } catch {
    // Not JSON: ignored, as PeerJS does.
  }
  return undefined;
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null;
}

function readDescription(value: unknown, type: SessionDescription["type"]): SessionDescription | undefined {
  if (!isRecord(value) || value.type !== type || typeof value.sdp !== "string") return undefined;
  return { type, sdp: value.sdp };
}

function readDataPayload(value: unknown): (Record<string, unknown> & { connectionId: string }) | undefined {
  if (!isRecord(value) || value.type !== "data" || typeof value.connectionId !== "string") return undefined;
  return value as Record<string, unknown> & { connectionId: string };
}

/** Only `"raw"` serialization is accepted: anything else would need BinaryPack. */
function readOffer(value: unknown): Offer | undefined {
  const payload = readDataPayload(value);
  const sdp = readDescription(payload?.sdp, "offer");
  if (!payload || !sdp || typeof payload.label !== "string" || payload.serialization !== "raw") {
    return undefined;
  }
  return { connectionId: payload.connectionId, label: payload.label, reliable: !!payload.reliable, sdp };
}

function readAnswer(value: unknown): Answer | undefined {
  const payload = readDataPayload(value);
  const sdp = readDescription(payload?.sdp, "answer");
  return payload && sdp ? { connectionId: payload.connectionId, sdp } : undefined;
}

function readCandidate(value: unknown): Candidate | undefined {
  const payload = readDataPayload(value);
  const candidate = payload?.candidate;
  if (!payload || !isRecord(candidate) || typeof candidate.candidate !== "string" || !candidate.candidate) {
    return undefined;
  }
  return {
    connectionId: payload.connectionId,
    candidate: {
      candidate: candidate.candidate,
      sdpMid: typeof candidate.sdpMid === "string" ? candidate.sdpMid : undefined,
      sdpMLineIndex: typeof candidate.sdpMLineIndex === "number" ? candidate.sdpMLineIndex : undefined,
      usernameFragment:
        typeof candidate.usernameFragment === "string" ? candidate.usernameFragment : undefined,
    },
  };
}
