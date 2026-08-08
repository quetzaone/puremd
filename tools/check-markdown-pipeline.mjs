// Asserts the one place where a mistake would be silent and serious: the order
// of rehype-raw and rehype-sanitize, and the fact that Safe mode never gets the
// wider schema. Run with `node tools/check-markdown-pipeline.mjs`.
//
// The pipeline below mirrors what react-markdown v9 builds internally — it
// always passes `allowDangerousHtml` to remark-rehype, which is why raw HTML
// survives as far as rehype-raw.

import assert from "node:assert/strict";
import rehypeRaw from "rehype-raw";
import rehypeSanitize from "rehype-sanitize";
import remarkGfm from "remark-gfm";
import remarkParse from "remark-parse";
import remarkRehype from "remark-rehype";
import { unified } from "unified";

import { isAllowedWebUrl } from "../src/markdown/linkPolicy.ts";
import { sanitizeSchemaFor, urlTransformFor } from "../src/markdown/sanitize.ts";

function render(markdown, extended) {
  const processor = unified()
    .use(remarkParse)
    .use(remarkGfm)
    .use(remarkRehype, { allowDangerousHtml: true });

  if (extended) {
    processor.use(rehypeRaw);
  }

  return processor.use(rehypeSanitize, sanitizeSchemaFor(extended)).runSync(processor.parse(markdown));
}

function collect(tree) {
  const tags = [];
  const attributes = [];
  const text = [];

  (function walk(node) {
    if (node.type === "element") {
      tags.push(node.tagName);
      attributes.push(...Object.entries(node.properties || {}).map(([key, value]) => `${key}=${value}`));
    }
    if (node.type === "text") {
      text.push(node.value);
    }
    (node.children || []).forEach(walk);
  })(tree);

  return { tags, attributes, text: text.join("") };
}

const hostile = [
  "<script>alert(1)</script>",
  '<img src=x onerror="alert(1)">',
  '<iframe src="https://example.com"></iframe>',
  '<a href="javascript:alert(1)">link</a>',
  "<svg onload=alert(1)></svg>",
  '<style>body{display:none}</style>',
  '<details open ontoggle="alert(1)"><summary>s</summary>body</details>'
].join("\n\n");

for (const extended of [false, true]) {
  const { tags, attributes } = collect(render(hostile, extended));
  const label = extended ? "extended" : "safe";

  for (const forbidden of ["script", "iframe", "style", "svg"]) {
    assert.ok(!tags.includes(forbidden), `${label}: <${forbidden}> survived sanitizing`);
  }
  for (const attribute of attributes) {
    assert.ok(!/^on/i.test(attribute), `${label}: event handler ${attribute} survived sanitizing`);
    assert.ok(!/javascript:/i.test(attribute), `${label}: ${attribute} kept a javascript: URI`);
  }
}

// Safe mode never runs rehype-raw, so raw HTML stays an unparsed `raw` node
// and the sanitizer drops it whole — an HTML block disappears with its
// contents, while the Markdown around it is untouched.
const safeBlock = collect(render("<details><summary>s</summary>body</details>", false));
assert.ok(!safeBlock.tags.includes("details"), "safe: raw HTML was parsed into elements");
assert.equal(safeBlock.text, "", "safe: raw HTML left something behind");

// Inline HTML behaves differently from a block: the opening and closing tags
// are separate raw nodes, so they are dropped and the text between them stays.
const safeInline = collect(render("before <kbd>Ctrl</kbd> after", false));
assert.ok(!safeInline.tags.includes("kbd"), "safe: inline raw HTML was parsed into elements");
assert.equal(safeInline.text, "before Ctrl after", "safe: text around inline HTML was disturbed");

// Extended mode turns the allowed inert tags into real elements.
const extended = collect(
  render("<details><summary>s</summary>body</details>\n\n<kbd>Ctrl</kbd> <mark>hi</mark> H<sub>2</sub>O", true)
);
for (const tag of ["details", "summary", "kbd", "mark", "sub"]) {
  assert.ok(extended.tags.includes(tag), `extended: <${tag}> did not survive`);
}

// data: image sources reach the component in extended mode only — the
// component is what decides whether the bytes are ever shown.
const dataUri = "![x](data:image/png;base64,AAAA)";
assert.ok(
  collect(render(dataUri, true)).attributes.some((value) => value.startsWith("src=data:")),
  "extended: the data: source was stripped before the component could see it"
);
assert.ok(
  !collect(render(dataUri, false)).attributes.some((value) => value.startsWith("src=data:")),
  "safe: a data: source reached the component"
);

// react-markdown filters URLs before the sanitizer runs, and its default throws
// away every scheme it does not know. The tree assertions above cannot see that
// stage, which is exactly how `data:` images shipped broken once already.
const dataImage = "data:image/png;base64,iVBORw0KGgoAAAANSUhEUgAAAAEAAAABAQAAAAA3bvkkAAAACklEQVR4nGNiAAAABgADNjd8qAAAAABJRU5ErkJggg==";
assert.equal(urlTransformFor(false)(dataImage, "src"), "", "safe: a data: image survived the URL filter");
assert.equal(urlTransformFor(true)(dataImage, "src"), dataImage, "extended: the data: image was filtered out");
assert.equal(urlTransformFor(true)(dataImage, "href"), "", "extended: a data: link survived the URL filter");
assert.equal(urlTransformFor(true)("javascript:alert(1)", "href"), "", "extended: a javascript: URI survived");
assert.equal(urlTransformFor(true)("media/pixel.png", "src"), "media/pixel.png", "a relative source was rewritten");
assert.equal(
  urlTransformFor(true)("https://example.com/x.png", "src"),
  "https://example.com/x.png",
  "an https source was rewritten"
);

// What the preview asks before it offers to open a link. An http(s) link has to
// survive this, or the application silently stops opening any link at all.
const blocked = (url) => !isAllowedWebUrl(url);

assert.ok(!blocked("https://example.com/page"), "an https link was blocked");
assert.ok(!blocked("http://example.com/page"), "an http link was blocked");
assert.ok(blocked("javascript:alert(1)"), "a javascript: link was allowed");
assert.ok(blocked("data:text/html,<script>"), "a data: link was allowed");
assert.ok(blocked("file:///C:/Windows/win.ini"), "a file: link was allowed");
assert.ok(blocked("vbscript:msgbox"), "a vbscript: link was allowed");
assert.ok(blocked("mailto:someone@example.com"), "a mailto: link was allowed");
assert.ok(blocked("./relative.md"), "a relative link was allowed");

console.log("markdown pipeline: ok");
