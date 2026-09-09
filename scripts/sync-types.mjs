/**
 * Vendors the model types from the language repo.
 *
 * The language server's `skema/model` response carries `skema-api`'s own
 * structures, serialized by the same serde derives that produce the
 * browser's JSON - so the TypeScript declarations `skema-wasm` generates
 * describe the LSP responses exactly. Copying them is how this extension
 * gets `ExportedTable` and friends without a second, hand-written schema
 * that would drift the first time the model grows a field.
 *
 * Only the *types* come across. The generated file also declares the wasm
 * entry points (`check`, `analyzeProject`, the `init` machinery); those are
 * a browser's way in, there is no WASM in this extension, and leaving them
 * in an ambient declaration would let an accidental value import compile and
 * then fail at runtime.
 *
 * The result is committed, so this repo builds without the language repo
 * present. Re-run it after the model changes:
 *
 *     npm run sync:types
 *     SKEMA_DIR=/path/to/skema-lang npm run sync:types
 */
import { existsSync, readFileSync, writeFileSync } from "node:fs";
import { homedir } from "node:os";
import { dirname, join, resolve } from "node:path";
import { fileURLToPath } from "node:url";

const here = dirname(fileURLToPath(import.meta.url));
const skemaDir = process.env.SKEMA_DIR ?? join(homedir(), "code", "skema", "skema-lang");
const source = join(skemaDir, "crates", "skema-wasm", "pkg", "skema_wasm.d.ts");
const target = resolve(here, "..", "shared", "skema.d.ts");

if (!existsSync(source)) {
  console.error(`No generated bindings at ${source}`);
  console.error("Build them first: (cd crates/skema-wasm && wasm-pack build --target web --release)");
  console.error("Or point SKEMA_DIR at the skema-lang checkout.");
  process.exit(1);
}

const lines = readFileSync(source, "utf8").split("\n");
const kept = [];
let comment = [];

for (let i = 0; i < lines.length; i += 1) {
  const line = lines[i];

  if (line.startsWith("/**")) {
    comment = [line];
    while (!lines[i].includes("*/") && i + 1 < lines.length) {
      i += 1;
      comment.push(lines[i]);
    }
    continue;
  }

  if (line.startsWith("export interface ")) {
    kept.push(...comment, line);
    while (lines[i] !== "}" && i + 1 < lines.length) {
      i += 1;
      kept.push(lines[i]);
    }
    kept.push("");
    comment = [];
    continue;
  }

  if (line.startsWith("export type ")) {
    kept.push(...comment, line, "");
    comment = [];
    continue;
  }

  if (line.trim() !== "") comment = [];
}

const header = `/**
 * Generated - do not edit. Run \`npm run sync:types\` after changing the model.
 *
 * Source: skema-lang/crates/skema-wasm/pkg/skema_wasm.d.ts, types only.
 * These describe both the WASM API in the browser editor and the
 * \`skema/model\` response this extension reads, because both are serialized
 * from the same Rust structs in \`skema-api\`.
 */

`;

writeFileSync(target, header + kept.join("\n").replace(/\n{3,}/g, "\n\n").trimEnd() + "\n");
console.log(`Wrote ${target} (${kept.length} lines from ${source})`);
