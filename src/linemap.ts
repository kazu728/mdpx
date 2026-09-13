export interface Anchor {
  sourceLine: number;
  topCssPx: number;
}

export interface LineMap {
  anchors: Anchor[];
  sourceLineCount: number;
  laidOutSourceLines: ReadonlySet<number>;
}

export function countSourceLines(markdown: string): number {
  const n = markdown.split("\n").length;
  return Math.max(1, markdown.endsWith("\n") ? n - 1 : n);
}

export function buildLineMap(
  anchors: readonly Anchor[],
  sourceLineCount: number,
  documentHeightCssPx: number,
  laidOutSourceLines: ReadonlySet<number>,
): LineMap {
  const clampedDocumentHeightCssPx = Math.max(0, documentHeightCssPx);
  const monotonicAnchors: Anchor[] = [{ sourceLine: 1, topCssPx: 0 }];
  for (const anchor of anchors) {
    if (!Number.isFinite(anchor.sourceLine) || !Number.isFinite(anchor.topCssPx)) continue;
    const sourceLine = Math.floor(anchor.sourceLine);
    const last = monotonicAnchors[monotonicAnchors.length - 1]!;
    if (
      sourceLine <= last.sourceLine ||
      anchor.topCssPx <= last.topCssPx ||
      anchor.topCssPx > clampedDocumentHeightCssPx
    ) {
      continue;
    }
    monotonicAnchors.push({ sourceLine, topCssPx: anchor.topCssPx });
  }
  // Tail anchor maps the document bottom to sourceLineCount+1 so the last line is reachable.
  const last = monotonicAnchors[monotonicAnchors.length - 1]!;
  if (
    sourceLineCount + 1 > last.sourceLine &&
    clampedDocumentHeightCssPx > last.topCssPx
  ) {
    monotonicAnchors.push({
      sourceLine: sourceLineCount + 1,
      topCssPx: clampedDocumentHeightCssPx,
    });
  }
  return {
    anchors: monotonicAnchors,
    sourceLineCount,
    laidOutSourceLines,
  };
}

function snapToLaidOutSourceLine(laidOutSourceLines: ReadonlySet<number>, sourceLine: number): number {
  if (laidOutSourceLines.size === 0) return sourceLine;
  for (let line = sourceLine; line >= 1; line--) {
    if (laidOutSourceLines.has(line)) return line;
  }
  return sourceLine;
}

// jumpToEnd lands on the last line like nvim's `G` on a trailing blank.
export function sourceLineAt(
  map: LineMap,
  viewportTopCssPx: number,
  jumpToEnd: boolean,
): number {
  if (jumpToEnd) return map.sourceLineCount;
  const a = map.anchors;
  let lo = 0;
  let hi = a.length - 1;
  while (lo < hi) {
    const mid = (lo + hi + 1) >> 1;
    if (a[mid]!.topCssPx <= viewportTopCssPx) lo = mid;
    else hi = mid - 1;
  }
  const cur = a[lo]!;
  const next = a[lo + 1];
  const sourceLine = next
    ? cur.sourceLine +
      ((viewportTopCssPx - cur.topCssPx) / (next.topCssPx - cur.topCssPx)) *
        (next.sourceLine - cur.sourceLine)
    : cur.sourceLine;
  const clampedSourceLine = Math.min(
    map.sourceLineCount,
    Math.max(1, Math.floor(sourceLine)),
  );
  return snapToLaidOutSourceLine(map.laidOutSourceLines, clampedSourceLine);
}
