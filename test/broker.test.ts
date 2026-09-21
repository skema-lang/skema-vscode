import assert from "node:assert/strict";
import { createServer, type AddressInfo } from "node:net";
import { test } from "node:test";

import { WebSocketServer } from "ws";

import { BROKER_TIMEOUT_MS, Broker } from "../src/collab/broker";
import { FakePeerServer, until } from "./fakePeerServer";

test("connects with the URL peerjs@1.5.5 uses", async () => {
  const fake = await FakePeerServer.start();
  const broker = await Broker.open({ server: fake.server, newId: () => "skema-abc" });
  try {
    assert.ok(broker);
    const url = new URL(fake.urls[0] ?? "", "http://localhost");
    assert.equal(url.pathname, "/peerjs");
    assert.equal(url.searchParams.get("key"), "peerjs");
    assert.equal(url.searchParams.get("id"), "skema-abc");
    assert.match(url.searchParams.get("token") ?? "", /^[a-z0-9]+$/);
    assert.equal(url.searchParams.get("version"), "1.5.5");
  } finally {
    broker?.close();
    await fake.close();
  }
});

test("a duplicate id retries with a fresh one", async () => {
  const fake = await FakePeerServer.start();
  const first = await Broker.open({ server: fake.server, newId: () => "skema-dup" });
  const ids = ["skema-dup", "skema-fresh"];
  const second = await Broker.open({ server: fake.server, newId: () => ids.shift() ?? "skema-spare" });
  try {
    assert.equal(first?.id, "skema-dup");
    assert.equal(second?.id, "skema-fresh");
  } finally {
    first?.close();
    second?.close();
    await fake.close();
  }
});

test("with no server, the broker is down well within the timeout", async () => {
  const probe = createServer();
  await new Promise<void>((resolve) => probe.listen(0, "127.0.0.1", resolve));
  const port = (probe.address() as AddressInfo).port;
  await new Promise<void>((resolve) => probe.close(() => resolve()));

  const started = Date.now();
  const broker = await Broker.open({ server: { host: "127.0.0.1", port, secure: false } });
  assert.equal(broker, undefined);
  assert.ok(Date.now() - started < BROKER_TIMEOUT_MS);
});

test("a server that never says OPEN is down after the timeout", async () => {
  const silent = new WebSocketServer({ host: "127.0.0.1", port: 0 });
  await new Promise<void>((resolve) => silent.on("listening", resolve));
  const port = (silent.address() as AddressInfo).port;

  const started = Date.now();
  const broker = await Broker.open({ server: { host: "127.0.0.1", port, secure: false } });
  const elapsed = Date.now() - started;
  for (const client of silent.clients) client.terminate();
  await new Promise<void>((resolve) => silent.close(() => resolve()));

  assert.equal(broker, undefined);
  assert.ok(elapsed >= BROKER_TIMEOUT_MS - 50 && elapsed < BROKER_TIMEOUT_MS + 1000, `${elapsed} ms`);
});

test("sends a heartbeat every 5 s while open", async () => {
  const fake = await FakePeerServer.start();
  const broker = await Broker.open({ server: fake.server });
  try {
    await until(() => fake.received.some(({ message }) => message.type === "HEARTBEAT"), 6000);
    assert.deepEqual(fake.received[0]?.message, { type: "HEARTBEAT" });
  } finally {
    broker?.close();
    await fake.close();
  }
});

test("a dropped socket reconnects with the same id and token", async () => {
  const fake = await FakePeerServer.start();
  const broker = await Broker.open({ server: fake.server, newId: () => "skema-host" });
  try {
    fake.drop("skema-host");
    await until(() => fake.urls.length === 2);
    assert.equal(fake.urls[1], fake.urls[0]);

    const offers: string[] = [];
    broker?.listen({
      onOffer: (src) => offers.push(src),
      onAnswer: () => undefined,
      onCandidate: () => undefined,
      onLeave: () => undefined,
      onExpire: () => undefined,
    });
    fake.inject("skema-host", {
      type: "OFFER",
      src: "skema-guest",
      payload: {
        sdp: { type: "offer", sdp: "v=0" },
        type: "data",
        connectionId: "dc_x",
        label: "skema-doc",
        reliable: true,
        serialization: "raw",
      },
    });
    await until(() => offers.length === 1);
  } finally {
    broker?.close();
    await fake.close();
  }
});
