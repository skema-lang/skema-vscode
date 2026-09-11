/**
 * Group frames, against the same captured `skema/model` response the other
 * fixture tests use - see `model.test.ts` for where it comes from.
 *
 * Two things here are worth a test and cannot be caught by the compiler.
 * The first is that a `Group` member resolves to the id of a node that is
 * really on the canvas: members are `namespace`/`name` pairs from a
 * different part of the payload than the tables, so a drift between the two
 * spellings empties every frame without failing anything. The second is the
 * coordinate arithmetic in `groupFrame.ts`, where a sign error moves boxes
 * instead of frames and is only visible by dragging.
 */
import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";
import { test } from "node:test";

import type { ModelResponse } from "../shared/protocol";
import {
  enumId,
  groupId,
  groupMemberId,
  groupMembership,
  tableId,
} from "@skema/diagram";
import {
  groupFrame,
  toAnchor,
  toChildPosition,
  toStoredPosition,
  type MemberBox,
} from "@skema/diagram";
import { layoutGraph } from "@skema/diagram";

const here = dirname(fileURLToPath(import.meta.url));
const fixture = JSON.parse(
  readFileSync(join(here, "fixtures", "model.json"), "utf8"),
) as ModelResponse;
const model = fixture.model;

/** Every id the diagram actually draws a box for. */
const drawn = new Set([
  ...model.tables.map((table) => tableId(table.namespace, table.name)),
  ...model.enums.map((en) => enumId(en.namespace, en.name)),
]);

test("the fixture has the groups these tests are about", () => {
  assert.deepEqual(
    model.groups.map((group) => group.name),
    ["Catalog", "Lending"],
  );
});

test("every group member resolves to a node that is on the canvas", () => {
  for (const group of model.groups) {
    for (const member of group.members) {
      assert.ok(
        drawn.has(groupMemberId(member)),
        `${group.name} names ${member.kind} ${member.namespace}.${member.name}, which no node id matches`,
      );
    }
  }
});

test("membership covers the members and nothing else", () => {
  const frameOf = groupMembership(model);
  const catalog = model.groups.find((group) => group.name === "Catalog");
  const lending = model.groups.find((group) => group.name === "Lending");
  assert.ok(catalog && lending);

  assert.equal(frameOf.get("catalog.Author"), groupId(catalog));
  assert.equal(frameOf.get("catalog.CopyState"), groupId(catalog), "an Enum member too");
  assert.equal(frameOf.get("lending.Member"), groupId(lending), "a group in another file");
  assert.equal(frameOf.get("catalog.Book"), groupId(catalog));

  // A box belongs to one frame at most (`docs/12`, "One table, one group"),
  // so the map holds exactly the members and nothing invented.
  const members = model.groups.flatMap((group) => group.members);
  assert.equal(frameOf.size, members.length);
  assert.equal(frameOf.get("types.Base"), undefined, "a Partial gets no box, so no frame");
});

test("two groups of the same name in different files stay apart", () => {
  const [catalog, lending] = model.groups;
  assert.ok(catalog && lending);
  assert.notEqual(
    groupId({ ...catalog, name: "Same" }),
    groupId({ ...lending, name: "Same" }),
    "the file has to be part of the id - group names are unique per file only",
  );
});

const boxes: MemberBox[] = [
  { x: 0, y: 0, width: 260, height: 120 },
  { x: 400, y: 300, width: 260, height: 80 },
];

test("the frame contains every member, with room to spare", () => {
  const frame = groupFrame({ x: 1000, y: 500 }, boxes);
  for (const box of boxes) {
    const child = toChildPosition(box, frame);
    assert.ok(child.x > 0 && child.y > 0, "a member starts inside the frame");
    assert.ok(child.x + box.width < frame.width, "and ends inside it");
    assert.ok(child.y + box.height < frame.height);
  }
});

test("a member's stored offset survives the trip through React Flow", () => {
  const frame = groupFrame({ x: 1000, y: 500 }, boxes);
  for (const box of boxes) {
    assert.deepEqual(toStoredPosition(toChildPosition(box, frame), frame), {
      x: box.x,
      y: box.y,
    });
  }
});

test("a member keeps its place on the canvas when the anchor moves", () => {
  const near = groupFrame({ x: 0, y: 0 }, boxes);
  const far = groupFrame({ x: 640, y: -120 }, boxes);
  const first = boxes[0];
  assert.ok(first);

  // Absolute position = frame corner + child offset. Moving the anchor by
  // (640, -120) has to move the box by exactly that and nothing else.
  const on = (frame: typeof near): { x: number; y: number } => {
    const child = toChildPosition(first, frame);
    return { x: frame.position.x + child.x, y: frame.position.y + child.y };
  };
  const before = on(near);
  assert.deepEqual(on(far), { x: before.x + 640, y: before.y - 120 });
});

test("dragging a frame is one edit: the anchor, not the members", () => {
  const anchor = { x: 1000, y: 500 };
  const frame = groupFrame(anchor, boxes);
  assert.deepEqual(toAnchor(frame.position, frame), anchor, "a frame put back where it was");

  const dropped = { x: frame.position.x - 80, y: frame.position.y + 45 };
  assert.deepEqual(toAnchor(dropped, frame), { x: anchor.x - 80, y: anchor.y + 45 });
});

test("an empty group is still a frame you can see and grab", () => {
  const frame = groupFrame({ x: 12, y: 34 }, []);
  assert.deepEqual(frame.position, { x: 12, y: 34 });
  assert.ok(frame.width > 0 && frame.height > 0);
  assert.deepEqual(toAnchor(frame.position, frame), { x: 12, y: 34 });
});

test("auto-layout keeps a group's members inside the cluster it reports", () => {
  const frameOf = groupMembership(model);
  const ids = [...drawn];
  const computed = layoutGraph({
    ids,
    edges: [],
    sizeOf: () => ({ width: 260, height: 120 }),
    groups: model.groups.map((group) => ({
      id: groupId(group),
      memberIds: group.members.map(groupMemberId),
    })),
  });

  for (const group of model.groups) {
    const cluster = computed.get(groupId(group));
    assert.ok(cluster, `${group.name} got no cluster of its own`);
  }

  // Members of different groups must not be interleaved, which is the whole
  // reason the layout is told about groups at all.
  for (const id of ids) {
    const frame = frameOf.get(id);
    if (!frame) continue;
    const at = computed.get(id);
    const cluster = computed.get(frame);
    assert.ok(at && cluster);
    assert.ok(
      at.x >= cluster.x && at.y >= cluster.y,
      `${id} was laid out above or left of its own cluster`,
    );
  }
});
