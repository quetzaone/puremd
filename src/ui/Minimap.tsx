import { type CSSProperties, type PointerEvent as ReactPointerEvent, useMemo, useRef } from "react";

type MinimapProps = {
  content: string;
  /** 0–1 share of the document above the viewport. */
  viewportTop: number;
  /** 0–1 share of the document the viewport covers. */
  viewportHeight: number;
  hits: number[];
  hitIndex: number;
  ghostOpacity: number;
  windowHeight: number;
  title: string;
  /** Receives the grabbed position as a 0–1 ratio of the map's content height. */
  onScrub: (ratio: number) => void;
};

// More rows than this cannot be told apart at ~0.7px each; sample instead.
const MAX_DENSITY_ROWS = 1000;

type Row = { text: string; style: CSSProperties };

function availableHeight(windowHeight: number) {
  return Math.max(180, windowHeight - 200);
}

function textRows(lines: string[]): Row[] {
  return lines.map((line) => {
    if (line.startsWith("# ")) {
      return { text: line.slice(2), style: { font: "600 6px/1.4 var(--font-ui)", color: "#e9eff6", margin: "2px 0 1px" } };
    }
    if (line.startsWith("## ")) {
      return { text: line.slice(3), style: { font: "600 5px/1.4 var(--font-ui)", color: "#ccd6e1", margin: "4px 0 1px" } };
    }
    if (line.startsWith("### ")) {
      return { text: line.slice(4), style: { font: "600 4.5px/1.4 var(--font-ui)", color: "#b6c2cf", margin: "3px 0 1px" } };
    }
    if (!line.trim()) {
      return { text: " ", style: { height: "3px", font: "400 3px/1 var(--font-ui)" } };
    }
    return { text: line, style: { font: "400 4px/1.5 var(--font-ui)", color: "rgba(151,163,178,.75)" } };
  });
}

function densityRows(lines: string[], available: number): Row[] {
  const stride = Math.ceil(lines.length / MAX_DENSITY_ROWS);
  const sampled = stride > 1 ? lines.filter((_, index) => index % stride === 0) : lines;
  const rowHeight = available / Math.max(sampled.length, 1);

  const bar = (height: number, width: number, color: string, offset: number): Row => {
    const barHeight = Math.max(0.7, Math.min(rowHeight * 0.92, height));
    const top = Math.min(offset, Math.max(0, rowHeight - barHeight));
    return {
      text: " ",
      style: {
        font: "0/0 a",
        height: `${barHeight.toFixed(2)}px`,
        width: `${width}%`,
        background: color,
        borderRadius: "1px",
        margin: `${top.toFixed(2)}px 0 ${Math.max(0, rowHeight - barHeight - top).toFixed(2)}px`
      }
    };
  };

  return sampled.map((line) => {
    if (line.startsWith("# ")) return bar(3.2, 84, "#dbe6f2", 0);
    if (line.startsWith("## ")) return bar(2.6, 72, "#b3c3d7", 2);
    if (line.startsWith("### ")) return bar(2.1, 58, "#9aabc0", 1.4);
    if (!line.trim()) return { text: " ", style: { font: "0/0 a", height: `${rowHeight.toFixed(2)}px` } };
    return bar(1.5, Math.max(16, Math.min(100, Math.round(line.length))), "rgba(151,163,178,.5)", 0);
  });
}

export default function Minimap({
  content,
  viewportTop,
  viewportHeight,
  hits,
  hitIndex,
  ghostOpacity,
  windowHeight,
  title,
  onScrub
}: MinimapProps) {
  const dragRef = useRef<{ top: number; height: number } | null>(null);
  const available = availableHeight(windowHeight);

  const { rows, dense } = useMemo(() => {
    const lines = content.split("\n");
    const isDense = lines.length * 6 > available;
    return { rows: isDense ? densityRows(lines, available) : textRows(lines), dense: isDense };
  }, [available, content]);

  // The element list, not just the row data. The viewport slab moves on every
  // scroll frame, and rebuilding a thousand divs each time for React to compare
  // is most of what made scrolling stutter. Memoised, the reconciler sees the
  // same element and skips the subtree outright.
  const ghost = useMemo(
    () => (
      <div className="pm-minimap-ghost" aria-hidden="true">
        {rows.map((row, order) => (
          <div key={order} style={row.style}>
            {row.text}
          </div>
        ))}
      </div>
    ),
    [rows]
  );

  function scrub(event: ReactPointerEvent<HTMLDivElement>) {
    const drag = dragRef.current;
    if (!drag) {
      return;
    }

    onScrub(Math.min(1, Math.max(0, (event.clientY - drag.top) / drag.height)));
  }

  function startScrub(event: ReactPointerEvent<HTMLDivElement>) {
    // The overlay layer is inset by the surface's 10px padding, so drags are
    // measured against the map content rather than the padding box.
    const box = event.currentTarget.getBoundingClientRect();
    dragRef.current = { top: box.top + 10, height: Math.max(1, box.height - 20) };
    event.currentTarget.setPointerCapture(event.pointerId);
    scrub(event);
  }

  const viewportStyle: CSSProperties =
    viewportHeight >= 0.999
      ? { opacity: 0 }
      : {
          top: `${(viewportTop * 100).toFixed(2)}%`,
          height: `${(Math.min(1 - viewportTop, Math.max(viewportHeight, 0.045)) * 100).toFixed(2)}%`,
          opacity: 1
        };

  return (
    <div
      className={dense ? "pm-minimap is-dense" : "pm-minimap is-text"}
      style={{ "--minimap-ghost": ghostOpacity } as CSSProperties}
    >
      <div
        className="pm-minimap-surface"
        title={title}
        onPointerDown={startScrub}
        onPointerMove={(event) => dragRef.current && scrub(event)}
        onPointerUp={() => {
          dragRef.current = null;
        }}
        onPointerCancel={() => {
          dragRef.current = null;
        }}
      >
        <span className="pm-minimap-overlay" aria-hidden="true">
          <span className="pm-minimap-vp" style={viewportStyle} />
          {hits.map((position, order) => (
            <span
              key={order}
              className={order === hitIndex ? "pm-minimap-tick is-current" : "pm-minimap-tick"}
              style={{ top: `${(position * 100).toFixed(2)}%` }}
            />
          ))}
        </span>
        {ghost}
      </div>
    </div>
  );
}
