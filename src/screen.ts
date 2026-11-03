import stringWidth from "string-width";
import { FULL_SCALE, GUTTER_COLS } from "./geometry.ts";
import { deletePlacement, place } from "./kitty.ts";
import { cropOf, visiblePlacements } from "./layout.ts";
import { PAGE_BACKGROUND } from "./theme.ts";
import type { ViewState } from "./scheduler.ts";

const ESC = "\x1b";
const SYNC_START = `${ESC}[?2026h`;
const SYNC_END = `${ESC}[?2026l`;
const HOME = `${ESC}[H`;
// Erasing paints the current background (and, unlike CSI 2J, keeps the stored images).
const ERASE_BELOW = `${ESC}[J`;
const RESET = `${ESC}[0m`;
const cursorTo = (row: number, col: number) => `${ESC}[${row};${col}H`;
const graphemes = new Intl.Segmenter(undefined, { granularity: "grapheme" });

const MARK = "▎";
const MARK_COLOR = "#2f81f7";

export interface PlacementId {
  id: number;
  placementId: number;
}

function background(hex: string): string {
  const n = Number.parseInt(hex.slice(1), 16);
  return `${ESC}[48;2;${(n >> 16) & 0xff};${(n >> 8) & 0xff};${n & 0xff}m`;
}

function foreground(hex: string): string {
  const n = Number.parseInt(hex.slice(1), 16);
  return `${ESC}[38;2;${(n >> 16) & 0xff};${(n >> 8) & 0xff};${n & 0xff}m`;
}

function sanitizeTerminalLine(s: string): string {
  return s.replace(/[\x00-\x1f\x7f]/g, "?");
}

export function renderFrame(
  view: ViewState,
  filename: string,
  prevPlacements: readonly PlacementId[],
): { escape: string; placements: PlacementId[]; content: string } {
  const { geometry, shown } = view;
  let out = HOME;
  if (shown) out += background(PAGE_BACKGROUND[shown.theme]);
  out += ERASE_BELOW + RESET;

  const placements: PlacementId[] = [];
  if (shown) {
    const perImage = new Map<number, number>();
    const marked = new Set<number>();
    for (const p of visiblePlacements(shown, view.top, geometry.viewRows)) {
      const image = view.images.get(p.imageKey);
      if (!image) continue;
      const { id } = image;
      const crop = cropOf(p, image);
      const placementId = (perImage.get(id) ?? 0) + 1;
      perImage.set(id, placementId);
      out += cursorTo(p.screenRow + 1, GUTTER_COLS + 1);
      out += place({
        id,
        placementId,
        sourceXImagePx: 0,
        sourceYImagePx: crop.y,
        sourceWidthImagePx: geometry.imgWidthPx,
        sourceHeightImagePx: crop.h,
        displayColumns: geometry.raster.contentCols,
        displayRows: p.rows,
      });
      placements.push({ id, placementId });
      if (shown.units[p.unit]!.members.some((m) => view.marks.has(m.key))) {
        for (let r = 0; r < p.rows; r++) marked.add(p.screenRow + r);
      }
    }
    if (marked.size) {
      out += background(PAGE_BACKGROUND[shown.theme]) + foreground(MARK_COLOR);
      for (const row of marked) out += cursorTo(row + 1, 1) + MARK;
      out += RESET;
    }
  }

  out += cursorTo(geometry.rows, 1);
  out += statusBar(view, filename);
  const unplace = prevPlacements.map((p) => deletePlacement(p.id, p.placementId)).join("");
  return { escape: SYNC_START + unplace + out + SYNC_END, placements, content: out };
}

function statusText(view: ViewState): string {
  switch (view.status) {
    case "scrolling":
      return "scrolling…";
    case "rendering":
      return "rendering…";
    case "updating":
      return "updating";
    case "idle":
      return "";
    default:
      return view.status;
  }
}

function statusBar(view: ViewState, filename: string): string {
  const { geometry } = view;
  const left = [
    sanitizeTerminalLine(filename),
    view.follow ? "follow" : "",
    statusText(view),
    geometry.raster.renderScale < FULL_SCALE ? "low-res" : "",
  ]
    .filter(Boolean)
    .join("  ");
  const right = "q:quit";
  const cols = geometry.cols;
  const { text, displayWidth: leftW } = truncateToDisplayWidth(left, cols);
  const rightW = stringWidth(right);
  const line =
    leftW + 1 + rightW <= cols
      ? text + " ".repeat(cols - leftW - rightW) + right
      : text + " ".repeat(cols - leftW);
  return `${ESC}[7m${line}${ESC}[0m`;
}

function truncateToDisplayWidth(
  text: string,
  maxDisplayWidth: number,
): { text: string; displayWidth: number } {
  let truncatedText = "";
  let displayWidth = 0;
  for (const { segment } of graphemes.segment(text)) {
    const segmentWidth = stringWidth(segment);
    if (displayWidth + segmentWidth > maxDisplayWidth) break;
    truncatedText += segment;
    displayWidth += segmentWidth;
  }
  return { text: truncatedText, displayWidth };
}
