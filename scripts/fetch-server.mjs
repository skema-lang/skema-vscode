/**
 * Downloads the `skema-lsp` binary this VSIX will bundle.
 *
 * The binary is *not* committed here. It is a release artifact of the
 * language repo, published to that project's GitLab generic package registry
 * on a tag, and pulled in at packaging time - so this repo carries no
 * megabyte-sized blob per platform, and `skemaServer.version` in package.json
 * pins exactly which server it ships with (`adopt-release` moves it).
 *
 * One binary per VSIX, because a VSIX is per platform: `vsce package
 * --target linux-x64` produces an artifact that only that platform ever
 * downloads, so bundling every platform's server in every VSIX would be
 * four times the download for nothing.
 *
 *     npm run fetch:server                 # this machine's platform
 *     npm run fetch:server -- --target win32-x64
 *     SKEMA_SERVER_VERSION=v0.2.0 npm run fetch:server
 *
 * With no published release yet, this fails with a clear message rather than
 * a broken bundle - and the extension still works: it falls back to
 * `skema.serverPath` or a `skema-lsp` on `PATH`, which is what a
 * platform-neutral VSIX relies on.
 */
import { chmodSync, mkdirSync, readFileSync, writeFileSync } from "node:fs";
import { dirname, join, resolve } from "node:path";
import { fileURLToPath } from "node:url";

const here = dirname(fileURLToPath(import.meta.url));
const root = resolve(here, "..");
const manifest = JSON.parse(readFileSync(join(root, "package.json"), "utf8"));

const config = manifest.skemaServer ?? {};
const version = process.env.SKEMA_SERVER_VERSION ?? (config.version && `v${config.version}`);
const project = process.env.SKEMA_PROJECT ?? config.project;
const host = process.env.SKEMA_REGISTRY ?? config.registry;

/**
 * VSCode's platform names ↔ Rust target triples. VSCode decides which VSIX a
 * user gets by the left column; the release is named by the right one.
 */
const TARGETS = {
  // musl, statically linked: one Linux binary that does not care which
  // distribution - or which glibc - it lands on.
  "linux-x64": "x86_64-unknown-linux-musl",
  "linux-arm64": "aarch64-unknown-linux-musl",
  "darwin-x64": "x86_64-apple-darwin",
  "darwin-arm64": "aarch64-apple-darwin",
  // The GNU ABI, because that is what cross-compiles from Linux; an MSVC
  // build would need a Windows runner and buys nothing here.
  "win32-x64": "x86_64-pc-windows-gnu",
};

function currentTarget() {
  const arch = process.arch === "arm64" ? "arm64" : "x64";
  const platform =
    process.platform === "darwin" ? "darwin" : process.platform === "win32" ? "win32" : "linux";
  return `${platform}-${arch}`;
}

const flag = process.argv.indexOf("--target");
const vscodeTarget = flag >= 0 ? process.argv[flag + 1] : currentTarget();
const triple = TARGETS[vscodeTarget];

if (!triple) {
  console.error(`Unknown target ${vscodeTarget}. One of: ${Object.keys(TARGETS).join(", ")}`);
  process.exit(1);
}
if (!version) {
  console.error("No server version. Set skemaServer.version in package.json or SKEMA_SERVER_VERSION.");
  process.exit(1);
}

const asset = `skema-lsp-${triple}${vscodeTarget === "win32-x64" ? ".exe" : ""}`;
const url = `${host}/api/v4/projects/${encodeURIComponent(project)}/packages/generic/skema/${version}/${asset}`;

console.log(`Fetching ${asset} (${version}) for ${vscodeTarget}`);
console.log(`  ${url}`);

// A private project needs a token; a public one needs none. Both are normal,
// so the header is added only when there is something to add.
const headers = {};
if (process.env.CI_JOB_TOKEN) headers["JOB-TOKEN"] = process.env.CI_JOB_TOKEN;
else if (process.env.GITLAB_TOKEN) headers["PRIVATE-TOKEN"] = process.env.GITLAB_TOKEN;

const response = await fetch(url, { headers });
if (!response.ok) {
  console.error(`  ${response.status} ${response.statusText}`);
  if (response.status === 404) {
    console.error(
      "\nNothing published under that version. Either the language repo has no such tag yet,\n" +
        "or its release pipeline does not build this target. The extension still works without\n" +
        "a bundled binary - set skema.serverPath, or put skema-lsp on PATH.",
    );
  }
  if (response.status === 401 || response.status === 403) {
    console.error("\nThe registry wants credentials: set GITLAB_TOKEN (a read_api token).");
  }
  process.exit(1);
}

const directory = join(root, "server");
mkdirSync(directory, { recursive: true });
const file = join(directory, vscodeTarget === "win32-x64" ? "skema-lsp.exe" : "skema-lsp");

writeFileSync(file, Buffer.from(await response.arrayBuffer()));
if (vscodeTarget !== "win32-x64") chmodSync(file, 0o755);

console.log(`Wrote ${file}`);
