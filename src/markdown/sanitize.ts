import { defaultUrlTransform } from "react-markdown";
import { defaultSchema } from "rehype-sanitize";

/**
 * Safe mode. The GitHub default schema minus everything that can execute,
 * embed or style, with links narrowed to http and https.
 *
 * This object is what the default mode renders with. Widening the extended
 * mode below must never touch it — that separation is the whole point of
 * having two schemas instead of one.
 */
export const safeSchema = {
  ...defaultSchema,
  tagNames: defaultSchema.tagNames?.filter(
    (tag) => !["iframe", "object", "embed", "script", "style"].includes(tag)
  ),
  attributes: {
    ...defaultSchema.attributes,
    a: [["href"], ["title"]],
    img: [["src"], ["alt"], ["title"]]
  },
  protocols: {
    ...defaultSchema.protocols,
    href: ["http", "https"]
  }
};

/**
 * Extended mode, enabled per document by the user. Adds data: image sources
 * and `mark`; the other inert tags this mode advertises — details, summary,
 * kbd, sub, sup — are already in the default schema and only become reachable
 * because this mode also runs rehype-raw.
 *
 * `src` gains `data` so rehype-sanitize keeps the URI on the node. The URI
 * still never reaches a real `<img>`: MarkdownPreview intercepts every image
 * and hands the bytes to Rust for validation first.
 */
export const extendedSchema = {
  ...safeSchema,
  tagNames: [...(safeSchema.tagNames ?? []), "mark"],
  attributes: {
    ...safeSchema.attributes,
    details: [["open"]]
  },
  protocols: {
    ...safeSchema.protocols,
    src: ["http", "https", "data"]
  }
};

export function sanitizeSchemaFor(extended: boolean) {
  return extended ? extendedSchema : safeSchema;
}

/**
 * The other half of the policy, and the half that is easy to miss: react-markdown
 * filters URLs itself, before the sanitizer sees the tree, and its default drops
 * every scheme outside http, https, mailto and xmpp — silently including the
 * `data:` images Extended mode exists to show.
 *
 * Only image sources are widened, only in the extended mode, and only for
 * `data:`. Everything else keeps the default treatment — the schema above still
 * has the final say afterwards.
 */
export function urlTransformFor(extended: boolean) {
  return (url: string, key: string) =>
    extended && key === "src" && url.startsWith("data:") ? url : defaultUrlTransform(url);
}
