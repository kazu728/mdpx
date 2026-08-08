import { deleteAll } from "./kitty.ts";
import type { CellSize, ScreenSize } from "./geometry.ts";
import type { ScrollDelta } from "./scheduler.ts";

const ESC = "\x1b";
const ALT_ENTER = `${ESC}[?1049h`;
const ALT_EXIT = `${ESC}[?1049l`;
const HIDE_CURSOR = `${ESC}[?25l`;
const SHOW_CURSOR = `${ESC}[?25h`;
// CSI 2J can wipe every stored kitty image, so it is only safe before the first transfer — entering
// alt-screen. Later frames erase with CSI 0J (frame.ts).
const CLEAR_SCREEN = `${ESC}[2J`;

export type Key = { type: "quit" } | { type: "theme" } | { type: "scroll"; delta: ScrollDelta };

const MAX_CELL_PX = 1000;

// The probe ID is below every generation-scoped image ID, so it cannot collide with a real tile.
const GFX_PROBE_ID = 31;

const KEY_Q = "q".charCodeAt(0);
const KEY_J = "j".charCodeAt(0);
const KEY_K = "k".charCodeAt(0);
const KEY_G = "g".charCodeAt(0);
const KEY_SHIFT_G = "G".charCodeAt(0);
const KEY_T = "t".charCodeAt(0);
const KEY_SPACE = " ".charCodeAt(0);
const KEY_CTRL_C = 0x03;
const KEY_CTRL_D = 0x04;
const KEY_CTRL_U = 0x15;
const CURSOR_UP_FINAL = 0x41;
const CURSOR_DOWN_FINAL = 0x42;
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
  return Number.isFinite(n) && n > 0 && n <= MAX_CELL_PX;
}

export function parseCellSize(value: string | undefined): CellSize | null {
  const m = value?.trim().match(/^(\d+)[,x](\d+)$/);
  if (!m) return null;
  const cellHpx = Number(m[1]);
  const cellWpx = Number(m[2]);
  return validCellDimensionPx(cellHpx) && validCellDimensionPx(cellWpx)
    ? { cellHpx, cellWpx }
    : null;
}

/**
 * Waiting forever on an OSC/DCS/APC whose ST/BEL never comes would pile every
 * later input into the buffer and kill key input permanently — in raw mode even Ctrl-C is just byte
 * 0x03, so the parser swallows it and nothing but a kill from another terminal can exit.
 * Terminal replies (DA, 16t, kitty graphics) are all small and immediate, so anything lingering past
 * these limits is dropped and the parser resynchronizes.
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

export class Term {
  private raw = false;
  private alt = false;
  private buffer = Buffer.alloc(0);
  private resyncTimer: ReturnType<typeof setTimeout> | null = null;
  private keyHandler: ((k: Key) => void) | null = null;
  private resizeHandler: (() => void) | null = null;
  private reportHandler: ((params: number[]) => void) | null = null;
  private kittyGraphicsReplyHandler: (() => void) | null = null;
  private primaryDaReplyHandler: (() => void) | null = null;
  private readonly onData = (chunk: Buffer) => this.feed(chunk);
  private readonly onResize = () => this.resizeHandler?.();

  private get out(): NodeJS.WriteStream {
    return process.stdout;
  }

  size(): ScreenSize {
    return { cols: this.out.columns, rows: this.out.rows };
  }

  write(data: string): void {
    this.out.write(data);
  }

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
   * Query kitty graphics support. Sends a 1x1 graphics query (`a=q` neither
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
        // CSI: parameter and intermediate bytes (0x20–0x3f) followed by a final byte (0x40–0x7e).
        // Anything with an out-of-range byte (a C0 control) is a malformed sequence, so consume only
        // the ESC and re-read. Skipping every byte to the terminator would eat a Ctrl-C (0x03) in the
        // middle and make it impossible to exit.
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
        this.handleSs3(buf[i + 2]!);
        i += 3;
      } else if (
        kind === OSC_INTRODUCER ||
        kind === DCS_INTRODUCER ||
        kind === APC_INTRODUCER ||
        kind === PM_INTRODUCER ||
        kind === SOS_INTRODUCER
      ) {
        // String-type sequences are read whole, up to an ST (ESC \) or BEL. Dropping only the single
        // ESC byte would let the payload misfire as key input. The kitty graphics reply (ESC _ G …)
        // is used solely for the capability query; other replies are discarded.
        const end = stringTerminatorEnd(buf, i + 2);
        if (end === -1) break;
        if (kind === APC_INTRODUCER && buf[i + 2] === KITTY_GRAPHICS_MARKER) {
          this.kittyGraphicsReplyHandler?.();
        }
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
    if (ch === "A") this.emit({ type: "scroll", delta: { kind: "lines", n: -1 } });
    else if (ch === "B") this.emit({ type: "scroll", delta: { kind: "lines", n: 1 } });
  }

  private handleSs3(final: number): void {
    if (final === CURSOR_UP_FINAL) this.emit({ type: "scroll", delta: { kind: "lines", n: -1 } });
    else if (final === CURSOR_DOWN_FINAL) {
      this.emit({ type: "scroll", delta: { kind: "lines", n: 1 } });
    }
  }

  private handleByte(b: number): void {
    switch (b) {
      case KEY_Q:
      case KEY_CTRL_C:
        this.emit({ type: "quit" });
        break;
      case KEY_T:
        this.emit({ type: "theme" });
        break;
      case KEY_J:
        this.emit({ type: "scroll", delta: { kind: "lines", n: 1 } });
        break;
      case KEY_K:
        this.emit({ type: "scroll", delta: { kind: "lines", n: -1 } });
        break;
      case KEY_SPACE:
      case KEY_CTRL_D:
        this.emit({ type: "scroll", delta: { kind: "halfpage", dir: 1 } });
        break;
      case KEY_CTRL_U:
        this.emit({ type: "scroll", delta: { kind: "halfpage", dir: -1 } });
        break;
      case KEY_G:
        this.emit({ type: "scroll", delta: { kind: "top" } });
        break;
      case KEY_SHIFT_G:
        this.emit({ type: "scroll", delta: { kind: "bottom" } });
        break;
    }
  }

  private emit(k: Key): void {
    this.keyHandler?.(k);
  }

  enterAltScreen(): void {
    this.alt = true;
    this.write(ALT_ENTER + HIDE_CURSOR + CLEAR_SCREEN);
  }

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
