/**
 * `@skema/docs`'s `NoteLookup` port, filled in from a `skema/model`
 * response's `metas` - the extension's own `Meta` shape.
 *
 * No `vscode` import on purpose: `test/markdown.test.ts` replays a captured
 * response through this same function, and stays independent of the
 * `vscode` stub the rest of the extension's tests need.
 */
import type { NoteLookup } from "@skema/docs";
import type { MetaEntry } from "@skema/model";
import type { FileMetas } from "../../shared/protocol";

export function getNoteFrom(metas: FileMetas[]): NoteLookup {
  const notes = new Map<string, string>();
  const collect = (file: string, name: string, entries: MetaEntry[]): void => {
    const note = entries.find((entry) => entry.key === "note")?.value;
    if (note) notes.set(`${file}::${name}`, note);
  };
  for (const file of metas) {
    for (const table of file.tables) collect(file.path, table.name, table.entries);
    for (const item of file.enums) collect(file.path, item.name, item.entries);
    for (const group of file.groups) collect(file.path, group.name, group.entries);
  }
  return (file, name) => notes.get(`${file}::${name}`);
}
