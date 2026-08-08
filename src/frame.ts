import { deletePlacement, imageId, place } from "./kitty.ts";
import { displayWidth, sanitizeTerminalLine, truncateToDisplayWidth } from "./text.ts";
import { CSS_SCALE, contentRows, maxScrollPx, toImagePx, visibleTiles } from "./viewport.ts";
import type { ViewState } from "./scheduler.ts";

const ESC = "\x1b";
const SYNC_START = `${ESC}[?2026h`;
const SYNC_END = `${ESC}[?2026l`;
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
      out += cursorTo(p.destinationRow + 1, 1);
      out += place({
        id,
        sourceXImagePx: 0,
        sourceYImagePx: toImagePx(p.sourceTopPx, geometry.renderScale),
        sourceWidthImagePx: geometry.imgWidthPx,
        sourceHeightImagePx: toImagePx(p.sourceHeightPx, geometry.renderScale),
        displayColumns: geometry.cols,
        displayRows: p.destinationRows,
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
  const max = shown
    ? maxScrollPx(
        shown.contentHeightPx,
        contentRows(geometry.rows),
        geometry.cellHpx,
        geometry.renderScale,
      )
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
  // Keep capacity out of the transient state chain: it must survive at the end of a truncated document.
  const capacity = geometry.exceedsFrameLimit ? "too wide" : geometry.renderScale < CSS_SCALE ? "low-res" : "";
  const left = [`${sanitizeTerminalLine(filename)}  ${pct}%`, state, capacity].filter(Boolean).join("  ");
  const right = "q:quit";
  const cols = geometry.cols;
  const { text, displayWidth: leftW } = truncateToDisplayWidth(left, cols);
  const rightW = displayWidth(right);
  const line =
    leftW + 1 + rightW <= cols
      ? text + " ".repeat(cols - leftW - rightW) + right
      : text + " ".repeat(cols - leftW);
  return `${ESC}[7m${line}${ESC}[0m`;
}
