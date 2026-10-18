import assert from "node:assert/strict";
import { test } from "node:test";

import { oneAtATime } from "../src/lifecycle";

/** A stand-in for `LanguageClient.start()`/`stop()` that takes a few ticks, so an unserialized second restart would interleave with the first. */
function slowStep(calls: string[], name: string): () => Promise<void> {
  return async () => {
    calls.push(`${name} begins`);
    await new Promise((resolve) => setTimeout(resolve, 5));
    calls.push(`${name} ends`);
  };
}

test("a second restart waits for the first restart's start before stopping", async () => {
  const calls: string[] = [];
  const lifecycle = oneAtATime();
  const restart = (generation: number) =>
    lifecycle(async () => {
      await slowStep(calls, `stop ${generation}`)();
      await slowStep(calls, `start ${generation}`)();
    });

  await Promise.all([restart(1), restart(2)]);

  assert.deepEqual(calls, [
    "stop 1 begins",
    "stop 1 ends",
    "start 1 begins",
    "start 1 ends",
    "stop 2 begins",
    "stop 2 ends",
    "start 2 begins",
    "start 2 ends",
  ]);
});

test("a failed step rejects its own caller and still lets the next one run", async () => {
  const calls: string[] = [];
  const lifecycle = oneAtATime();

  const failing = lifecycle(async () => {
    calls.push("failing");
    throw new Error("server did not start");
  });
  const next = lifecycle(slowStep(calls, "next"));

  await assert.rejects(failing, /server did not start/);
  await next;
  assert.deepEqual(calls, ["failing", "next begins", "next ends"]);
});
