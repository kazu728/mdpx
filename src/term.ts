// Terminal control (§4.5–4.7): raw mode, alt-screen, the CSI 16t query, key input, screen modes.
//
// stdin carries 16t replies interleaved with key input, so this owns a small parser that cuts out
// escape sequences. Composing one frame's escape string lives in frame.ts (a pure function); this
// module only writes.

import { cc, ptr } from "bun:ffi";
import { fileURLToPath } from "node:url";
import { deleteAll } from "./kitty.ts";
import { CSS_SCALE, contentRows, scrollUnitPx, tileHeightPx, toImagePx } from "./viewport.ts";
import { inHerdrPane, maxResidentTiles, pickRenderScale, visibleTileCount } from "./herdr.ts";
import type { Geometry, ScrollDelta } from "./scheduler.ts";

const ESC = "\x1b";
const ALT_ENTER = `${ESC}[?1049h`;
const ALT_EXIT = `${ESC}[?1049l`;
const HIDE_CURSOR = `${ESC}[?25l`;
const SHOW_CURSOR = `${ESC}[?25h`;
// The canonical note on the CSI 2J trap (paired with SPEC §2's table of established facts). Ghostty
// 1.3.1 handles CSI 2J as eraseDisplay(.complete) and wipes every stored kitty image at once (the
// cause of "ENOENT: image not found"). It is only usable on entering alt-screen, before anything has
// been transferred; normal frames after a transfer erase with CSI 0J (frame.ts).
const CLEAR_SCREEN = `${ESC}[2J`;

export type Key = { type: "quit" } | { type: "scroll"; delta: ScrollDelta };

export interface CellSize {
  cellHpx: number;
  cellWpx: number;
}

/** Sane upper bound on cell px. Keeps a mis-parsed huge value from breaking the geometry math (zero tile height, infinite loop). */
const MAX_CELL_PX = 1000;

/** Image id for the kitty graphics capability query (§4.7). A fixed value that cannot collide with the real gen*1024+tile (≥1024). */
const GFX_PROBE_ID = 31;

// Even on terminals that never answer 16t, the cell size can be read via TIOCGWINSZ as long as the
// PTY carries the window's pixel dimensions (ws_xpixel/ypixel) — §4.7's 16t fallback (herdr does not
// relay 16t but does carry these).
// ioctl is variadic and cannot be called from bun:ffi directly (see the note in winsize.c), so a
// fixed-arity C wrapper is compiled with the TinyCC bundled with Bun and called instead. The compile
// happens once; on failure it stays null and the caller treats the cell size as unavailable (macOS
// only — SPEC §0).
function openWinsize() {
  if (process.platform !== "darwin") return null;
  try {
    return cc({
      // URL.pathname returns spaces and non-ASCII still percent-encoded, and tcc then fails with
      // "file not found" (breaking startup under "~/my apps/" or with a non-ASCII user name).
      source: fileURLToPath(new URL("./winsize.c", import.meta.url)),
      symbols: { mdv_winsize: { args: ["int", "ptr"], returns: "int" } },
    }).symbols;
  } catch {
    return null;
  }
}
let winsizeSyms: ReturnType<typeof openWinsize> | undefined;

/** Whether a cell px value is usable by the geometry math. Every path — 16t reply, TIOCGWINSZ, MDV_CELL — goes through this. */
function withinCellBounds(n: number): boolean {
  return Number.isFinite(n) && n > 0 && n <= MAX_CELL_PX;
}

/**
 * Parse MDV_CELL=<heightPx>,<widthPx> (an `x` separator also works). The escape hatch for setting
 * the cell size by hand on terminals that never answer CSI 16t (some multiplexers, which do not
 * report pixels either). Malformed, out of range, or unset all yield null.
 */
export function parseCellSize(value: string | undefined): CellSize | null {
  const m = value?.trim().match(/^(\d+)[,x](\d+)$/);
  if (!m) return null;
  const cellHpx = Number(m[1]);
  const cellWpx = Number(m[2]);
  return withinCellBounds(cellHpx) && withinCellBounds(cellWpx) ? { cellHpx, cellWpx } : null;
}

/**
 * Read the cell px from TIOCGWINSZ on the terminal behind fd (§4.7's 16t fallback).
 * A terminal without pixel dimensions, a non-TTY fd, an unsupported OS, and a failed FFI init all
 * yield null.
 */
export function winsizeCell(fd: number): CellSize | null {
  if (winsizeSyms === undefined) winsizeSyms = openWinsize();
  if (!winsizeSyms) return null;
  const ws = new Uint16Array(4); // ws_row, ws_col, ws_xpixel, ws_ypixel
  if (winsizeSyms.mdv_winsize(fd, ptr(ws)) !== 0) return null;
  return cellFromWinsize(ws[0]!, ws[1]!, ws[2]!, ws[3]!);
}

/**
 * Derive the cell px from TIOCGWINSZ's rows/cols and xpixel/ypixel (the fallback for terminals
 * without 16t). Terminals with no pixel dimensions (they report 0) and garbled out-of-range values
 * yield null.
 */
export function cellFromWinsize(
  rows: number,
  cols: number,
  xpixel: number,
  ypixel: number,
): CellSize | null {
  if (rows <= 0 || cols <= 0 || xpixel <= 0 || ypixel <= 0) return null;
  const cellHpx = Math.round(ypixel / rows);
  const cellWpx = Math.round(xpixel / cols);
  return withinCellBounds(cellHpx) && withinCellBounds(cellWpx) ? { cellHpx, cellWpx } : null;
}

/**
 * Limits on how long an unfinished sequence may sit around (bytes / ms). Waiting forever on an
 * OSC/DCS/APC whose ST/BEL never comes (pasting text that contains an ESC, say) would pile every
 * later input into the buffer and kill key input permanently — in raw mode even Ctrl-C is just byte
 * 0x03, so the parser swallows it and nothing but a kill from another terminal can exit.
 * Terminal replies (DA, 16t, kitty graphics) are all small and immediate, so anything lingering past
 * these limits is dropped and the parser resynchronizes.
 */
const MAX_PENDING_BYTES = 256;
const RESYNC_MS = 200;

/** Index just past an ST (ESC \) or BEL. -1 when the buffer holds no terminator yet (wait for more). */
function stringTerminatorEnd(buf: Buffer, from: number): number {
  for (let j = from; j < buf.length; j++) {
    if (buf[j] === 0x07) return j + 1;
    if (buf[j] === 0x1b && buf[j + 1] === 0x5c) return j + 2;
  }
  return -1;
}

/** Whether this is a CSI / SS3 final byte (0x40–0x7e). */
function isFinalByte(b: number): boolean {
  return b >= 0x40 && b <= 0x7e;
}

export class Term {
  private raw = false;
  private alt = false;
  private buffer = Buffer.alloc(0);
  private resyncTimer: ReturnType<typeof setTimeout> | null = null;
  private keyHandler: ((k: Key) => void) | null = null;
  private resizeHandler: (() => void) | null = null;
  private reportHandler: ((params: number[]) => void) | null = null;
  private graphicsHandler: (() => void) | null = null; // kitty graphics reply (ESC _ G …)
  private daHandler: (() => void) | null = null; // Primary DA reply (sync marker for the graphics query)
  private readonly onData = (chunk: Buffer) => this.feed(chunk);
  private readonly onResize = () => this.resizeHandler?.();

  private get out(): NodeJS.WriteStream {
    return process.stdout;
  }

  write(data: string): void {
    this.out.write(data);
  }

  // --- Input ------------------------------------------------------------------

  /** Enter raw mode and start consuming key input. Assumes stdin is a TTY (§4.7's gate). */
  enableInput(): void {
    process.stdin.setRawMode(true);
    this.raw = true;
    process.stdin.resume();
    process.stdin.on("data", this.onData);
    this.out.on("resize", this.onResize);
  }

  onKey(cb: (k: Key) => void): void {
    this.keyHandler = cb;
  }

  onResizeEvent(cb: () => void): void {
    this.resizeHandler = cb;
  }

  /** Query the cell px with CSI 16t. Null if no reply arrives within the timeout (§4.7's unsupported verdict). */
  queryCellSize(timeoutMs: number): Promise<CellSize | null> {
    return new Promise((resolve) => {
      const finish = (v: CellSize | null) => {
        // Remove only our own handler (a concurrent query from a rapid resize must not be caught up in it)
        if (this.reportHandler === handler) this.reportHandler = null;
        clearTimeout(timer);
        resolve(v);
      };
      // ESC[6;<height>;<width>t → cellHpx, cellWpx
      const handler = (params: number[]) => {
        if (params[0] === 6 && params.length >= 3) {
          const cellHpx = params[1]!;
          const cellWpx = params[2]!;
          // A garbled huge cell (cellHpx > 2048, say) breaks capturing via a zero tile height. Treat
          // out-of-range as no reply.
          finish(withinCellBounds(cellHpx) && withinCellBounds(cellWpx) ? { cellHpx, cellWpx } : null);
        }
      };
      const timer = setTimeout(() => finish(null), timeoutMs);
      this.reportHandler = handler;
      this.write(`${ESC}[16t`);
    });
  }

  /**
   * Query kitty graphics support (§4.7's capability gate). Sends a 1x1 graphics query (`a=q` neither
   * stores nor displays anything; it only reports support) followed immediately by a Primary DA
   * (ESC[c) as a sync marker. A supporting terminal returns the `_G` reply before the DA; a
   * non-supporting one ignores the unknown APC and returns only the DA. If neither arrives, the
   * timeout counts as unsupported.
   */
  queryKittyGraphics(timeoutMs: number): Promise<boolean> {
    return new Promise((resolve) => {
      let settled = false;
      const finish = (v: boolean) => {
        if (settled) return;
        settled = true;
        // Remove only our own handlers (a concurrent query must not be caught up in it)
        if (this.graphicsHandler === onGraphics) this.graphicsHandler = null;
        if (this.daHandler === onDa) this.daHandler = null;
        clearTimeout(timer);
        resolve(v);
      };
      const onGraphics = () => finish(true); // the `_G` reply came first = supported
      const onDa = () => finish(false); // the DA came first (no `_G`) = unsupported
      const timer = setTimeout(() => finish(false), timeoutMs);
      this.graphicsHandler = onGraphics;
      this.daHandler = onDa;
      this.write(`${ESC}_Gi=${GFX_PROBE_ID},s=1,v=1,a=q,t=d,f=24;AAAA${ESC}\\${ESC}[c`);
    });
  }

  /**
   * Compute the output terminal's cell px from TIOCGWINSZ (§4.7's 16t fallback).
   * Works unconfigured even on terminals that never answer 16t, as long as the PTY carries the
   * window's pixel dimensions. A synchronous ioctl.
   */
  queryWinsizeCell(): CellSize | null {
    return winsizeCell(process.stdout.fd);
  }

  private feed(chunk: Buffer): void {
    this.buffer = Buffer.concat([this.buffer, chunk]);
    let i = 0;
    const buf = this.buffer;
    while (i < buf.length) {
      const b = buf[i]!;
      if (b !== 0x1b) {
        this.handleByte(b);
        i += 1;
        continue;
      }
      if (i + 1 >= buf.length) break; // incomplete; wait for the next chunk
      const kind = buf[i + 1]!;
      if (kind === 0x5b) {
        // CSI: parameter and intermediate bytes (0x20–0x3f) followed by a final byte (0x40–0x7e).
        // Anything with an out-of-range byte (a C0 control) is a malformed sequence, so consume only
        // the ESC and re-read. Skipping every byte to the terminator would eat a Ctrl-C (0x03) in the
        // middle and make it impossible to exit.
        let j = i + 2;
        while (j < buf.length && buf[j]! >= 0x20 && buf[j]! <= 0x3f) j++;
        if (j >= buf.length) break; // incomplete
        if (!isFinalByte(buf[j]!)) {
          i += 1;
          continue;
        }
        this.handleCsi(buf.toString("latin1", i + 2, j), buf[j]!);
        i = j + 1;
      } else if (kind === 0x4f) {
        // SS3 (ESC O <final>): application cursor keys. Only the arrows are picked up.
        if (i + 2 >= buf.length) break; // incomplete
        if (!isFinalByte(buf[i + 2]!)) {
          i += 1;
          continue;
        }
        this.handleSs3(buf[i + 2]!);
        i += 3;
      } else if (
        kind === 0x5d || // OSC
        kind === 0x50 || // DCS
        kind === 0x5f || // APC (where the kitty graphics reply arrives)
        kind === 0x5e || // PM
        kind === 0x58 // SOS
      ) {
        // String-type sequences are read whole, up to an ST (ESC \) or BEL. Dropping only the single
        // ESC byte would let the payload misfire as key input. The kitty graphics reply (ESC _ G …)
        // is used solely for §4.7's capability query; everything else (transfer error replies and so
        // on) is discarded — transfers are fire-and-forget with no success tracking (§4.4, and the
        // note in main.ts runShoot).
        const end = stringTerminatorEnd(buf, i + 2);
        if (end === -1) break; // incomplete
        if (kind === 0x5f && buf[i + 2] === 0x47) this.graphicsHandler?.(); // "_G" = graphics reply
        i = end;
      } else {
        // A lone ESC (what follows is separate key input). Consume only the ESC so the next byte is
        // not lost. Consuming two here would swallow the follow-up of ESC→j or ESC→arrow (ESC[B).
        i += 1;
      }
    }
    this.buffer = buf.subarray(i);
    this.scheduleResync();
  }

  /**
   * Drop a buffer left unfinished and resynchronize the parser (immediately past the size limit,
   * otherwise after RESYNC_MS of silence). Keeps a sequence whose terminator never arrives from
   * blocking key input indefinitely.
   */
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
    this.resyncTimer.unref(); // a pending resync must not hold the process open
  }

  private handleCsi(paramStr: string, final: number): void {
    const ch = String.fromCharCode(final);
    if (ch === "t") {
      const params = paramStr.split(";").map((n) => Number(n));
      this.reportHandler?.(params);
      return;
    }
    if (ch === "c") {
      this.daHandler?.(); // Primary DA reply (sync marker for the graphics query — §4.7)
      return;
    }
    if (ch === "A") this.emit({ type: "scroll", delta: { kind: "lines", n: -1 } });
    else if (ch === "B") this.emit({ type: "scroll", delta: { kind: "lines", n: 1 } });
    // C/D (left/right) and everything else are ignored
  }

  /** SS3 (ESC O <final>) arrows: ↑/↓ in application cursor key mode. */
  private handleSs3(final: number): void {
    if (final === 0x41) this.emit({ type: "scroll", delta: { kind: "lines", n: -1 } }); // ↑
    else if (final === 0x42) this.emit({ type: "scroll", delta: { kind: "lines", n: 1 } }); // ↓
  }

  private handleByte(b: number): void {
    switch (b) {
      case 0x71: // q
      case 0x03: // ctrl-c
        this.emit({ type: "quit" });
        break;
      case 0x6a: // j
        this.emit({ type: "scroll", delta: { kind: "lines", n: 1 } });
        break;
      case 0x6b: // k
        this.emit({ type: "scroll", delta: { kind: "lines", n: -1 } });
        break;
      case 0x20: // space
      case 0x04: // ctrl-d
        this.emit({ type: "scroll", delta: { kind: "halfpage", dir: 1 } });
        break;
      case 0x15: // ctrl-u
        this.emit({ type: "scroll", delta: { kind: "halfpage", dir: -1 } });
        break;
      case 0x67: // g
        this.emit({ type: "scroll", delta: { kind: "top" } });
        break;
      case 0x47: // G
        this.emit({ type: "scroll", delta: { kind: "bottom" } });
        break;
    }
  }

  private emit(k: Key): void {
    this.keyHandler?.(k);
  }

  // --- Geometry ---------------------------------------------------------------

  /**
   * Build a Geometry from the terminal size and the cell px. The image is laid out to exactly the
   * terminal's cols columns. Inside a herdr pane, a geometry whose 1:1 capture would not fit the
   * relay limit drops the capture resolution to half (§4.8).
   */
  geometry(cell: CellSize, relayed: boolean = inHerdrPane()): Geometry {
    const cols = this.out.columns;
    const rows = this.out.rows;
    const screenWidthPx = cols * cell.cellWpx;
    const cssWidth = Math.round(screenWidthPx / CSS_SCALE);
    const viewportHpx = contentRows(rows) * cell.cellHpx;
    const tileHpx = tileHeightPx(cell.cellHpx, contentRows(rows));
    const { renderScale, relayOverflow } = pickRenderScale({
      cssWidth,
      tileHpx,
      viewportHpx,
      reducedScrollUnitPx: scrollUnitPx(cell.cellHpx, 1),
      fullScale: CSS_SCALE,
      relayed,
    });
    // Image px corresponding to cols columns. At 1:1 the real image (cssWidth × 2) can be 1px wider,
    // and that 1px is cropped — sharper than resampling the whole thing. When downscaled it matches
    // the real image width exactly
    const imgWidthPx = toImagePx(screenWidthPx, renderScale);
    // The terminal holds images as decoded pixels, so the amount held follows the area, not the PNG size
    const tileBytes = imgWidthPx * toImagePx(tileHpx, renderScale) * 4;
    return {
      rows,
      cols,
      cellHpx: cell.cellHpx,
      imgWidthPx,
      cssWidth,
      renderScale,
      relayOverflow,
      maxResident: maxResidentTiles(tileBytes, relayed, visibleTileCount(viewportHpx, tileHpx)),
    };
  }

  // --- Screen -----------------------------------------------------------------

  enterAltScreen(): void {
    this.alt = true;
    // Nothing has been transferred yet, so a full clear (CSI 2J) is safe here.
    this.write(ALT_ENTER + HIDE_CURSOR + CLEAR_SCREEN);
  }

  // --- Restore ----------------------------------------------------------------

  restore(): void {
    if (this.alt) {
      this.write(deleteAll() + SHOW_CURSOR + ALT_EXIT);
      this.alt = false;
    }
    if (this.resyncTimer) clearTimeout(this.resyncTimer);
    this.resyncTimer = null;
    process.stdin.off("data", this.onData);
    this.out.off("resize", this.onResize);
    if (this.raw) process.stdin.setRawMode(false);
    this.raw = false;
    process.stdin.pause();
  }
}
