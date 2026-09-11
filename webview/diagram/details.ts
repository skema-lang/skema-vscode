/**
 * What the hover cards say about a field or a table.
 *
 * Pure functions from the analysed model to the card's contents, kept out
 * of the components so the wording is in one place and testable on its own.
 */
import type {
  ExportedEnum,
  ExportedField,
  ExportedGroup,
  ExportedTable,
  Location,
} from "../../shared/skema";
import { flagLabels } from "../model/flags";

/** One labelled line of a hover card. Defined here, next to the code that
 *  produces it, so the card itself stays a matter of presentation. */
export interface DetailFact {
  label: string;
  value: string;
}

export function sourceLabel(location: Location | undefined): string | undefined {
  return location ? `${location.file}:${location.line}` : undefined;
}

/** `varchar(120)`, or the relationship arrow as it is written. */
export function typeLabel(field: ExportedField): string {
  const relation = field.relation;
  if (relation) {
    const arrow = relation.kind === "ManyToOne" ? "<" : relation.kind === "OneToOne" ? "-" : ">";
    const target = relation.targetNamespace
      ? `${relation.targetNamespace}.${relation.targetTable}`
      : relation.targetTable;
    return `${arrow}${target}.${relation.targetField}`;
  }
  return field.ty.args.length > 0
    ? `${field.ty.name}(${field.ty.args.join(", ")})`
    : field.ty.name;
}

/** Every flag as written, `pk` and `default=…` alike. */
export function flagBadges(field: ExportedField): string[] {
  return flagLabels(field);
}

/** The type is already the card's subtitle, so it is not repeated here. */
export function fieldFacts(field: ExportedField, tableFile: string): DetailFact[] {
  const facts: DetailFact[] = [];
  const relation = field.relation;

  if (relation) {
    facts.push({
      label: "Kind",
      value:
        relation.kind === "OneToMany"
          ? "many to one - this table holds the key"
          : relation.kind === "OneToOne"
            ? "one to one - this table holds the key, unique"
            : "back-reference - no column here",
    });
    if (relation.onDelete) facts.push({ label: "On delete", value: relation.onDelete });
    if (relation.onUpdate) facts.push({ label: "On update", value: relation.onUpdate });
  }

  // Only worth saying when it differs from the table's own file, which is
  // exactly the `use`d-partial-from-another-file case.
  if (field.file !== tableFile) {
    facts.push({ label: "From", value: field.file });
  }
  return facts;
}

export function tableFacts(table: ExportedTable): DetailFact[] {
  const facts: DetailFact[] = [];
  const columns = table.fields.filter((f) => f.relation?.kind !== "ManyToOne");
  facts.push({ label: "Columns", value: String(columns.length) });

  const physical = [table.physical.database, table.physical.schema, table.physical.table]
    .filter(Boolean)
    .join(".");
  if (physical) facts.push({ label: "Physical", value: physical });

  if (table.indexes.length > 0) {
    facts.push({
      label: "Indexes",
      value: table.indexes
        .map((index) => `${index.name ?? "(unnamed)"} (${index.columns.join(", ")})`)
        .join("\n"),
    });
  }

  const backReferences = table.fields.filter((f) => f.relation?.kind === "ManyToOne");
  if (backReferences.length > 0) {
    facts.push({
      label: "Has many",
      value: backReferences.map((f) => `${f.relation?.targetTable ?? "?"} (${f.name})`).join(", "),
    });
  }
  return facts;
}

export function enumFacts(en: ExportedEnum): DetailFact[] {
  return [
    { label: "Values", value: String(en.entries.length) },
    { label: "Stored as", value: en.storedType },
  ];
}

/** A group's members are listed with their kind, because that is what the
 *  source writes and what it is checked against (`docs/12`). */
export function groupFacts(group: ExportedGroup): DetailFact[] {
  const facts: DetailFact[] = [{ label: "Members", value: String(group.members.length) }];
  if (group.members.length > 0) {
    facts.push({
      label: "Contains",
      value: group.members
        .map((member) =>
          member.namespace
            ? `${member.kind} ${member.namespace}.${member.name}`
            : `${member.kind} ${member.name}`,
        )
        .join("\n"),
    });
  }
  return facts;
}

/** A table's own note, which the model keeps on no field of its own - it
 *  lives in `Meta { note = "…" }` and reaches the diagram through the
 *  `Meta` entries rather than the resolved model. */
export function metaNote(entries: { key: string; value: string | undefined }[] | undefined) {
  return entries?.find((entry) => entry.key === "note")?.value;
}
