# skema for VSCode

Editing support and a live ER diagram for the [skema](https://gitlab.com/skema-language/skema)
modelling DSL: errors, hover, completion, go-to-definition, colouring and an
outline from the language's own frontend, and the model as a diagram beside
the text.

```bash
npm install
npm run build        # -> dist/
npm run watch        # rebuild on change; F5 in VSCode launches the host
npm run typecheck
npm test             # the model fixture (see below)
```

Press **F5** in VSCode to open an Extension Development Host with this
extension loaded. Without a bundled server binary it needs one to talk to —
see *Where the server comes from*.

## What it does

- **The language, answered by the language.** Diagnostics across the import
  graph, hover with what the model resolved (a relation's `onDelete`, the
  partial a field was inlined from), completion from the checker's own key
  and type catalogs, go-to-definition through an `import` and an alias, the
  document outline, and semantic-token colouring.

  There is deliberately **no TextMate grammar** in this extension. A regex
  grammar cannot tell a type reference from a field name, and it would be a
  second description of the syntax to keep in step with the first. Colours
  come from the real lexer, over LSP.

- **A diagram that follows the text** (*skema: Show diagram*, or the icon in
  the editor title bar): tables with their columns, relationship lines
  anchored to the exact field they connect, a `Group` as a labelled frame
  around its members, hover cards for the detail the boxes leave out, and a
  routing mode you can switch.

  A frame is sized by what it contains, so only its own corner is ever
  stored: its members keep their positions relative to it, and dragging a
  whole group by its label is one edit to the source rather than one per
  table.

- **Markdown documentation, live and exportable.** *skema: Show
  documentation* renders the resolved project - tables, columns, flags,
  relationships, enums, groups, and the prose from each `Meta { note = … }` -
  through VSCode's own built-in Markdown preview, refreshed as the model
  changes. *skema: Export documentation as Markdown* writes the same content
  to a `.md` file. No webview here: the output is plain Markdown, so the
  built-in previewer already renders it, in the user's own theme, for free
  (`src/docs/provider.ts`).

- **A language reference on hover, not just a resolved fact.** Hovering a
  field or table still shows what the model resolved; hovering a block
  keyword itself - `Document`, `Meta`, `Project`, `Style`, `Database`, `Lint`,
  `Partial`, `Datatype`, `Dialect`, `Field` - answers "what is this for, what
  goes inside it, which keys does it accept" from the language's own
  reference, since several of those blocks carry no schema meaning and so
  never appear in the resolved model at all. The same reference text backs
  completion: a suggested block keyword or flag carries its one-line
  explanation, and `[onDelete=` / `[onUpdate=` now suggest their fixed set of
  values (`cascade`, `restrict`, `setNull`, `setDefault`, `noAction`).

- **Dragging that writes a file beside the model.** Drag a table, or bend a
  relationship line, and it lands in `.skema/layout.json` next to the root
  document:

  ```json
  {
    "format": 1,
    "nodes": { "Customer": { "x": 120, "y": 340 } },
    "edges": { "Order.customer->Customer.id": { "points": [{ "x": 420, "y": 140 }] } }
  }
  ```

  Sorted and rounded to whole pixels, so it diffs and merges like any other
  file — while the `.skema` sources stay pure model. The write is applied as
  a `WorkspaceEdit`, which means **Ctrl-Z undoes a drag** like it undoes a
  keystroke.

- **The root file is found, not assumed.** Open any `.skema` file and the
  server analyzes it as part of the project whose `Project` block reaches it
  (`docs/02`). A file no project reaches is still checked — the diagram's
  status bar says so, because such a file lacks `mode` and `dialect`.

- **Double-click to the declaration**, click a relationship line to jump to
  where it is written, click the diagnostic in the status bar to go to it.

## Where the server comes from

Everything above is `skema-lsp`, a binary from the language repo. The
extension looks for it in three places, in order:

| | | |
|---|---|---|
| 1 | **`skema.serverPath`** | An absolute path you set. Wins outright, and a path that isn't executable is an error rather than a silent fallback — quietly running a different server than the one you asked for is how an afternoon disappears. This is how you run the extension against `cargo build -p skema-lsp`. |
| 2 | **The bundled binary** | `server/skema-lsp`, fetched at packaging time from the language project's GitLab package registry (`npm run fetch:server`). The normal case for a user, who installs nothing. |
| 3 | **`PATH`** | A `cargo install`ed one. This is what the platform-neutral VSIX relies on. |

The binary is **never committed here**. It is a release artifact of the
language repo, and `skemaServer.version` in `package.json` pins which release
a build bundles.

### Building a VSIX

```bash
npm run fetch:server                       # this platform
npm run fetch:server -- --target win32-x64 # another one
npm run build
npx vsce package --no-dependencies --target linux-x64
```

CI does this per platform on a tag. Which platforms exist is decided by the
language repo's release pipeline, and today that is **linux-x64** (musl,
statically linked, so it runs on any distribution) and **win32-x64**.

**macOS has no bundled binary**, and cannot get one from the current
pipeline: cross-compiling for Darwin needs the Apple SDK, which is not
redistributable, so it needs a macOS runner. Until there is one, macOS users
install the platform-neutral VSIX and either `cargo install --path
crates/skema-lsp` or point `skema.serverPath` at their own build. Everything
in the extension works that way — it is the same server.

### Nothing is published yet

The language repo has no tag, so its package registry is empty and
`npm run fetch:server` will report a 404. Tagging `skema-lang` runs the
release pipeline that fills it; until then, develop against a local build:

```bash
cd ../skema-lang && cargo build -p skema-lsp
# then, in VSCode settings:
#   "skema.serverPath": "/absolute/path/to/skema-lang/target/debug/skema-lsp"
```

## Settings

| Setting | Meaning |
|---|---|
| `skema.serverPath` | An explicit `skema-lsp` binary. |
| `skema.trace.server` | Log the LSP traffic into the *skema* output channel. |
| `skema.diagram.edgeRouting` | `bezier`, `smoothstep`, `step`, `straight`. |
| `skema.diagram.snapToGrid` / `skema.diagram.gridSize` | Snapping while dragging. |

The diagram's toolbar writes to these same settings, so a choice made on the
canvas outlives the panel.

## Layout

```
src/                 the extension host
  extension.ts       the language client, commands, configuration
  server.ts          finding the skema-lsp binary
  diagram/panel.ts   the webview, and the edits it asks for
  docs/provider.ts   the Markdown preview and export - no webview needed
shared/
  protocol.ts        both boundaries: the skema/ LSP messages, and the webview's
  markdown.ts        the model as Markdown - ported from skema-editor's docs pane
webview/             the diagram, running in the panel
  diagram/           this host's wiring: the pane, the hover card, the toolbar
  host.ts            the only way out of the sandbox
  store.ts           the model as last pushed in
test/                the fixture test
```

### Its relationship to `skemaeditor`

`webview/diagram/` is the browser editor's diagram, ported. The components,
the graph derivation, the layout and the `Style` cascade are the same code;
what changed is where their inputs come from — a WASM analysis in the page
there, the language server here — and three host calls (`revealLocation`,
`revealField`/`revealTable`, `applyPositionEdit`) that go through
`webview/host.ts` instead of straight into a store.

That is a second copy, and it can drift. It was the deliberate choice over a
shared npm package for now: two hosts have to exist before the seam between
them is known, and `webview/host.ts` is where that seam already is when the
time comes to extract one.

Two conventions worth knowing before changing the diagram:

- **A back-reference (`orders <Order.customer;`) is a real field in the
  model** with a real relation, but it creates no column and it describes a
  relationship the `>` side already describes. It is therefore filtered
  twice, independently: out of a node's column list and out of the edge list
  (`diagram/graph.ts`).
- **The webview never computes an edit.** Positions are written by
  `skema/positionEdit` on the server, against the file's current text. The
  offsets belong to one exact revision, and the webview does not have the
  text — VSCode's documents live in the extension host.

## The model types are generated

The diagram itself is not in this repository: it is `@skema/diagram` from
[skema-lib](https://gitlab.com/skema-language/skema-lib), shared with the
browser editor, and what stays here is only the wiring this host needs.
Model types come from `@skema/model`, generated in the language repo — the
server's `skema/model` response carries `skema-api`'s own structures,
serialized by the same serde derives that produce the browser's JSON, so
those declarations describe the LSP responses exactly.

`npm test` is what makes that a claim rather than a hope: it replays a real
`skema/model` response, captured from the real server against the language
repo's `examples/generic`, through the diagram's own derivation code. A
renamed field would otherwise arrive as `undefined` and quietly cost the
diagram its relationship lines.
