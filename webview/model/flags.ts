/**
 * Reading a field's or index's `[]`-flags.
 *
 * The boundary hands them over as a list of `{ name, value }` entries, in
 * the order the checker keeps them - `[pk]` carrying `true`, `[default=0]`
 * carrying its text. One module owns that shape so no caller has to
 * remember whether it is a list, a map or an object.
 */
import type { ExportedFlag } from "../../shared/skema";

export interface Flagged {
  flags: ExportedFlag[];
}

/** `true` for a valueless flag that is present, e.g. `[pk]`. */
export function hasFlag(item: Flagged, name: string): boolean {
  return item.flags.some((flag) => flag.name === name && flag.value === true);
}

/** The value of a valued flag (`[default=0]` → `"0"`), if it is set. */
export function flagValue(item: Flagged, name: string): string | undefined {
  const value = item.flags.find((flag) => flag.name === name)?.value;
  return typeof value === "string" ? value : undefined;
}

/** Every flag as written: `pk`, `default=0`. Skips a flag set to `false`,
 *  which is how an explicitly negated one arrives. */
export function flagLabels(item: Flagged): string[] {
  return item.flags
    .filter((flag) => flag.value !== false)
    .map((flag) => (flag.value === true ? flag.name : `${flag.name}=${flag.value}`));
}
