/**
 * Two bundles, because there are two runtimes.
 *
 * The extension runs in VSCode's Node host and must not bundle `vscode`
 * itself - it is injected. The webview runs in a browser sandbox and gets
 * everything inlined, since a webview can only load files the extension
 * hands it. The CSS imported by the webview entry comes out beside it as
 * `webview.css`, which the panel's HTML links.
 */
import { cpSync } from "node:fs";

import { context, build } from "esbuild";

const production = process.argv.includes("--production");
const watch = process.argv.includes("--watch");

/** @type {import("esbuild").BuildOptions} */
const common = {
  bundle: true,
  minify: production,
  sourcemap: !production,
  logLevel: "info",
};

/** @type {import("esbuild").BuildOptions} */
const extension = {
  ...common,
  entryPoints: ["src/extension.ts"],
  outfile: "dist/extension.js",
  platform: "node",
  format: "cjs",
  target: "node20",
  // Optional native speedups `ws` tries to require; it falls back to pure JS.
  external: ["vscode", "bufferutil", "utf-8-validate"],
};

/** @type {import("esbuild").BuildOptions} */
const webview = {
  ...common,
  entryPoints: ["webview/main.tsx"],
  outfile: "dist/webview.js",
  platform: "browser",
  format: "iife",
  target: "es2022",
  jsx: "automatic",
  loader: { ".css": "css" },
  define: { "process.env.NODE_ENV": production ? '"production"' : '"development"' },
};

/**
 * The fixture test runs the webview's own modules in Node, so it needs them
 * bundled the same way - `zustand` and the `.ts` extensions are not
 * something `node --test` resolves on its own.
 */
/** @type {import("esbuild").BuildOptions} */
const tests = {
  ...common,
  minify: false,
  entryPoints: [
    "test/model.test.ts",
    "test/server.test.ts",
    "test/markdown.test.ts",
    "test/groups.test.ts",
    "test/textSync.test.ts",
    "test/projectPaths.test.ts",
    "test/projectSync.test.ts",
    "test/broker.test.ts",
    "test/autoLink.test.ts",
    "test/session.test.ts",
    "test/editorLink.test.ts",
  ],
  outdir: "dist/test",
  outExtension: { ".js": ".mjs" },
  platform: "node",
  format: "esm",
  target: "node20",
  // `vscode` only exists inside an editor; the server-resolution test swaps
  // in the little that its subject actually touches.
  alias: { vscode: "./test/vscode-stub.ts" },
  // Read at runtime, relative to the bundle - so it stays a fixture rather
  // than becoming part of the build.
  // werift and ws `require()` Node built-ins, which an ESM bundle cannot.
  external: ["node:*", "werift", "ws"],
};

if (process.argv.includes("--tests")) {
  // The fixture is read at runtime, relative to the bundle.
  cpSync("test/fixtures", "dist/test/fixtures", { recursive: true });
  await build(tests);
} else if (watch) {
  const contexts = await Promise.all([context(extension), context(webview)]);
  await Promise.all(contexts.map((c) => c.watch()));
} else {
  await Promise.all([build(extension), build(webview)]);
}
