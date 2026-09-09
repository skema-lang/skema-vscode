/**
 * What the diagram is willing to render from a `Style` block.
 *
 * The language deliberately validates nothing here: `styleBlocks()` hands
 * over whatever key/value pairs a block contains. The catalog below is the
 * only gate, and it is a *visualization* vocabulary - closed lists of real
 * CSS keywords, no layout, no typography, no imagery. Anything it does not
 * recognize, key or value, is dropped without a word: a `Style` block is a
 * hint about appearance, never a reason to fail.
 */
import type { FileStyles } from "../../shared/protocol";
import type { MetaEntry, StyleBlock } from "../../shared/skema";

/** Style declarations exactly as written, keyed by property name. */
export type Declarations = Record<string, string>;

/** One selector's or class's declarations, keyed by its name. */
export type StyleRules = Record<string, Declarations>;

export interface ProjectStyles {
  projectSelectors: StyleRules;
  projectClasses: StyleRules;
  /** Keyed by file path - a `Document` block only styles its own file. */
  documentSelectors: Record<string, StyleRules>;
  documentClasses: Record<string, StyleRules>;
}

/** Recognized properties with validated values, ready to hand to CSS. */
export type ResolvedStyle = Record<string, string>;

type ValueParser = (raw: string) => string | undefined;
type PropertyCatalog = Record<string, ValueParser>;

const CSS_NAMED_COLORS = new Set([
  "aliceblue", "antiquewhite", "aqua", "aquamarine", "azure", "beige", "bisque",
  "black", "blanchedalmond", "blue", "blueviolet", "brown", "burlywood",
  "cadetblue", "chartreuse", "chocolate", "coral", "cornflowerblue", "cornsilk",
  "crimson", "cyan", "darkblue", "darkcyan", "darkgoldenrod", "darkgray",
  "darkgreen", "darkgrey", "darkkhaki", "darkmagenta", "darkolivegreen",
  "darkorange", "darkorchid", "darkred", "darksalmon", "darkseagreen",
  "darkslateblue", "darkslategray", "darkslategrey", "darkturquoise",
  "darkviolet", "deeppink", "deepskyblue", "dimgray", "dimgrey", "dodgerblue",
  "firebrick", "floralwhite", "forestgreen", "fuchsia", "gainsboro",
  "ghostwhite", "gold", "goldenrod", "gray", "green", "greenyellow", "grey",
  "honeydew", "hotpink", "indianred", "indigo", "ivory", "khaki", "lavender",
  "lavenderblush", "lawngreen", "lemonchiffon", "lightblue", "lightcoral",
  "lightcyan", "lightgoldenrodyellow", "lightgray", "lightgreen", "lightgrey",
  "lightpink", "lightsalmon", "lightseagreen", "lightskyblue", "lightslategray",
  "lightslategrey", "lightsteelblue", "lightyellow", "lime", "limegreen",
  "linen", "magenta", "maroon", "mediumaquamarine", "mediumblue",
  "mediumorchid", "mediumpurple", "mediumseagreen", "mediumslateblue",
  "mediumspringgreen", "mediumturquoise", "mediumvioletred", "midnightblue",
  "mintcream", "mistyrose", "moccasin", "navajowhite", "navy", "oldlace",
  "olive", "olivedrab", "orange", "orangered", "orchid", "palegoldenrod",
  "palegreen", "paleturquoise", "palevioletred", "papayawhip", "peachpuff",
  "peru", "pink", "plum", "powderblue", "purple", "rebeccapurple", "red",
  "rosybrown", "royalblue", "saddlebrown", "salmon", "sandybrown", "seagreen",
  "seashell", "sienna", "silver", "skyblue", "slateblue", "slategray",
  "slategrey", "snow", "springgreen", "steelblue", "tan", "teal", "thistle",
  "tomato", "turquoise", "violet", "wheat", "white", "whitesmoke", "yellow",
  "yellowgreen",
]);

const HEX_COLOR = /^#(?:[0-9a-f]{3}|[0-9a-f]{6})$/i;

/** Hex or a standard CSS name. Alpha forms stay out: a half-transparent
 *  node reads as a rendering glitch rather than as a decision. */
export function parseColor(raw: string): string | undefined {
  const value = raw.trim();
  if (HEX_COLOR.test(value)) return value;
  return CSS_NAMED_COLORS.has(value.toLowerCase()) ? value.toLowerCase() : undefined;
}

function keywordParser(...allowed: string[]): ValueParser {
  const vocabulary = new Set(allowed);
  return (raw) => {
    const value = raw.trim().toLowerCase();
    return vocabulary.has(value) ? value : undefined;
  };
}

export const parseWidth = keywordParser("thin", "medium", "thick");
export const parseLineStyle = keywordParser("solid", "dashed", "dotted");
export const parseFontSize = keywordParser("small", "medium", "large", "x-large");

/** A table box and an enum box are the same shape, so they paint the same. */
const BOX_PROPERTIES: PropertyCatalog = {
  headerBackgroundColor: parseColor,
  headerTextColor: parseColor,
  bodyBackgroundColor: parseColor,
  borderColor: parseColor,
  borderWidth: parseWidth,
  borderStyle: parseLineStyle,
};

const GROUP_PROPERTIES: PropertyCatalog = {
  backgroundColor: parseColor,
  borderColor: parseColor,
  borderWidth: parseWidth,
  borderStyle: parseLineStyle,
};

const PROJECT_PROPERTIES: PropertyCatalog = {
  backgroundColor: parseColor,
  fontSize: parseFontSize,
};

const DOCUMENT_PROPERTIES: PropertyCatalog = {
  backgroundColor: parseColor,
};

const RELATION_PROPERTIES: PropertyCatalog = {
  lineColor: parseColor,
  lineWidth: parseWidth,
  lineStyle: parseLineStyle,
};

export function emptyProjectStyles(): ProjectStyles {
  return {
    projectSelectors: {},
    projectClasses: {},
    documentSelectors: {},
    documentClasses: {},
  };
}

function declarations(entries: MetaEntry[]): Declarations {
  const written: Declarations = {};
  for (const entry of entries) {
    if (entry.value !== undefined) written[entry.key] = entry.value;
  }
  return written;
}

function addBlock(block: StyleBlock, selectors: StyleRules, classes: StyleRules): void {
  const name = block.selector ?? block.className;
  if (!name) return;
  const target = block.selector ? selectors : classes;
  target[name] = { ...target[name], ...declarations(block.entries) };
}

/**
 * Sorts every file's `Style` blocks into the four buckets the cascade
 * needs. A `Project`-scoped block outside the root file is ignored - the
 * language allows only one `Project` block, and a stray one is not a
 * project-wide default.
 *
 * The blocks are read by the language server (`skema/model`) rather than
 * parsed here, which is the one difference from the browser editor's copy of
 * this file: there, the parser is in the page.
 */
export function collectProjectStyles(files: FileStyles[], rootPath: string): ProjectStyles {
  const styles = emptyProjectStyles();

  for (const { path, blocks } of files) {
    const fileSelectors: StyleRules = {};
    const fileClasses: StyleRules = {};

    for (const block of blocks) {
      if (block.scope === "document") {
        addBlock(block, fileSelectors, fileClasses);
        continue;
      }
      if (path === rootPath) addBlock(block, styles.projectSelectors, styles.projectClasses);
    }

    styles.documentSelectors[path] = fileSelectors;
    styles.documentClasses[path] = fileClasses;
  }

  return styles;
}

/** `styleClasses = [highlight, core]` reaches us as `"highlight, core"`. */
export function readStyleClasses(entries: MetaEntry[] | undefined): string[] {
  const value = entries?.find((entry) => entry.key === "styleClasses")?.value;
  if (!value) return [];
  return value
    .split(",")
    .map((name) => name.trim())
    .filter((name) => name.length > 0);
}

/**
 * `docs/03`: `Project` selector, then this file's `Document` selector, then
 * the assigned classes in list order. A class declared in the file itself
 * shadows a project-wide one of the same name.
 */
function cascade(
  styles: ProjectStyles,
  selector: string,
  file: string,
  classNames: string[],
): Array<Declarations | undefined> {
  const documentClasses = styles.documentClasses[file] ?? {};
  return [
    styles.projectSelectors[selector],
    styles.documentSelectors[file]?.[selector],
    ...classNames.map((name) => documentClasses[name] ?? styles.projectClasses[name]),
  ];
}

function apply(
  layers: Array<Declarations | undefined>,
  properties: PropertyCatalog,
): ResolvedStyle {
  const resolved: ResolvedStyle = {};
  for (const layer of layers) {
    if (!layer) continue;
    for (const [property, raw] of Object.entries(layer)) {
      const value = properties[property]?.(raw);
      if (value !== undefined) resolved[property] = value;
    }
  }
  return resolved;
}

export function resolveTableStyle(
  styles: ProjectStyles,
  file: string,
  classNames: string[],
): ResolvedStyle {
  return apply(cascade(styles, "table", file, classNames), BOX_PROPERTIES);
}

export function resolveEnumStyle(
  styles: ProjectStyles,
  file: string,
  classNames: string[],
): ResolvedStyle {
  return apply(cascade(styles, "enum", file, classNames), BOX_PROPERTIES);
}

export function resolveGroupStyle(
  styles: ProjectStyles,
  file: string,
  classNames: string[],
): ResolvedStyle {
  return apply(cascade(styles, "group", file, classNames), GROUP_PROPERTIES);
}

/** Relationships carry no `Meta`, so there are no classes to assign. */
export function resolveRelationStyle(styles: ProjectStyles, file: string): ResolvedStyle {
  return apply(cascade(styles, "relation", file, []), RELATION_PROPERTIES);
}

/** The diagram frame is project-wide by definition: no per-file override. */
export function resolveProjectStyle(styles: ProjectStyles): ResolvedStyle {
  return apply([styles.projectSelectors["project"]], PROJECT_PROPERTIES);
}

export function resolveDocumentStyle(styles: ProjectStyles, file: string): ResolvedStyle {
  return apply(cascade(styles, "document", file, []), DOCUMENT_PROPERTIES);
}

/**
 * A resolved value is already a legal CSS value, so a node only has to hand
 * it to the stylesheet: the rules declare `var(--node-…, <theme default>)`
 * and a node that resolved nothing simply stays on the theme.
 */
const NODE_VARIABLES: Record<string, string> = {
  headerBackgroundColor: "--node-header-bg",
  headerTextColor: "--node-header-fg",
  bodyBackgroundColor: "--node-body-bg",
  borderColor: "--node-border-color",
  borderWidth: "--node-border-width",
  borderStyle: "--node-border-style",
};

const GROUP_VARIABLES: Record<string, string> = {
  backgroundColor: "--group-bg",
  borderColor: "--group-border-color",
  borderWidth: "--group-border-width",
  borderStyle: "--group-border-style",
};

function cssVariables(
  style: ResolvedStyle,
  variables: Record<string, string>,
): Record<string, string> {
  const declared: Record<string, string> = {};
  for (const [property, variable] of Object.entries(variables)) {
    const value = style[property];
    if (value !== undefined) declared[variable] = value;
  }
  return declared;
}

export function nodeStyleVariables(style: ResolvedStyle): Record<string, string> {
  return cssVariables(style, NODE_VARIABLES);
}

export function groupStyleVariables(style: ResolvedStyle): Record<string, string> {
  return cssVariables(style, GROUP_VARIABLES);
}
