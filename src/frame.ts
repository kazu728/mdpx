// Frame rendering (§4.5). A pure function composing a ViewState into one frame's escape string.
//
// Following the same principle as kitty.ts, it writes nothing and returns a string (no capture
// needed in tests). It takes the previous frame's placement IDs (prevPlacements) and returns this
// frame's, so the caller carries the cross-frame display state (no state lives in an I/O class).

import { deletePlacement, imageId, place } from "./kitty.ts";
import { sanitizeLine, truncateToWidth } from "./text.ts";
import { CSS_SCALE, contentRows, maxScrollPx, toImagePx, visibleTiles } from "./viewport.ts";
import type { ViewState } from "./scheduler.ts";

const ESC = "\x1b";
const SYNC_START = `${ESC}[?2026h`;
const SYNC_END = `${ESC}[?2026l`;
// A normal frame homes the cursor and erases from there to the end of the screen (CSI 0J =
// eraseDisplay(.below)). Why CSI 2J is unusable: see CLEAR_SCREEN in term.ts.
const HOME = `${ESC}[H`;
const ERASE_BELOW = `${ESC}[J`;
const cursorTo = (row: number, col: number) => `${ESC}[${row};${col}H`;

export function renderFrame(
  view: ViewState,
  filename: string,
  prevPlacements: number[],
): { escape: string; placements: number[] } {
  const { geometry } = view;

  let out = SYNC_START;
  for (const id of prevPlacements) out += deletePlacement(id);
  out += HOME + ERASE_BELOW;

  const placed: number[] = [];
  let pendingVisible = false;
  if (view.displayGen !== null) {
    const vis = visibleTiles(view.scrollPx, contentRows(geometry.rows), geometry.cellHpx, view.tiles);
    for (const p of vis) {
      if (!view.resident.has(p.tileIndex)) {
        pendingVisible = true;
        continue;
      }
      const id = imageId(view.displayGen, p.tileIndex);
      out += cursorTo(p.row + 1, 1);
      // Only srcW is already in image px (the geometry carries the capture width). srcY/srcH come
      // out of the visibility math in screen px, so convert them here
      out += place({
        id,
        srcX: 0,
        srcY: toImagePx(p.srcY, geometry.renderScale),
        srcW: geometry.imgWidthPx,
        srcH: toImagePx(p.srcH, geometry.renderScale),
        cols: geometry.cols,
        rows: p.rows,
      });
      placed.push(id);
    }
  }

  out += cursorTo(geometry.rows, 1);
  out += statusBar(view, filename, pendingVisible);
  out += SYNC_END;
  return { escape: out, placements: placed };
}

function statusBar(view: ViewState, filename: string, pendingVisible: boolean): string {
  const { geometry, scrollPx, phase } = view;
  const shown = view.displayGen !== null ? view : null;
  // Use the same max as clampScroll. Deriving it separately would leave scrollPx short of max when
  // downscaled, so neither "truncated" nor 100% would ever appear
  const max = shown
    ? maxScrollPx(shown.contentHpx, contentRows(geometry.rows), geometry.cellHpx, geometry.renderScale)
    : 0;
  const pct = !shown ? "--" : max > 0 ? String(Math.round((scrollPx / max) * 100)) : "100";
  const state = pendingVisible
    ? "rendering…"
    : phase === "rendering"
      ? shown
        ? "updating"
        : "rendering…"
      : shown && shown.truncated && scrollPx >= max
        ? "truncated"
        : "";
  // The relay state is a standing property, independent of position and time, so it gets its own
  // slot rather than joining the transient states above (§4.8). Folding it into that exclusive chain
  // would make it vanish exactly while sitting at the end of a truncated document
  const relay = geometry.relayOverflow ? "too wide" : geometry.renderScale < CSS_SCALE ? "low-res" : "";
  const left = [`${sanitizeLine(filename)}  ${pct}%`, state, relay].filter(Boolean).join("  ");
  const right = "q:quit";
  // Lay out by display width (full-width = 2). Laying out by UTF-16 length wraps the last row and
  // shifts the whole screen by one line. The width comes from the same accumulator as truncate
  // (measuring separately disagrees on VS16 emoji and makes the padding negative).
  const cols = geometry.cols;
  const { text, width } = truncateToWidth(left, cols);
  const rightW = Bun.stringWidth(right);
  const line =
    width + 1 + rightW <= cols
      ? text + " ".repeat(cols - width - rightW) + right
      : text + " ".repeat(cols - width);
  return `${ESC}[7m${line}${ESC}[0m`;
}
