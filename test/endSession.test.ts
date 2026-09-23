import assert from "node:assert/strict";
import { test } from "node:test";

import { runEndOfSession, type EndOfSessionActions } from "../src/collab/endSession";

/** Records which actions ran, and lets `isSessionActive` be flipped mid-test
 *  to stand in for a session a previous call already ended - the same
 *  situation a second trigger (the command, then the panel closing, or the
 *  other way around) finds itself in. */
function recordingActions(options: {
  active?: boolean;
  unopenedFolder?: string;
}): { calls: string[]; actions: EndOfSessionActions<string> } {
  const calls: string[] = [];
  let active = options.active ?? true;
  let folder = options.unopenedFolder;
  const actions: EndOfSessionActions<string> = {
    isSessionActive: () => active,
    teardownCollabSync: () => calls.push("teardownCollabSync"),
    endSession: () => {
      calls.push("endSession");
      active = false;
    },
    setHostingContext: (hosting) => calls.push(`setHostingContext(${hosting})`),
    takeUnopenedJoinFolder: () => {
      const taken = folder;
      folder = undefined;
      return taken;
    },
    showSessionEnded: () => calls.push("showSessionEnded"),
    offerToOpenFolder: (f) => calls.push(`offerToOpenFolder(${f})`),
  };
  return { calls, actions };
}

test("runEndOfSession tears down, ends the session and reports it ended", () => {
  const { calls, actions } = recordingActions({});
  runEndOfSession(actions);
  assert.deepEqual(calls, [
    "teardownCollabSync",
    "endSession",
    "setHostingContext(false)",
    "showSessionEnded",
  ]);
});

test("runEndOfSession offers to open an unopened join folder instead of the plain message", () => {
  const { calls, actions } = recordingActions({ unopenedFolder: "/tmp/guest-project" });
  runEndOfSession(actions);
  assert.deepEqual(calls, [
    "teardownCollabSync",
    "endSession",
    "setHostingContext(false)",
    "offerToOpenFolder(/tmp/guest-project)",
  ]);
});

test("runEndOfSession does nothing once the session is already inactive", () => {
  const { calls, actions } = recordingActions({ active: false });
  runEndOfSession(actions);
  assert.deepEqual(calls, []);
});

test("a second trigger after the first ended the session is a no-op (re-entrancy)", () => {
  // Both `skema.collab.endSession` and closing the panel call this same
  // function (task 108) - whichever runs second must not double-report.
  const { calls, actions } = recordingActions({});
  runEndOfSession(actions);
  const callsAfterFirst = [...calls];
  runEndOfSession(actions);
  assert.deepEqual(calls, callsAfterFirst);
});
