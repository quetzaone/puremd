import { type ReactNode, useEffect, useRef, useState } from "react";
import type { Strings } from "../i18n";
import { CheckIcon } from "./icons";

type Tip = { name: keyof Strings; snippet: string; sample: ReactNode };

const tips: Tip[] = [
  { name: "tipHeading", snippet: "## Heading", sample: <span className="pm-sample-h">Heading</span> },
  { name: "tipBold", snippet: "**bold text**", sample: <span className="pm-sample-b">bold text</span> },
  { name: "tipItalic", snippet: "_italic text_", sample: <span className="pm-sample-i">italic text</span> },
  { name: "tipStrikethrough", snippet: "~~removed~~", sample: <span className="pm-sample-s">removed</span> },
  { name: "tipQuote", snippet: "> quoted line", sample: <span className="pm-sample-q">quoted line</span> },
  {
    name: "tipList",
    snippet: "- first item\n- second item",
    sample: (
      <span className="pm-sample-list">
        <span>
          <span>•</span>first item
        </span>
        <span>
          <span>•</span>second item
        </span>
      </span>
    )
  },
  {
    name: "tipNumberedList",
    snippet: "1. first\n2. second",
    sample: (
      <span className="pm-sample-list">
        <span>
          <span>1.</span>first
        </span>
        <span>
          <span>2.</span>second
        </span>
      </span>
    )
  },
  {
    name: "tipTaskList",
    snippet: "- [ ] todo\n- [x] done",
    sample: (
      <span className="pm-sample-tasks">
        <span>
          <span className="pm-sample-box" />
          todo
        </span>
        <span>
          <span className="pm-sample-box is-done">
            <CheckIcon />
          </span>
          done
        </span>
      </span>
    )
  },
  { name: "tipLink", snippet: "[label](https://example.com)", sample: <span className="pm-sample-link">label</span> },
  { name: "tipImage", snippet: "![alt text](./image.png)", sample: <span className="pm-sample-img">alt text</span> },
  {
    name: "tipInlineCode",
    snippet: "`value()`",
    sample: (
      <span>
        <span className="pm-sample-code">value()</span>
      </span>
    )
  },
  { name: "tipCodeBlock", snippet: "```txt\ncode here\n```", sample: <span className="pm-sample-pre">code here</span> },
  {
    name: "tipTable",
    snippet: "| A | B |\n| --- | --- |\n| 1 | 2 |",
    sample: (
      <span className="pm-sample-table">
        <span>A</span>
        <span>B</span>
        <span>1</span>
        <span>2</span>
      </span>
    )
  },
  { name: "tipDivider", snippet: "---", sample: <span className="pm-sample-hr" /> }
];

export default function MarkdownGuide({ t }: { t: Strings }) {
  const [copied, setCopied] = useState<number | null>(null);
  const timerRef = useRef<number>();

  useEffect(() => () => window.clearTimeout(timerRef.current), []);

  function copy(index: number, snippet: string) {
    void navigator.clipboard?.writeText(snippet).catch(() => undefined);
    window.clearTimeout(timerRef.current);
    setCopied(index);
    timerRef.current = window.setTimeout(() => setCopied(null), 2200);
  }

  return (
    <>
      <div className={copied === null ? "pm-guide-head" : "pm-guide-head is-copied"}>
        <span>{t.markdown}</span>
        <span className="pm-guide-hint">{t.clickToCopy}</span>
        <span className="pm-guide-copied">{t.copied}</span>
      </div>
      {tips.map((tip, index) => (
        <button
          key={tip.snippet}
          type="button"
          className={copied === index ? "pm-tip is-copied" : "pm-tip"}
          title={t.clickToCopy}
          onClick={() => copy(index, tip.snippet)}
        >
          <span className="pm-tip-name">{t[tip.name] as string}</span>
          {tip.sample}
          <code>{tip.snippet}</code>
        </button>
      ))}
    </>
  );
}
