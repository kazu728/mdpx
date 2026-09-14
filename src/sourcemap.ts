// Generic document sourcemap: where each rendered block came from in the
// markdown source. Produced by the core render path; who consumes it
// (e.g. editor cursor sync) is none of core's business.

export interface Anchor {
  sourceLine: number;
  topCssPx: number;
}

/** Everything a consumer needs to map one rendered generation back to source. */
export interface FrameMeta {
  anchors: Anchor[];
  sourceLineCount: number;
  documentHeightCssPx: number;
  laidOutSourceLines: ReadonlySet<number>;
}

export function countSourceLines(markdown: string): number {
  const n = markdown.split("\n").length;
  return Math.max(1, markdown.endsWith("\n") ? n - 1 : n);
}
