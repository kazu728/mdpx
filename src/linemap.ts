// Source line anchors and the px → source line conversion (§4.9). A pure module with no I/O.
//
// An anchor is a {source line, CSS px} pair from the data-source-line elements html.ts emitted, which
// chrome.ts collects from the DOM in document order right after loading. Here they are normalized
// into a monotonic sequence and interpolated on lookup to turn "px at the top of the viewport" into a
// source line.
//
// crossnote (the MPE core) expands the same information into a dense "every source line → px" array,
// but the dense form exists to serve editor → preview lookups of "arbitrary line → px" by array
// index. mdpx only ever needs the reverse (px → line), so binary-searching a sparse anchor list and
// interpolating on lookup yields mathematically the same value.

export interface Anchor {
  /** Source line number (1-based, the same basis as nvim's line numbers). */
  line: number;
  /** CSS px offset from the top of the document. */
  top: number;
}

export interface LineMap {
  /** Anchors strictly increasing in both line and top (including the virtual head and tail anchors). */
  anchors: Anchor[];
  /** Total number of source lines. Used to clamp lineAt's upper bound. */
  lineCount: number;
  /**
   * Whether each source line occupies height when rendered (1-based; built by html.ts's laidOutLines).
   * Empty means no narrowing.
   */
  laidOut: readonly boolean[];
}

/**
 * Number of source lines, counted by nvim's line("$") rule (a trailing newline does not add a line;
 * empty still counts as 1). Since the lines are sent to nvim, they are counted the way nvim counts them.
 */
export function countLines(markdown: string): number {
  const n = markdown.split("\n").length;
  return Math.max(1, markdown.endsWith("\n") ? n - 1 : n);
}

/**
 * Turn an anchor list into a monotonic LineMap.
 *
 * A virtual {1, 0} goes at the head and {lineCount + 1, docCssH} at the tail, and in between only
 * anchors **strictly increasing in both** line and top survive. Three kinds get dropped:
 *  - lines that go backwards (elements like footnotes, where document order diverges from source order)
 *  - duplicates pointing at the same line (nesting puts a list_item and the paragraph inside it on the same line)
 *  - tops that go backwards or exceed docCssH
 * Strict monotonicity guarantees a finite slope between adjacent anchors, so lineAt's interpolation is
 * defined across the whole range.
 */
export function buildLineMap(
  anchors: readonly Anchor[],
  lineCount: number,
  docCssH: number,
  laidOut: readonly boolean[] = [],
): LineMap {
  const lines = Math.max(1, Math.floor(lineCount));
  const height = Math.max(0, docCssH);
  const out: Anchor[] = [{ line: 1, top: 0 }];
  for (const a of anchors) {
    if (!Number.isFinite(a.line) || !Number.isFinite(a.top)) continue;
    const line = Math.floor(a.line);
    const last = out[out.length - 1]!;
    if (line <= last.line || a.top <= last.top || a.top > height) continue;
    out.push({ line, top: a.top });
  }
  // The tail anchor. Mapping the bottom of the document to the line *after* the last one makes the
  // final interval converge on lineCount (using lineCount itself would make the last line hit at a
  // single point only)
  const last = out[out.length - 1]!;
  if (lines + 1 > last.line && height > last.top) out.push({ line: lines + 1, top: height });
  return { anchors: out, lineCount: lines, laidOut };
}

/**
 * If the landing point is a line that occupies no height, fall back to the nearest earlier line that does.
 *
 * Blank lines, a fence's ``` lines, and a table's separator row take a line in the source but have no
 * place in the rendering, and the interpolation apportions px to them anyway. The landing point
 * therefore slides toward "the blank line after the line being read" the closer it gets to the bottom
 * of a block. It always falls backwards because whatever is visible at the top edge is necessarily
 * content from that line or earlier. When laidOut is empty (no information) or nothing is found going
 * back, the interpolated value is returned as is.
 */
function snapToLaidOut(laidOut: readonly boolean[], line: number): number {
  if (laidOut.length === 0) return line;
  for (let l = line; l >= 1; l--) if (laidOut[l]) return l;
  return line;
}

/**
 * The source line at cssY (the document CSS px at the top of the viewport), 1-based and clamped to
 * [1, lineCount].
 *
 * atEnd marks the scroll having reached the end, in which case the document's last line is returned
 * instead of the interpolated value: `G` means "end of the document", not "first line of the last
 * screen". That is also why a trailing blank line is not put through snapToLaidOut — nvim's own `G`
 * goes to a trailing blank line, so this matches it.
 * The head needs no special case (cssY = 0 hits the head anchor and naturally yields line 1).
 */
export function lineAt(map: LineMap, cssY: number, atEnd: boolean): number {
  if (atEnd) return map.lineCount;
  const a = map.anchors;
  // The last anchor with top <= cssY (a[0].top is 0, so there is always at least one)
  let lo = 0;
  let hi = a.length - 1;
  while (lo < hi) {
    const mid = (lo + hi + 1) >> 1;
    if (a[mid]!.top <= cssY) lo = mid;
    else hi = mid - 1;
  }
  const cur = a[lo]!;
  const next = a[lo + 1];
  // Inside a block the estimate is "start line + proportional px", so the line advances smoothly even
  // through a long paragraph or the middle of a fence
  const line = next
    ? cur.line + ((cssY - cur.top) / (next.top - cur.top)) * (next.line - cur.line)
    : cur.line;
  return snapToLaidOut(map.laidOut, Math.min(map.lineCount, Math.max(1, Math.floor(line))));
}
