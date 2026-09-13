/**
 * Adopts the upstream releases handed down in SKEMA_VERSIONS, e.g.
 * "@skema/model@0.2.1 @skema/diagram@0.1.2 skema-lsp@0.2.1": pins each one
 * this extension uses exactly - `skema-lsp` as `skemaServer.version`, the
 * build `fetch:server` bundles - and bumps the extension's own version by the
 * largest step any of them took. Prints the new tag, or nothing when every pin
 * was already current.
 *
 * It deliberately does not commit, tag, or publish: the CI job does that, so
 * this can be run locally to see the diff first.
 *
 *     node scripts/adopt-release.mjs "@skema/model@0.2.1 skema-lsp@0.2.1"
 */
import { execFileSync } from "node:child_process";
import { readFileSync, writeFileSync } from "node:fs";
import { dirname, join, resolve } from "node:path";
import { fileURLToPath } from "node:url";

const root = resolve(dirname(fileURLToPath(import.meta.url)), "..");
const LEVELS = ["major", "minor", "patch"];
const SERVER = "skema-lsp";

const handedDown = (process.argv[2] ?? process.env.SKEMA_VERSIONS ?? "").trim();
if (!handedDown) {
  console.error('Usage: node scripts/adopt-release.mjs "<name>@<version> ..."   (or set SKEMA_VERSIONS)');
  process.exit(1);
}

const manifest = readJson("package.json");
const changes = parseVersions(handedDown).flatMap(({ name, version }) => {
  const current = currentPin(manifest, name);
  const level = current === undefined ? undefined : bumpLevel(name, current, version);
  return level ? [{ name, version, level }] : [];
});

if (changes.length === 0) process.exit(0);

const dependencySpecs = changes
  .filter(({ name }) => name !== SERVER)
  .map(({ name, version }) => `${name}@${version}`);
if (dependencySpecs.length > 0) {
  // stdout is this script's result, so npm's output goes to stderr.
  execFileSync("npm", ["install", "--save-exact", "--no-audit", "--fund=false", ...dependencySpecs], {
    cwd: root,
    stdio: ["ignore", 2, 2],
  });
}

const nextVersion = bump(readJson("package.json").version, LEVELS.find((level) => changes.some((change) => change.level === level)));
rewriteJson("package.json", (json) => {
  json.version = nextVersion;
  const server = changes.find(({ name }) => name === SERVER);
  if (server) json.skemaServer.version = server.version;
});
// npm keeps the version in two places in the lockfile, and `npm ci` compares
// them against package.json.
rewriteJson("package-lock.json", (lock) => {
  lock.version = nextVersion;
  if (lock.packages?.[""]) lock.packages[""].version = nextVersion;
});

console.log(`v${nextVersion}`);

function currentPin(json, name) {
  if (name === SERVER) return json.skemaServer?.version;
  return json.dependencies?.[name] ?? json.devDependencies?.[name];
}

function parseVersions(text) {
  return text.split(/\s+/).map((spec) => {
    const at = spec.lastIndexOf("@");
    const version = spec.slice(at + 1).replace(/^v/, "");
    if (at <= 0 || !/^\d+\.\d+\.\d+$/.test(version)) {
      console.error(`Not a <name>@<version>: ${spec}`);
      process.exit(1);
    }
    return { name: spec.slice(0, at), version };
  });
}

/** How far a pin has to move to reach `next`, or undefined when it already is `next` exactly. */
function bumpLevel(name, current, next) {
  const from = current.match(/(\d+)\.(\d+)\.(\d+)/)?.slice(1).map(Number);
  if (!from) return "patch";
  const to = next.split(".").map(Number);
  const differing = LEVELS.findIndex((_, index) => to[index] !== from[index]);
  // A range or a local tarball at the same version still becomes an exact pin.
  if (differing === -1) return /^\d+\.\d+\.\d+$/.test(current) ? undefined : "patch";
  if (to[differing] > from[differing]) return LEVELS[differing];
  console.error(`${name}: keeping ${current}, ${next} is older`);
  return undefined;
}

function bump(version, level) {
  const [major, minor, patch] = version.split(".").map(Number);
  if (level === "major") return `${major + 1}.0.0`;
  if (level === "minor") return `${major}.${minor + 1}.0`;
  return `${major}.${minor}.${patch + 1}`;
}

function readJson(file) {
  return JSON.parse(readFileSync(join(root, file), "utf8"));
}

/** Rewrites one JSON file in place, preserving npm's 2-space + trailing newline. */
function rewriteJson(file, edit) {
  const json = readJson(file);
  edit(json);
  writeFileSync(join(root, file), `${JSON.stringify(json, null, 2)}\n`);
}
