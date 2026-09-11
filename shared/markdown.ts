/**
 * The resolved model as Markdown reference documentation - ported from
 * skema-editor's docs pane (`src/docs/markdown.ts`).
 *
 * Two sources, because the model alone cannot tell the whole story: the
 * `skema/model` response's `model` carries the structure (tables, columns,
 * types, flags, relations, indexes), while the prose lives in
 * `Meta { note = "…" }`, which `skema-hir` drops during resolution - the
 * same response carries those `Meta` entries separately, in `metas`.
 *
 * The output is real Markdown rather than an HTML string: the same text is
 * what both the preview and the file export show, so the two can never
 * drift apart, and it stays copy-pasteable on its own.
 */
import type {
  ExportedEnum,
  ExportedField,
  ExportedFlag,
  ExportedGroup,
  ExportedModel,
  ExportedTable,
  MetaEntry,
} from "@skema/model";
import type { FileMetas } from "./protocol";

interface Notes {
  tables: Map<string, string>;
  enums: Map<string, string>;
  groups: Map<string, string>;
}

function noteKey(file: string, name: string): string {
  return `${file}::${name}`;
}

/** A declaration's own note, read off the `Meta` entries the resolved
 *  model itself drops (see the module doc). */
function collectNotes(fileMetas: FileMetas[]): Notes {
  const notes: Notes = { tables: new Map(), enums: new Map(), groups: new Map() };
  const record = (into: Map<string, string>, file: string, name: string, entries: MetaEntry[]): void => {
    const note = entries.find((entry) => entry.key === "note")?.value;
    if (note) into.set(noteKey(file, name), note);
  };
  for (const file of fileMetas) {
    for (const table of file.tables) record(notes.tables, file.path, table.name, table.entries);
    for (const item of file.enums) record(notes.enums, file.path, item.name, item.entries);
    for (const group of file.groups) record(notes.groups, file.path, group.name, group.entries);
  }
  return notes;
}

function cell(text: string): string {
  return text.replace(/\|/g, "\\|").replace(/\r?\n/g, " ");
}

function qualified(namespace: string, name: string): string {
  return namespace ? `${namespace}.${name}` : name;
}

/** `varchar(120)`, or the relationship exactly as it is written. */
function typeOf(field: ExportedField): string {
  const relation = field.relation;
  if (relation) {
    const arrow = relation.kind === "ManyToOne" ? "<" : relation.kind === "OneToOne" ? "-" : ">";
    return `${arrow}${qualified(relation.targetNamespace, relation.targetTable)}.${relation.targetField}`;
  }
  return field.ty.args.length > 0
    ? `${field.ty.name}(${field.ty.args.join(", ")})`
    : field.ty.name;
}

function flagsOf(item: { flags: ExportedFlag[] }): string {
  return item.flags
    .filter((flag) => flag.value !== false)
    .map((flag) => (flag.value === true ? flag.name : `${flag.name}=${flag.value}`))
    .join(", ");
}

function isBackReference(field: ExportedField): boolean {
  return field.relation?.kind === "ManyToOne";
}

function tableSection(table: ExportedTable, notes: Notes): string[] {
  const lines: string[] = [`### ${table.name}`, ""];

  const note = notes.tables.get(noteKey(table.file, table.name));
  if (note) lines.push(note, "");

  const physical = [table.physical.database, table.physical.schema, table.physical.table]
    .filter(Boolean)
    .join(".");
  const facts = [`Defined in \`${table.file}\``];
  if (physical) facts.push(`physical name \`${physical}\``);
  lines.push(facts.join(" · "), "");

  // Back-references create no column (`docs/07`), so they are listed
  // separately rather than mixed into the column table - a reader looking
  // for what the database will have must not find them here.
  const columns = table.fields.filter((f) => !isBackReference(f));
  if (columns.length > 0) {
    lines.push("| Column | Type | Flags | Description |", "| --- | --- | --- | --- |");
    for (const field of columns) {
      lines.push(
        `| \`${cell(field.name)}\` | \`${cell(typeOf(field))}\` | ${cell(flagsOf(field))} | ${cell(field.note ?? "")} |`,
      );
    }
    lines.push("");
  }

  const backReferences = table.fields.filter(isBackReference);
  if (backReferences.length > 0) {
    lines.push(
      "**Referenced by** (back-references, no column on this table):",
      "",
      ...backReferences.map(
        (field) => `- \`${field.name}\` - ${field.relation?.targetTable ?? "?"}.${field.relation?.targetField ?? "?"}`,
      ),
      "",
    );
  }

  if (table.indexes.length > 0) {
    lines.push("| Index | Columns | Flags |", "| --- | --- | --- |");
    for (const index of table.indexes) {
      lines.push(
        `| ${cell(index.name ?? "(unnamed)")} | ${cell(index.columns.join(", "))} | ${cell(flagsOf(index))} |`,
      );
    }
    lines.push("");
  }

  return lines;
}

function enumSection(entry: ExportedEnum, notes: Notes): string[] {
  const lines: string[] = [`### ${entry.name}`, ""];
  const note = notes.enums.get(noteKey(entry.file, entry.name));
  if (note) lines.push(note, "");

  lines.push(
    `Stored as \`${entry.storedType}\`, defined in \`${entry.file}\``,
    "",
    "| Value | Label | Stored as |",
    "| --- | --- | --- |",
    ...entry.entries.map(
      (item) => `| \`${cell(item.name)}\` | ${cell(item.label ?? "")} | \`${cell(item.value ?? item.name)}\` |`,
    ),
    "",
  );
  return lines;
}

function groupSection(group: ExportedGroup, notes: Notes): string[] {
  const lines: string[] = [`### ${group.name}`, ""];
  const note = notes.groups.get(noteKey(group.file, group.name));
  if (note) lines.push(note, "");
  lines.push(
    ...group.members.map((member) => `- ${member.kind} \`${qualified(member.namespace, member.name)}\``),
    "",
  );
  return lines;
}

/** Tables grouped by the `Document` namespace they belong to, since that is
 *  how a model is organized in the first place (`docs/02`). */
function byNamespace<T extends { namespace: string }>(items: T[]): Map<string, T[]> {
  const grouped = new Map<string, T[]>();
  for (const item of items) {
    const key = item.namespace || "(no document)";
    grouped.set(key, [...(grouped.get(key) ?? []), item]);
  }
  return grouped;
}

export function modelToMarkdown(model: ExportedModel, fileMetas: FileMetas[]): string {
  const notes = collectNotes(fileMetas);
  const lines: string[] = ["# Model documentation", ""];

  const counts = [
    `${model.tables.length} tables`,
    `${model.enums.length} enums`,
    `${model.groups.length} groups`,
  ];
  lines.push(counts.join(" · "), "");

  if (model.tables.length === 0 && model.enums.length === 0) {
    lines.push("_Nothing to document yet - declare a `Table` to get started._");
    return lines.join("\n");
  }

  for (const [namespace, tables] of byNamespace(model.tables)) {
    lines.push(`## ${namespace}`, "");
    for (const table of tables) lines.push(...tableSection(table, notes));
  }

  if (model.enums.length > 0) {
    lines.push("## Enums", "");
    for (const entry of model.enums) lines.push(...enumSection(entry, notes));
  }

  if (model.groups.length > 0) {
    lines.push("## Groups", "");
    for (const group of model.groups) lines.push(...groupSection(group, notes));
  }

  return lines.join("\n");
}
