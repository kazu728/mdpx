import { describe, expect, test } from "bun:test";
import { CSS_SCALE } from "../viewport.ts";
import { ScrollTracker } from "./tracker.ts";

const META = {
  anchors: [{ sourceLine: 3, topCssPx: 500 }],
  sourceLineCount: 10,
  documentHeightCssPx: 1000,
  laidOutSourceLines: new Set<number>(),
};

describe("ScrollTracker", () => {
  test("resolves the mapped line for a scroll commit", () => {
    const tracker = new ScrollTracker();
    tracker.setFrame(1, META);
    expect(
      tracker.displayedSourceLine({ displayGen: 1, scrollPx: 500 * CSS_SCALE, jumpToEnd: false }),
    ).toBe(3);
  });

  test("jumpToEnd lands on the last line", () => {
    const tracker = new ScrollTracker();
    tracker.setFrame(1, META);
    expect(
      tracker.displayedSourceLine({ displayGen: 1, scrollPx: 0, jumpToEnd: true }),
    ).toBe(10);
  });

  test("unknown generation and blank views resolve to null", () => {
    const tracker = new ScrollTracker();
    tracker.setFrame(1, META);
    expect(
      tracker.displayedSourceLine({ displayGen: 2, scrollPx: 0, jumpToEnd: false }),
    ).toBeNull();
    expect(
      tracker.displayedSourceLine({ displayGen: null, scrollPx: 0, jumpToEnd: false }),
    ).toBeNull();
  });

  test("releaseFrame drops the generation", () => {
    const tracker = new ScrollTracker();
    tracker.setFrame(1, META);
    tracker.releaseFrame(1);
    expect(
      tracker.displayedSourceLine({ displayGen: 1, scrollPx: 0, jumpToEnd: false }),
    ).toBeNull();
  });
});
