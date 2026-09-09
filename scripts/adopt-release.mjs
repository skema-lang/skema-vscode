/**
 * Points this extension at a newly published language release.
 *
 * Run from the pipeline the language repo triggers on its tag. It rewrites
 * two things in package.json and nothing else:
 *
 *   - `skemaServer.version` - which `skema-lsp` release `fetch:server` pulls
 *     into the VSIX. This is the one that decides what users actually run.
 *   - `version` - the extension's own version, mirrored from the language
 *     tag so that "skema 0.2.0" means one thing across all three repos
 *     rather than three unrelated numbers a user has to correlate.
 *
 * It deliberately does not commit, tag, or publish: the CI job does that, so
 * this can be run locally to see the diff first.
 *
 *     node scripts/adopt-release.mjs v0.2.0
 */
import { readFileSync, writeFileSync } from "node:fs";
import { dirname, join, resolve } from "node:path";
import { fileURLToPath } from "node:url";

const root = resolve(dirname(fileURLToPath(import.meta.url)), "..");

const tag = process.argv[2] ?? process.env.SKEMA_RELEASE;
if (!tag) {
  console.error("Usage: node scripts/adopt-release.mjs <vX.Y.Z>   (or set SKEMA_RELEASE)");
  process.exit(1);
}

// The registry is addressed by tag (`.../generic/skema/v0.2.0/...`), the
// manifest by bare semver. Keep both, and refuse anything that is neither.
const version = tag.replace(/^v/, "");
if (!/^\d+\.\d+\.\d+$/.test(version)) {
  console.error(`Not a release tag: ${tag} (expected vX.Y.Z)`);
  process.exit(1);
}

/** Rewrites one JSON file in place, preserving npm's 2-space + trailing newline. */
function patch(file, edit) {
  const path = join(root, file);
  let json;
  try {
    json = JSON.parse(readFileSync(path, "utf8"));
  } catch (error) {
    if (error.code === "ENOENT") return false;
    throw error;
  }
  edit(json);
  writeFileSync(path, `${JSON.stringify(json, null, 2)}\n`);
  return true;
}

patch("package.json", (manifest) => {
  manifest.version = version;
  manifest.skemaServer = { ...manifest.skemaServer, version: tag };
});

// npm keeps the version in two places in the lockfile, and `npm ci` compares
// them against package.json. Leaving them behind turns the next install into
// a confusing failure rather than a version mismatch anyone would spot.
patch("package-lock.json", (lock) => {
  lock.version = version;
  if (lock.packages?.[""]) lock.packages[""].version = version;
});

console.log(`Extension version ${version}, bundling skema-lsp ${tag}`);
