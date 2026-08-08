import { type RefObject, useCallback, useEffect, useRef, useState } from "react";

const MAX_RANGES = 900;

type FindOptions = {
  /** Scroll container the document lives in. */
  scrollRef: RefObject<HTMLElement | null>;
  /** Element whose text is searched (preview article or code mirror). */
  rootRef: RefObject<HTMLElement | null>;
  query: string;
  active: boolean;
  /** Bump to re-run the search when the document or view changes. */
  revision: string;
};

const highlightApi = () =>
  typeof CSS !== "undefined" && "highlights" in CSS && typeof (globalThis as { Highlight?: unknown }).Highlight === "function";

function clearHighlights() {
  if (!highlightApi()) {
    return;
  }

  CSS.highlights.delete("pmfind");
  CSS.highlights.delete("pmfindcur");
}

/**
 * Live search painted with the CSS Custom Highlight API: the rendered document is
 * never mutated, so highlights survive re-renders and cannot alter the source.
 */
export function useFind({ scrollRef, rootRef, query, active, revision }: FindOptions) {
  const [hits, setHits] = useState<number[]>([]);
  const [index, setIndex] = useState(0);
  const rangesRef = useRef<Range[]>([]);
  const previousQueryRef = useRef("");
  const indexRef = useRef(0);

  const applyIndex = useCallback((next: number) => {
    indexRef.current = next;
    setIndex(next);
  }, []);

  const scrollToHit = useCallback(
    (target: number) => {
      const container = scrollRef.current;
      const range = rangesRef.current[target];
      if (!container || !range) {
        return;
      }

      const box = range.getBoundingClientRect();
      const frame = container.getBoundingClientRect();
      if (box.top >= frame.top + 60 && box.bottom <= frame.bottom - 60) {
        return;
      }

      container.scrollTo({
        top: Math.max(0, container.scrollTop + (box.top - frame.top) - container.clientHeight * 0.38),
        behavior: "smooth"
      });
    },
    [scrollRef]
  );

  useEffect(() => {
    const root = rootRef.current;
    const container = scrollRef.current;
    const needle = query.trim();
    clearHighlights();

    if (!root || !container || !active || !needle) {
      rangesRef.current = [];
      previousQueryRef.current = "";
      setHits((current) => (current.length ? [] : current));
      applyIndex(0);
      return;
    }

    const lowerNeedle = needle.toLocaleLowerCase();
    const ranges: Range[] = [];
    // The edit mirror carries chrome — line numbers, empty-doc hints — that is not
    // part of the document. Marked with data-find-skip so it never counts as a hit.
    const walker = document.createTreeWalker(root, NodeFilter.SHOW_TEXT, {
      acceptNode: (candidate) =>
        candidate.parentElement?.closest("[data-find-skip]") ? NodeFilter.FILTER_REJECT : NodeFilter.FILTER_ACCEPT
    });
    let node = walker.nextNode();

    while (node && ranges.length < MAX_RANGES) {
      const text = node.nodeValue;
      if (text && text.trim()) {
        const lowerText = text.toLocaleLowerCase();
        let at = lowerText.indexOf(lowerNeedle);
        while (at !== -1 && ranges.length < MAX_RANGES) {
          const range = document.createRange();
          range.setStart(node, at);
          range.setEnd(node, at + needle.length);
          ranges.push(range);
          at = lowerText.indexOf(lowerNeedle, at + needle.length);
        }
      }
      node = walker.nextNode();
    }

    rangesRef.current = ranges;

    const frame = container.getBoundingClientRect();
    const scrollHeight = container.scrollHeight || 1;
    const positions = ranges.map((range) => {
      const box = range.getBoundingClientRect();
      return Math.max(0, Math.min(1, (box.top - frame.top + container.scrollTop) / scrollHeight));
    });

    const isFreshQuery = needle !== previousQueryRef.current;
    previousQueryRef.current = needle;

    const nextIndex = isFreshQuery ? 0 : Math.max(0, Math.min(indexRef.current, ranges.length - 1));
    applyIndex(nextIndex);

    if (highlightApi() && ranges.length) {
      CSS.highlights.set("pmfind", new Highlight(...ranges));
    }

    setHits(positions);

    if (isFreshQuery && ranges.length) {
      requestAnimationFrame(() => scrollToHit(nextIndex));
    }
  }, [active, applyIndex, query, revision, rootRef, scrollRef, scrollToHit]);

  useEffect(() => {
    if (!highlightApi()) {
      return;
    }

    const range = rangesRef.current[index];
    if (range) {
      CSS.highlights.set("pmfindcur", new Highlight(range));
    } else {
      CSS.highlights.delete("pmfindcur");
    }
  }, [hits, index]);

  useEffect(() => clearHighlights, []);

  const goto = useCallback(
    (delta: number) => {
      const total = rangesRef.current.length;
      if (!total) {
        return;
      }

      const next = (((indexRef.current + delta) % total) + total) % total;
      applyIndex(next);
      scrollToHit(next);
    },
    [applyIndex, scrollToHit]
  );

  return { hits, index, count: hits.length, goto };
}
