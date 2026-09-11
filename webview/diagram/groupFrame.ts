/**
 * Where a group's frame sits, and how big it is.
 *
 * A frame is derived, not placed: its size is whatever contains its members,
 * and only its anchor is a decision worth writing into the model. That is
 * what makes a member's own position group-relative (`positions.ts`) - the
 * members move with the anchor, so dragging a whole group stays one edit
 * instead of one per member.
 *
 * React Flow adds a third coordinate system: it positions a child node
 * relative to its parent's top-left corner, and that corner is not the
 * anchor - it is wherever the outermost member put it. `offset` is the only
 * conversion between the two, so nothing outside this module has to know
 * the padding rules.
 */
import type { Position } from "./positions";

/** Clear of the boxes on every side, and of the label along the top. */
const PADDING = 28;
export const LABEL_HEIGHT = 26;

/** A group may legally have no members at all (`docs/12`). It is still
 *  drawn: the diagram is the view a `Group` exists for, and a declaration
 *  that renders as nothing reads as a bug rather than as an empty group. */
const EMPTY_WIDTH = 220;
const EMPTY_HEIGHT = LABEL_HEIGHT + 72;

/** A member as the frame sees it: where it sits in the group's own
 *  coordinates, and how much room it takes. */
export interface MemberBox extends Position {
  width: number;
  height: number;
}

export interface GroupFrame {
  /** Absolute canvas position of the frame's top-left corner. */
  position: Position;
  width: number;
  height: number;
  /** The frame's corner minus the group's anchor - what turns a stored
   *  member position into the one React Flow wants, and back. */
  offset: Position;
}

/**
 * The frame that contains `members`, all of them given in the group's own
 * coordinates. Members far outside the others simply make it bigger:
 * membership is declared in the source (`docs/12`), so a box dragged away
 * from its neighbours stretches the frame rather than leaving it.
 */
export function groupFrame(anchor: Position, members: MemberBox[]): GroupFrame {
  const first = members[0];
  if (!first) {
    return {
      position: { ...anchor },
      width: EMPTY_WIDTH,
      height: EMPTY_HEIGHT,
      offset: { x: 0, y: 0 },
    };
  }

  let left = first.x;
  let top = first.y;
  let right = first.x + first.width;
  let bottom = first.y + first.height;
  for (const member of members) {
    left = Math.min(left, member.x);
    top = Math.min(top, member.y);
    right = Math.max(right, member.x + member.width);
    bottom = Math.max(bottom, member.y + member.height);
  }

  const offset = { x: left - PADDING, y: top - PADDING - LABEL_HEIGHT };
  return {
    position: { x: anchor.x + offset.x, y: anchor.y + offset.y },
    width: right - left + 2 * PADDING,
    height: bottom - top + 2 * PADDING + LABEL_HEIGHT,
    offset,
  };
}

/** A stored member position as React Flow wants it: relative to the frame. */
export function toChildPosition(stored: Position, frame: GroupFrame): Position {
  return { x: stored.x - frame.offset.x, y: stored.y - frame.offset.y };
}

/** The inverse, for writing a dragged member back into its `Meta` block. */
export function toStoredPosition(child: Position, frame: GroupFrame): Position {
  return { x: child.x + frame.offset.x, y: child.y + frame.offset.y };
}

/** The anchor a dragged frame now has. The corner it was dropped at is
 *  derived from the members, so what actually moved is the anchor behind
 *  it - and the members, whose offsets are unchanged, come along. */
export function toAnchor(position: Position, frame: GroupFrame): Position {
  return { x: position.x - frame.offset.x, y: position.y - frame.offset.y };
}
