export type Heading = { level: number; text: string };

type OutlineProps = {
  headings: Heading[];
  emptyText: string;
  onSelect: (index: number) => void;
};

export default function Outline({ headings, emptyText, onSelect }: OutlineProps) {
  if (!headings.length) {
    return <div className="pm-outline-empty">{emptyText}</div>;
  }

  return (
    <>
      {headings.map((heading, index) => {
        const level = Math.min(3, Math.max(1, heading.level));
        return (
          <button
            key={`${index}-${heading.text}`}
            type="button"
            className={`pm-outline-row lv${level}`}
            title={heading.text}
            onClick={() => onSelect(index)}
          >
            {level > 1 && <span className="pm-outline-rail" aria-hidden="true" />}
            <span className="pm-outline-slot" aria-hidden="true">
              <i />
            </span>
            <span className="pm-outline-label">{heading.text}</span>
          </button>
        );
      })}
    </>
  );
}
