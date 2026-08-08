import { useMemo } from "react";
import type { Strings } from "../i18n";

type MarkdownEditorProps = {
  value: string;
  t: Strings;
  onChange: (value: string) => void;
  onOpenGuide: () => void;
};

export default function MarkdownEditor({ value, t, onChange, onOpenGuide }: MarkdownEditorProps) {
  const lines = useMemo(() => value.split("\n"), [value]);

  return (
    <div className={value ? "pm-code" : "pm-code has-hints"}>
      <div className="pm-code-body">
        <div aria-hidden="true">
          {lines.map((line, index) => (
            <div key={index} className="pm-code-row">
              <span className="pm-code-num" data-find-skip="">{index + 1}</span>
              <span className="pm-code-text">{line || " "}</span>
            </div>
          ))}
        </div>
        <textarea
          className="pm-code-input"
          spellCheck={false}
          value={value}
          onChange={(event) => onChange(event.currentTarget.value)}
          autoFocus
        />
      </div>

      {!value && (
        <div className="pm-code-hints" data-find-skip="">
          <div>{t.emptyDocument}</div>
          <div className="pm-code-hint">
            <span className="pm-kbd">Ctrl S</span>
            {t.saveItAsFile}
          </div>
          <div className="pm-code-hint">
            <button type="button" className="pm-kbd" onClick={onOpenGuide}>
              {t.guide}
            </button>
            {t.copySnippet}
          </div>
        </div>
      )}
    </div>
  );
}
