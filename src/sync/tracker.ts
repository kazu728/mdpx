import type { ScrollInfo } from "../pipeline.ts";
import type { FrameMeta } from "../sourcemap.ts";
import { CSS_SCALE } from "../viewport.ts";
import { buildLineMap, sourceLineAt, type LineMap } from "./linemap.ts";

/** Owns one line map per rendered generation; turns scroll commits into source lines. */
export class ScrollTracker {
  private readonly maps = new Map<number, LineMap>();

  setFrame(gen: number, meta: FrameMeta): void {
    this.maps.set(
      gen,
      buildLineMap(meta.anchors, meta.sourceLineCount, meta.documentHeightCssPx, meta.laidOutSourceLines),
    );
  }

  releaseFrame(gen: number): void {
    this.maps.delete(gen);
  }

  hasFrame(gen: number): boolean {
    return this.maps.has(gen);
  }

  displayedSourceLine(info: ScrollInfo): number | null {
    if (info.displayGen === null) return null;
    const map = this.maps.get(info.displayGen);
    if (!map) return null;
    return sourceLineAt(map, info.scrollPx / CSS_SCALE, info.jumpToEnd);
  }
}
