import stringWidth from "string-width";
import { deleteAll, deletePlacement, imageId, place } from "./kitty.ts";
import {
  FULL_SCALE,
  contentRows,
  maxScrollPx,
  toImagePx,
  visibleTiles,
  type CellSize,
  type ScreenSize,
} from "./geometry.ts";
import type { ScrollDelta, ViewState } from "./scheduler.ts";

const ESC = "\x1b";
const ALT_ENTER = `${ESC}[?1049h`;
const ALT_EXIT = `${ESC}[?1049l`;
const ALT_SCROLL_ENTER = `${ESC}[?1007h`;
const ALT_SCROLL_EXIT = `${ESC}[?1007l`;
const HIDE_CURSOR = `${ESC}[?25l`;
const SHOW_CURSOR = `${ESC}[?25h`;
// CSI 2J wipes stored kitty images; only safe before the first transfer. Later frames use CSI 0J.
const CLEAR_SCREEN = `${ESC}[2J`;
const SYNC_START = `${ESC}[?2026h`;
const SYNC_END = `${ESC}[?2026l`;
const HOME = `${ESC}[H`;
const ERASE_BELOW = `${ESC}[J`;
const cursorTo = (row: number, col: number) => `${ESC}[${row};${col}H`;
const graphemes = new Intl.Segmenter(undefined, { granularity: "grapheme" });

export type Key = { type: "quit" } | { type: "theme" } | { type: "scroll"; delta: ScrollDelta };

const MAX_CELL_PX = 1000;

const GFX_PROBE_ID = 31;

const KEY_CTRL_C = "\x03";
const KEY_CTRL_D = "\x04";
const KEY_CTRL_U = "\x15";
const OSC_INTRODUCER = 0x5d;
const DCS_INTRODUCER = 0x50;
const APC_INTRODUCER = 0x5f;
const PM_INTRODUCER = 0x5e;
const SOS_INTRODUCER = 0x58;
const KITTY_GRAPHICS_MARKER = 0x47;
const CELL_SIZE_REPORT = 6;
const ESC_BYTE = 0x1b;
const BEL_BYTE = 0x07;
const ST_FINAL_BYTE = 0x5c;
const CSI_INTRODUCER = 0x5b;
const SS3_INTRODUCER = 0x4f;

function validCellDimensionPx(n: number): boolean {
  return Number.isInteger(n) && n > 0 && n <= MAX_CELL_PX;
}

/**
 * An unterminated OSC/DCS/APC would pile up input and kill keys permanently
 * (raw mode swallows even Ctrl-C), so lingerers are dropped and resynced.
 */
const MAX_PENDING_BYTES = 256;
const RESYNC_MS = 200;

function stringTerminatorEnd(buf: Buffer, from: number): number {
  for (let j = from; j < buf.length; j++) {
    if (buf[j] === BEL_BYTE) return j + 1;
    if (buf[j] === ESC_BYTE && buf[j + 1] === ST_FINAL_BYTE) return j + 2;
  }
  return -1;
}

function isFinalByte(b: number): boolean {
  return b >= 0x40 && b <= 0x7e;
}

export function sanitizeTerminalBlock(s: string): string {
  return s.replace(/[\x00-\x08\x0b-\x1f\x7f]/g, "?");
}

function sanitizeTerminalLine(s: string): string {
  return s.replace(/[\x00-\x1f\x7f]/g, "?");
}

export class Term {
  private alt = false;
  private buffer = Buffer.alloc(0);
  private resyncTimer: ReturnType<typeof setTimeout> | null = null;
  private keyHandler: ((k: Key) => void) | null = null;
  private resizeHandler: (() => void) | null = null;
  private reportHandler: ((params: number[]) => void) | null = null;
  private kittyGraphicsReplyHandler: (() => void) | null = null;
  private primaryDaReplyHandler: (() => void) | null = null;

  size(): ScreenSize {
    return { cols: process.stdout.columns, rows: process.stdout.rows };
  }

  write(data: string): void {
    process.stdout.write(data);
  }

  enableInput(): void {
    process.stdin.setRawMode(true);
    process.stdin.resume();
    process.stdin.on("data", (chunk: Buffer) => this.feed(chunk));
    process.stdout.on("resize", () => this.resizeHandler?.());
  }

  onKey(cb: (k: Key) => void): void {
    this.keyHandler = cb;
  }

  onResizeEvent(cb: () => void): void {
    this.resizeHandler = cb;
  }

  queryCellSize(timeoutMs: number): Promise<CellSize | null> {
    return new Promise((resolve) => {
      const finish = (v: CellSize | null) => {
        if (this.reportHandler === handler) this.reportHandler = null;
        clearTimeout(timer);
        resolve(v);
      };
      const handler = (params: number[]) => {
        if (params[0] === CELL_SIZE_REPORT && params.length >= 3) {
          const cellHpx = params[1]!;
          const cellWpx = params[2]!;
          finish(
            validCellDimensionPx(cellHpx) && validCellDimensionPx(cellWpx)
              ? { cellHpx, cellWpx }
              : null,
          );
        }
      };
      const timer = setTimeout(() => finish(null), timeoutMs);
      this.reportHandler = handler;
      this.write(`${ESC}[16t`);
    });
  }

  /**
   * 1x1 query (a=q) reports support without storing; Primary DA is the sync marker.
   */
  queryKittyGraphics(timeoutMs: number): Promise<boolean> {
    return new Promise((resolve) => {
      const finish = (v: boolean) => {
        if (this.kittyGraphicsReplyHandler === onGraphics) this.kittyGraphicsReplyHandler = null;
        if (this.primaryDaReplyHandler === onDa) this.primaryDaReplyHandler = null;
        clearTimeout(timer);
        resolve(v);
      };
      const onGraphics = () => finish(true);
      const onDa = () => finish(false);
      const timer = setTimeout(() => finish(false), timeoutMs);
      this.kittyGraphicsReplyHandler = onGraphics;
      this.primaryDaReplyHandler = onDa;
      this.write(`${ESC}_Gi=${GFX_PROBE_ID},s=1,v=1,a=q,t=d,f=24;AAAA${ESC}\\${ESC}[c`);
    });
  }

  private feed(chunk: Buffer): void {
    this.buffer = Buffer.concat([this.buffer, chunk]);
    let i = 0;
    const buf = this.buffer;
    while (i < buf.length) {
      const b = buf[i]!;
      if (b !== ESC_BYTE) {
        this.handleByte(b);
        i += 1;
        continue;
      }
      if (i + 1 >= buf.length) break;
      const kind = buf[i + 1]!;
      if (kind === CSI_INTRODUCER) {
        // Malformed CSI consumes only ESC so an embedded Ctrl-C can still quit.
        let j = i + 2;
        while (j < buf.length && buf[j]! >= 0x20 && buf[j]! <= 0x3f) j++;
        if (j >= buf.length) break;
        if (!isFinalByte(buf[j]!)) {
          i += 1;
          continue;
        }
        this.handleCsi(buf.toString("latin1", i + 2, j), buf[j]!);
        i = j + 1;
      } else if (kind === SS3_INTRODUCER) {
        if (i + 2 >= buf.length) break;
        if (!isFinalByte(buf[i + 2]!)) {
          i += 1;
          continue;
        }
        this.handleCursorKey(String.fromCharCode(buf[i + 2]!));
        i += 3;
      } else if (
        kind === OSC_INTRODUCER ||
        kind === DCS_INTRODUCER ||
        kind === APC_INTRODUCER ||
        kind === PM_INTRODUCER ||
        kind === SOS_INTRODUCER
      ) {
        const end = stringTerminatorEnd(buf, i + 2);
        if (end === -1) break;
        if (kind === APC_INTRODUCER && buf[i + 2] === KITTY_GRAPHICS_MARKER) {
          this.kittyGraphicsReplyHandler?.();
        }
        i = end;
      } else {
        // A lone ESC consumes one byte so ESC→Space / ESC→arrow keeps its follow-up.
        i += 1;
      }
    }
    this.buffer = buf.subarray(i);
    this.scheduleResync();
  }

  private scheduleResync(): void {
    if (this.resyncTimer) clearTimeout(this.resyncTimer);
    this.resyncTimer = null;
    if (this.buffer.length === 0) return;
    if (this.buffer.length > MAX_PENDING_BYTES) {
      this.buffer = Buffer.alloc(0);
      return;
    }
    this.resyncTimer = setTimeout(() => {
      this.resyncTimer = null;
      this.buffer = Buffer.alloc(0);
    }, RESYNC_MS);
    this.resyncTimer.unref();
  }

  private handleCsi(paramStr: string, final: number): void {
    const ch = String.fromCharCode(final);
    if (ch === "t") {
      const params = paramStr.split(";").map((n) => Number(n));
      this.reportHandler?.(params);
      return;
    }
    if (ch === "c") {
      this.primaryDaReplyHandler?.();
      return;
    }
    this.handleCursorKey(ch);
  }

  private handleCursorKey(final: string): void {
    if (final === "A") this.emit({ type: "scroll", delta: { kind: "lines", n: -1 } });
    else if (final === "B") this.emit({ type: "scroll", delta: { kind: "lines", n: 1 } });
  }

  private handleByte(b: number): void {
    switch (String.fromCharCode(b)) {
      case "q":
      case KEY_CTRL_C:
        this.emit({ type: "quit" });
        break;
      case "t":
        this.emit({ type: "theme" });
        break;
      case " ":
      case KEY_CTRL_D:
        this.emit({ type: "scroll", delta: { kind: "halfpage", dir: 1 } });
        break;
      case KEY_CTRL_U:
        this.emit({ type: "scroll", delta: { kind: "halfpage", dir: -1 } });
        break;
      case "g":
        this.emit({ type: "scroll", delta: { kind: "top" } });
        break;
      case "G":
        this.emit({ type: "scroll", delta: { kind: "bottom" } });
        break;
    }
  }

  private emit(k: Key): void {
    this.keyHandler?.(k);
  }

  enterAltScreen(): void {
    this.alt = true;
    this.write(ALT_ENTER + ALT_SCROLL_ENTER + HIDE_CURSOR + CLEAR_SCREEN);
  }

  // Runs once right before exit and main ignores late events, so listeners stay attached.
  // Pausing still matters: keys typed while Chrome closes are left for the shell.
  restore(): void {
    if (this.alt) this.write(deleteAll() + SHOW_CURSOR + ALT_SCROLL_EXIT + ALT_EXIT);
    process.stdin.setRawMode(false);
    process.stdin.pause();
  }
}

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
  const shown = view.displayGen;
  if (shown) {
    const vis = visibleTiles(view.scrollPx, contentRows(geometry.rows), geometry.cellHpx, shown.tiles);
    for (const p of vis) {
      const id = imageId(shown.gen, p.tileIndex);
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
  out += statusBar(view, filename);
  out += SYNC_END;
  return { escape: out, placements: placed };
}

function statusBar(view: ViewState, filename: string): string {
  const { geometry, scrollPx, phase, pendingScrollPx } = view;
  const shown = view.displayGen;
  const max = shown
    ? maxScrollPx(
        shown.contentHeightPx,
        contentRows(geometry.rows),
        geometry.cellHpx,
        geometry.renderScale,
      )
    : 0;
  const pct = !shown ? "--" : max > 0 ? String(Math.round((scrollPx / max) * 100)) : "100";
  const state = pendingScrollPx !== null
    ? "scrolling…"
    : phase === "rendering"
      ? shown
        ? "updating"
        : "rendering…"
      : view.failure
        ? shown
          ? "update failed"
          : "render failed"
        : shown && shown.truncated && scrollPx >= max
          ? "truncated"
          : "";
  const resolution = geometry.renderScale < FULL_SCALE ? "low-res" : "";
  const left = [`${sanitizeTerminalLine(filename)}  ${pct}%`, state, resolution].filter(Boolean).join("  ");
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
