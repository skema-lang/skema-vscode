import assert from "node:assert/strict";
import { test } from "node:test";

import { RTCPeerConnection, type RTCIceCandidate } from "werift";

import type { Link, LinkEvents } from "@skema/collab-protocol";

import { AutoLinks, type AutoLink } from "../src/collab/autoLink";
import { Broker, type BrokerListener, type IceCandidate } from "../src/collab/broker";
import { FakePeerServer, until, type Received } from "./fakePeerServer";
import fixtures from "./fixtures/peerjs-1.5.5-signalling.json";

const HOST = "skema-host";
const RELAY_UNREACHABLE =
  "The host is not reachable through the relay anymore - they may have ended the session, or this link may be old.";

class Recorder implements LinkEvents {
  readonly doc: number[][] = [];
  readonly awareness: number[][] = [];
  awarenessReady = 0;

  onDoc(message: Uint8Array): void {
    this.doc.push([...message]);
  }
  onAwareness(message: Uint8Array): void {
    this.awareness.push([...message]);
  }
  onAwarenessReady(): void {
    this.awarenessReady += 1;
  }
  onStatus: (link: Link) => void = () => undefined;
}

const ignore: BrokerListener = {
  onOffer: () => undefined,
  onAnswer: () => undefined,
  onCandidate: () => undefined,
  onLeave: () => undefined,
  onExpire: () => undefined,
};

async function open(fake: FakePeerServer, id?: string): Promise<Broker> {
  const broker = await Broker.open(id ? { server: fake.server, newId: () => id } : { server: fake.server });
  assert.ok(broker);
  return broker;
}

interface Pair {
  fake: FakePeerServer;
  hostBroker: Broker;
  guestBroker: Broker;
  hostEvents: Recorder;
  guestEvents: Recorder;
  hostLink: AutoLink;
  guestLink: AutoLink;
  close(): Promise<void>;
}

async function connectedPair(): Promise<Pair> {
  const fake = await FakePeerServer.start();
  const hostBroker = await open(fake, HOST);
  const guestBroker = await open(fake);
  const hostEvents = new Recorder();
  const guestEvents = new Recorder();
  const guests: AutoLink[] = [];
  new AutoLinks(hostBroker, hostEvents, { onGuest: (link) => guests.push(link), iceServers: [] });
  const guestLink = new AutoLinks(guestBroker, guestEvents, { iceServers: [] }).dial(HOST, "Host");

  await until(() => guestLink.status === "connected" && guests[0]?.status === "connected", 20_000);
  const hostLink = guests[0] as AutoLink;
  return {
    fake,
    hostBroker,
    guestBroker,
    hostEvents,
    guestEvents,
    hostLink,
    guestLink,
    async close() {
      hostLink.close();
      guestLink.close();
      hostBroker.close();
      guestBroker.close();
      await fake.close();
    },
  };
}

test("a host and a guest connect and round-trip doc and awareness both ways", async () => {
  const pair = await connectedPair();
  try {
    assert.equal(pair.guestLink.everConnected, true);
    assert.equal(pair.hostLink.id, pair.guestBroker.id);
    assert.equal(pair.hostLink.name, "Invited");
    assert.equal(pair.hostEvents.awarenessReady, 1);
    assert.equal(pair.guestEvents.awarenessReady, 1);

    pair.guestLink.sendDoc(new Uint8Array([1, 2, 3]));
    pair.guestLink.sendAwareness(new Uint8Array([4]));
    pair.hostLink.sendDoc(new Uint8Array([5, 6]));
    pair.hostLink.sendAwareness(new Uint8Array([7]));

    await until(
      () =>
        pair.hostEvents.doc.length === 1 &&
        pair.hostEvents.awareness.length === 1 &&
        pair.guestEvents.doc.length === 1 &&
        pair.guestEvents.awareness.length === 1,
    );
    assert.deepEqual(pair.hostEvents.doc, [[1, 2, 3]]);
    assert.deepEqual(pair.hostEvents.awareness, [[4]]);
    assert.deepEqual(pair.guestEvents.doc, [[5, 6]]);
    assert.deepEqual(pair.guestEvents.awareness, [[7]]);
  } finally {
    await pair.close();
  }
});

test("signalling JSON matches peerjs@1.5.5's Negotiator", async () => {
  const pair = await connectedPair();
  const guest = pair.guestBroker.id;
  const peers: Record<string, string> = { [HOST]: "<host>", [guest]: "<guest>" };
  const sent = (from: string, type: string): Received["message"][] =>
    pair.fake.received.filter((entry) => entry.from === from && entry.message.type === type).map((entry) => entry.message);
  try {
    const offers = sent(guest, "OFFER").map((message) => JSON.stringify(normalise(message, peers)));
    assert.deepEqual(offers.sort(), [JSON.stringify(fixtures.awarenessOffer), JSON.stringify(fixtures.docOffer)]);

    for (const answer of sent(HOST, "ANSWER")) {
      assert.equal(JSON.stringify(normalise(answer, peers)), JSON.stringify(fixtures.answer));
    }
    const candidates = [...sent(guest, "CANDIDATE"), ...sent(HOST, "CANDIDATE")];
    assert.ok(candidates.length > 0);
    for (const candidate of candidates) {
      const expected = { ...fixtures.candidate, dst: peers[candidate.dst ?? ""] };
      assert.equal(JSON.stringify(normalise(candidate, peers)), JSON.stringify(expected));
    }
  } finally {
    await pair.close();
  }
});

/** Replaces per-run values with the fixture's placeholders, checking their shape on the way. */
function normalise(message: Received["message"], peers: Record<string, string>): unknown {
  const copy = JSON.parse(JSON.stringify(message)) as {
    payload: {
      sdp?: { sdp: string };
      connectionId: string;
      candidate?: { candidate: string; sdpMid: string; sdpMLineIndex: number };
    };
    dst: string;
  };
  assert.match(copy.payload.connectionId, /^dc_[a-z0-9]+$/);
  copy.payload.connectionId = "<connectionId>";
  if (copy.payload.sdp) {
    assert.match(copy.payload.sdp.sdp, /^v=0\r\n/);
    copy.payload.sdp.sdp = "<sdp>";
  }
  if (copy.payload.candidate) {
    assert.match(copy.payload.candidate.candidate, /^candidate:/);
    assert.equal(typeof copy.payload.candidate.sdpMid, "string");
    copy.payload.candidate.candidate = "<candidate>";
    copy.payload.candidate.sdpMid = "<sdpMid>";
  }
  copy.dst = peers[copy.dst] ?? copy.dst;
  return copy;
}

test("a guest dialling an unknown room fails with the relay reason", async () => {
  const fake = await FakePeerServer.start();
  const broker = await open(fake);
  const link = new AutoLinks(broker, new Recorder(), { iceServers: [] }).dial("skema-nobody", "Host");
  try {
    await until(() => link.status !== "connecting");
    assert.equal(link.status, "failed");
    assert.equal(link.reason, RELAY_UNREACHABLE);
    assert.equal(link.everConnected, false);
  } finally {
    link.close();
    broker.close();
    await fake.close();
  }
});

test("LEAVE for a connected guest closes its link", async () => {
  const pair = await connectedPair();
  const statuses: string[] = [];
  const onStatus = (link: Link): void => void statuses.push(link.status);
  pair.hostEvents.onStatus = onStatus;
  try {
    pair.fake.drop(pair.guestBroker.id);
    await until(() => pair.hostLink.status === "closed");
    assert.deepEqual(statuses, ["closed"]);
  } finally {
    await pair.close();
  }
});

/** A peer that speaks the raw protocol itself, so the test controls message order. */
async function rawOffer(serialization: string): Promise<{ connection: RTCPeerConnection; offer: object; candidate: IceCandidate }> {
  const connection = new RTCPeerConnection({ iceServers: [] });
  connection.createDataChannel("skema-doc", { ordered: true });
  const first = new Promise<RTCIceCandidate>((resolve) => {
    connection.addEventListener("icecandidate", ({ candidate }) => {
      if (candidate?.candidate) resolve(candidate);
    });
  });
  await connection.setLocalDescription(await connection.createOffer());
  const found = await first;
  const sdp = connection.localDescription;
  assert.ok(sdp);
  return {
    connection,
    offer: {
      sdp: { type: sdp.type, sdp: sdp.sdp },
      type: "data",
      connectionId: "dc_raw",
      label: "skema-doc",
      reliable: true,
      serialization,
    },
    candidate: { candidate: found.candidate, sdpMid: found.sdpMid, sdpMLineIndex: found.sdpMLineIndex },
  };
}

test("a candidate that arrives before its offer is queued, then applied", async () => {
  const fake = await FakePeerServer.start();
  const hostBroker = await open(fake, HOST);
  const guestBroker = await open(fake, "skema-raw");
  guestBroker.listen(ignore);
  const guests: AutoLink[] = [];
  new AutoLinks(hostBroker, new Recorder(), { onGuest: (link) => guests.push(link), iceServers: [] });

  const applied: string[] = [];
  const original = RTCPeerConnection.prototype.addIceCandidate;
  RTCPeerConnection.prototype.addIceCandidate = function (this: RTCPeerConnection, candidate) {
    if (candidate?.candidate) applied.push(candidate.candidate);
    return original.call(this, candidate);
  };
  const raw = await rawOffer("raw");
  try {
    guestBroker.sendCandidate(HOST, { connectionId: "dc_raw", candidate: raw.candidate });
    await until(() => fake.received.some((entry) => entry.message.type === "CANDIDATE"));
    assert.deepEqual(applied, []);

    fake.inject(HOST, { type: "OFFER", src: "skema-raw", payload: raw.offer });
    await until(() => fake.received.some((entry) => entry.from === HOST && entry.message.type === "ANSWER"));
    assert.deepEqual(applied, [raw.candidate.candidate]);
    assert.equal(guests.length, 1);
  } finally {
    RTCPeerConnection.prototype.addIceCandidate = original;
    for (const link of guests) link.close();
    await raw.connection.close();
    hostBroker.close();
    guestBroker.close();
    await fake.close();
  }
});

test("an offer with a serialization other than raw is rejected", async () => {
  const fake = await FakePeerServer.start();
  const hostBroker = await open(fake, HOST);
  const guests: AutoLink[] = [];
  new AutoLinks(hostBroker, new Recorder(), { onGuest: (link) => guests.push(link), iceServers: [] });
  const raw = await rawOffer("binary");
  try {
    fake.inject(HOST, { type: "OFFER", src: "skema-raw", payload: raw.offer });
    await new Promise((resolve) => setTimeout(resolve, 300));
    assert.equal(guests.length, 0);
    assert.equal(fake.received.filter((entry) => entry.from === HOST).length, 0);
  } finally {
    await raw.connection.close();
    hostBroker.close();
    await fake.close();
  }
});
