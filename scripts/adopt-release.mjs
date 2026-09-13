/**
 * Pins the two upstream releases skema-lib hands down, each independent of
 * the other: SKEMA_LIB_VERSION to @skema/collab-protocol, @skema/diagram and
 * @skema/docs; SKEMA_LANG_VERSION to @skema/model. A downgrade or a malformed
 * version is refused and nothing is written. Prints one "adopt <group>
 * v<version>" line per group actually changed - empty output means every pin
 * was already current - for release.sh to build the fix(deps) commit(s) from.
 *
 * It deliberately does not commit, tag, bump the extension's own version, or
 * publish - release.sh does that around it, driven by git-cliff.
 *
 *     SKEMA_LIB_VERSION=v0.1.1 SKEMA_LANG_VERSION=v0.2.2 node scripts/adopt-release.mjs
 */
import { execFileSync } from "node:child_process";
import { readFileSync } from "node:fs";
import { dirname, join, resolve } from "node:path";
import { fileURLToPath } from "node:url";

const root = resolve(dirname(fileURLToPath(import.meta.url)), "..");

const GROUPS = [
  {
    label: "skema-lib",
    envVar: "SKEMA_LIB_VERSION",
    packages: ["@skema/collab-protocol", "@skema/diagram", "@skema/docs"],
  },
  {
    label: "skema",
    envVar: "SKEMA_LANG_VERSION",
    packages: ["@skema/model"],
  },
];

const manifest = readJson("package.json");
const changedGroups = [];

for (const group of GROUPS) {
  const input = (process.env[group.envVar] ?? "").trim();
  if (!input) continue;

  if (!/^v\d+\.\d+\.\d+$/.test(input)) {
    console.error(`${group.envVar}: not a vX.Y.Z version: ${input}`);
    process.exit(1);
  }
  const version = input.slice(1);

  for (const name of group.packages) {
    const current = manifest.dependencies?.[name];
    if (current !== undefined && /^\d+\.\d+\.\d+$/.test(current) && compareVersions(version, current) < 0) {
      console.error(`${name}: refusing to downgrade ${current} -> ${version}`);
      process.exit(1);
    }
  }

  const changedPackages = group.packages.filter((name) => manifest.dependencies?.[name] !== version);
  if (changedPackages.length === 0) continue;

  // stdout is this script's result, so npm's output goes to stderr.
  execFileSync(
    "npm",
    ["install", "--save-exact", "--no-audit", "--fund=false", ...changedPackages.map((name) => `${name}@${version}`)],
    { cwd: root, stdio: ["ignore", 2, 2] },
  );
  changedGroups.push(`adopt ${group.label} v${version}`);
}

for (const line of changedGroups) console.log(line);

/** -1/0/1, comparing two "X.Y.Z" strings numerically. */
function compareVersions(a, b) {
  const partsA = a.split(".").map(Number);
  const partsB = b.split(".").map(Number);
  for (let index = 0; index < 3; index += 1) {
    if (partsA[index] !== partsB[index]) return partsA[index] - partsB[index];
  }
  return 0;
}

function readJson(file) {
  return JSON.parse(readFileSync(join(root, file), "utf8"));
}
