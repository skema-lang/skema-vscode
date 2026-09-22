/** Just enough of a PeerJS server to route signalling between clients on localhost. */
import type { AddressInfo } from "node:net";

import WebSocket, { WebSocketServer } from "ws";

import type { BrokerServer } from "../src/collab/broker";

interface Client {
  socket: WebSocket;
  token: string;
  contacts: Set<string>;
}

export function until(condition: () => boolean, timeoutMs = 10_000): Promise<void> {
  const deadline = Date.now() + timeoutMs;
  return new Promise((resolve, reject) => {
    const poll = (): void => {
      if (condition()) resolve();
      else if (Date.now() > deadline) reject(new Error("timed out waiting"));
      else setTimeout(poll, 20);
    };
    poll();
  });
}

export interface Received {
  from: string;
  message: { type: string; payload?: unknown; dst?: string };
}

export class FakePeerServer {
  readonly received: Received[] = [];
  readonly urls: string[] = [];
  private readonly clients = new Map<string, Client>();

  private constructor(private readonly wss: WebSocketServer) {
    wss.on("connection", (socket, request) => this.accept(socket, request.url ?? ""));
  }

  static start(): Promise<FakePeerServer> {
    return new Promise((resolve) => {
      const wss: WebSocketServer = new WebSocketServer({ host: "127.0.0.1", port: 0 }, () =>
        resolve(new FakePeerServer(wss)),
      );
    });
  }

  get server(): BrokerServer {
    return { host: "127.0.0.1", port: (this.wss.address() as AddressInfo).port, secure: false };
  }

  /** Drops a client's socket, as a network failure would. */
  drop(id: string): void {
    this.clients.get(id)?.socket.terminate();
  }

  /** Sends a raw message to a client, as if another peer had. */
  inject(dst: string, message: object): void {
    this.clients.get(dst)?.socket.send(JSON.stringify(message));
  }

  close(): Promise<void> {
    for (const client of this.clients.values()) client.socket.terminate();
    return new Promise((resolve) => this.wss.close(() => resolve()));
  }

  private accept(socket: WebSocket, url: string): void {
    this.urls.push(url);
    const params = new URL(url, "http://localhost").searchParams;
    const id = params.get("id") ?? "";
    const token = params.get("token") ?? "";
    const existing = this.clients.get(id);
    if (existing && existing.token !== token) {
      socket.send(JSON.stringify({ type: "ID-TAKEN", payload: { msg: "ID is taken" } }));
      socket.close();
      return;
    }
    const client: Client = { socket, token, contacts: existing?.contacts ?? new Set() };
    this.clients.set(id, client);
    socket.send(JSON.stringify({ type: "OPEN" }));

    socket.on("message", (data) => this.route(id, JSON.parse(String(data)) as Received["message"]));
    socket.on("close", () => {
      if (this.clients.get(id) !== client) return;
      this.clients.delete(id);
      for (const contact of client.contacts) {
        this.clients.get(contact)?.socket.send(JSON.stringify({ type: "LEAVE", src: id, dst: contact }));
      }
    });
  }

  private route(src: string, message: Received["message"]): void {
    this.received.push({ from: src, message });
    if (message.type === "HEARTBEAT" || !message.dst) return;
    const target = this.clients.get(message.dst);
    if (!target) {
      this.clients.get(src)?.socket.send(JSON.stringify({ type: "EXPIRE", src: message.dst, dst: src }));
      return;
    }
    this.clients.get(src)?.contacts.add(message.dst);
    target.contacts.add(src);
    target.socket.send(JSON.stringify({ ...message, src }));
  }
}
