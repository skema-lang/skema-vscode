import assert from "node:assert/strict";
import { test } from "node:test";

import { Awareness } from "y-protocols/awareness";
import * as Y from "yjs";

import {
  awarenessUpdate,
  encodeInvite,
  readAwareness,
  type Link,
  type LinkStatus,
} from "@skema/collab-protocol";

import { Session, type Listener, type TransportOptions } from "../src/collab/session";
import { FakePeerServer, until } from "./fakePeerServer";

/** A `Link` double for the unit tests: records what was sent to it, and
 *  needs no network or werift connection to exist. */
class FakeLink implements Link {
  readonly kind: "manual" | "auto" = "manual";
  status: LinkStatus = "connecting";
  publicAddress = false;
  everConnected = false;
  reason?: string;
  readonly docSent: Uint8Array[] = [];
  readonly awarenessSent: Uint8Array[] = [];
  closed = false;

  constructor(
    readonly id: string,
    public name = id,
  ) {}

  sendDoc(message: Uint8Array): void {
    this.docSent.push(message);
  }
  sendAwareness(message: Uint8Array): void {
    this.awarenessSent.push(message);
  }
  close(): void {
    this.closed = true;
  }
}

interface RecordingListener extends Listener {
  messages: string[];
  synced: number;
}

function fakeListener(): RecordingListener {
  return {
    messages: [],
    synced: 0,
    onRemoteDragsChanged: () => undefined,
    onStatusChanged(message: string) {
      this.messages.push(message);
    },
    onProjectSynced() {
      this.synced += 1;
    },
  };
}

function user(name: string): { name: string; color: string } {
  return { name, color: "#30bced" };
}

test("a relay goes from A to B and never back to A", () => {
  const session = new Session("host", user("Host"), fakeListener());
  const a = new FakeLink("a");
  const b = new FakeLink("b");
  session.attach(a);
  session.attach(b);

  session.doc.transact(() => {
    session.doc.getText("shared").insert(0, "hi");
  }, a);

  assert.equal(a.docSent.length, 0);
  assert.equal(b.docSent.length, 1);

  session.end();
});

test("when a link closes, its awareness clients are forgotten and everyone else's are kept", () => {
  const listener = fakeListener();
  const session = new Session("host", user("Host"), listener);
  const a = new FakeLink("a", "Guest A");
  const b = new FakeLink("b", "Guest B");
  session.attach(a);
  session.attach(b);

  const remoteA = new Y.Doc();
  const awarenessA = new Awareness(remoteA);
  awarenessA.setLocalStateField("user", { name: "Guest A" });
  readAwareness(session.awareness, awarenessUpdate(awarenessA, [awarenessA.clientID]), a);

  const remoteB = new Y.Doc();
  const awarenessB = new Awareness(remoteB);
  awarenessB.setLocalStateField("user", { name: "Guest B" });
  readAwareness(session.awareness, awarenessUpdate(awarenessB, [awarenessB.clientID]), b);

  assert.ok(session.awareness.getStates().has(awarenessA.clientID));
  assert.ok(session.awareness.getStates().has(awarenessB.clientID));

  a.everConnected = true;
  a.status = "closed";
  session.events().onStatus(a);

  assert.ok(!session.awareness.getStates().has(awarenessA.clientID));
  assert.ok(session.awareness.getStates().has(awarenessB.clientID));
  assert.ok(session.awareness.getStates().has(session.doc.clientID));
  assert.ok(listener.messages.includes("Guest A left the session."));

  session.end();
  remoteA.destroy();
  remoteB.destroy();
});

test("an answer for an unknown or already-closed invitation is rejected with the existing message", async () => {
  const session = new Session("host", user("Host"), fakeListener());
  const rejection = /this session no longer has/;

  await assert.rejects(
    () => session.acceptAnswer(encodeInvite({ kind: "answer", id: "missing", name: "Guest", sdp: "v=0" })),
    rejection,
  );

  const link = new FakeLink("known");
  session.attach(link);
  link.status = "closed";
  session.events().onStatus(link);

  await assert.rejects(
    () => session.acceptAnswer(encodeInvite({ kind: "answer", id: "known", name: "Guest", sdp: "v=0" })),
    rejection,
  );

  session.end();
});

test("joining with an answer token is rejected", async () => {
  const session = new Session("guest", user("Guest"), fakeListener());
  await assert.rejects(
    () => session.join(encodeInvite({ kind: "answer", id: "x", name: "Host", sdp: "v=0" })),
    /does not look like a session invitation/,
  );

  session.end();
});

async function connectedStar(): Promise<{
  fake: FakePeerServer;
  host: Session;
  guestA: Session;
  guestB: Session;
  hostListener: RecordingListener;
  close(): Promise<void>;
}> {
  const fake = await FakePeerServer.start();
  const transport: TransportOptions = { server: fake.server, iceServers: [] };
  const hostListener = fakeListener();
  const guestAListener = fakeListener();
  const guestBListener = fakeListener();

  const host = new Session("host", user("Host"), hostListener);
  const invite = await host.start({ ...transport, newId: () => "skema-host" });

  const guestA = new Session("guest", user("A"), guestAListener);
  const guestB = new Session("guest", user("B"), guestBListener);
  await guestA.join(invite, transport);
  await guestB.join(invite, transport);

  await until(() => guestAListener.synced > 0 && guestBListener.synced > 0, 20_000);

  return {
    fake,
    host,
    guestA,
    guestB,
    hostListener,
    async close() {
      host.end();
      guestA.end();
      guestB.end();
      await fake.close();
    },
  };
}

test("a host and two guests edit one Y.Text concurrently and converge", async () => {
  const star = await connectedStar();
  try {
    star.host.doc.getText("shared").insert(0, "H");
    await until(
      () =>
        star.guestA.doc.getText("shared").toString() === "H" &&
        star.guestB.doc.getText("shared").toString() === "H",
    );

    // A guest's edit reaches the other guest only through the host's relay.
    star.guestA.doc.getText("shared").insert(1, "A");
    await until(
      () =>
        star.host.doc.getText("shared").toString() === "HA" &&
        star.guestB.doc.getText("shared").toString() === "HA",
    );

    star.guestB.doc.getText("shared").insert(2, "B");
    await until(
      () =>
        star.host.doc.getText("shared").toString() === "HAB" &&
        star.guestA.doc.getText("shared").toString() === "HAB",
    );
  } finally {
    await star.close();
  }
});

test("after one guest leaves, the other keeps syncing", async () => {
  const star = await connectedStar();
  try {
    star.guestA.end();
    await until(() => star.hostListener.messages.some((message) => message.includes("left the session")));

    star.guestB.doc.getText("shared").insert(0, "still here");
    await until(() => star.host.doc.getText("shared").toString() === "still here");
  } finally {
    await star.close();
  }
});
