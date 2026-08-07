// The direction is only mdpx → nvim, so no mutual-trigger suppression is needed.
// The feature is best-effort: failures degrade to a silent no-op and never block rendering or scrolling.

import { spawn } from "node:child_process";
import { readdir } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";

const SCROLL_SETTLE_DEBOUNCE_MS = 100;

const NVIM_ROUND_TRIP_TIMEOUT_MS = 1000;

/** macOS truncates unix socket paths at 104 bytes; reject longer candidates before connecting. */
const SUN_PATH_MAX = 104;

export type JumpResult =
  | "moved"
  | "editing"
  | "buffer-missing"
  | "window-missing"
  | "failed";

export type NvimTarget =
  | { mode: "auto" }
  | { mode: "socket"; path: string }
  | { mode: "off"; warning?: string };

export function socketPathFits(path: string): boolean {
  return Buffer.byteLength(path) < SUN_PATH_MAX;
}

export function parseNvimEnv(value: string | undefined): NvimTarget {
  const v = value?.trim();
  if (!v) return { mode: "auto" };
  if (v === "0" || v === "off") return { mode: "off" };
  if (!socketPathFits(v)) {
    return {
      mode: "off",
      warning: `ignoring MDPX_NVIM (unix socket path is ${SUN_PATH_MAX} bytes or longer): ${v}`,
    };
  }
  return { mode: "socket", path: v };
}

export function socketPid(fileName: string): number | null {
  const m = /^nvim\.(\d+)\.\d+$/.exec(fileName);
  if (!m) return null;
  const pid = Number(m[1]);
  return Number.isSafeInteger(pid) && pid > 0 ? pid : null;
}

const JUMP_CHUNK = [
  "(function(a)",
  "local path, line = a[1], a[2]",
  // vim.uv is the 0.10+ name. The 0.9 line only has vim.loop, and hardcoding one dies with
  // "attempt to index field 'uv'", which degrades into failed (a silent no-op)
  "local uv = vim.uv or vim.loop",
  "local buf = nil",
  "for _, b in ipairs(vim.api.nvim_list_bufs()) do",
  "if vim.api.nvim_buf_is_loaded(b) then",
  "local name = vim.api.nvim_buf_get_name(b)",
  'if name ~= "" and uv.fs_realpath(name) == path then buf = b break end',
  "end end",
  'if not buf then return "buffer-missing" end',
  "local win = nil",
  "for _, w in ipairs(vim.api.nvim_list_wins()) do",
  "if vim.api.nvim_win_get_buf(w) == buf then win = w break end end",
  'if not win then return "window-missing" end',
  'if win == vim.api.nvim_get_current_win() and vim.api.nvim_get_mode().mode ~= "n" then return "editing" end',
  "local n = vim.api.nvim_buf_line_count(buf)",
  "if line < 1 then line = 1 end",
  "if line > n then line = n end",
  "vim.api.nvim_win_call(win, function() vim.fn.winrestview({topline = line, lnum = line, col = 0}) end)",
  'return "moved"',
  "end)(_A)",
].join(" ");

function vimString(s: string): string {
  return `'${s.replaceAll("'", "''")}'`;
}

/** The expression passed to --remote-expr. Path and line go through _A, never mixed into the chunk's syntax. */
export function jumpExpr(mdPath: string, line: number): string {
  const n = Number.isFinite(line) ? Math.max(1, Math.trunc(line)) : 1;
  return `luaeval(${vimString(JUMP_CHUNK)}, [${vimString(mdPath)}, ${n}])`;
}

export function parseJumpResult(stdout: string): JumpResult {
  const s = stdout.trim();
  switch (s) {
    case "moved":
    case "editing":
    case "buffer-missing":
    case "window-missing":
      return s;
    default:
      return "failed";
  }
}

/**
 * Send a cursor move to one nvim session. Spawning the CLI keeps the helper stateless and avoids a
 * msgpack-rpc implementation, dependency, and connection-state management.
 */
export async function sendCursor(
  socket: string,
  mdPath: string,
  line: number,
  signal?: AbortSignal,
): Promise<JumpResult> {
  if (signal?.aborted) return "failed";
  const proc = spawn("nvim", ["--server", socket, "--remote-expr", jumpExpr(mdPath, line)], {
    stdio: ["ignore", "pipe", "ignore"],
  });
  const kill = () => {
    proc.kill();
  };
  const timer = setTimeout(kill, NVIM_ROUND_TRIP_TIMEOUT_MS);
  signal?.addEventListener("abort", kill, { once: true });
  try {
    return await new Promise<JumpResult>((resolve) => {
      let stdout = "";
      proc.stdout!.setEncoding("utf8");
      proc.stdout!.on("data", (chunk: string) => {
        stdout += chunk;
      });
      proc.on("error", () => resolve("failed"));
      proc.on("close", (code) => resolve(code === 0 ? parseJumpResult(stdout) : "failed"));
    });
  } finally {
    clearTimeout(timer);
    signal?.removeEventListener("abort", kill);
  }
}

function socketRoot(): string | null {
  const xdg = process.env.XDG_RUNTIME_DIR;
  if (xdg) return xdg;
  const user = process.env.USER;
  return user ? join(process.env.TMPDIR ?? tmpdir(), `nvim.${user}`) : null;
}

function isProcessAlive(pid: number): boolean {
  try {
    process.kill(pid, 0);
    return true;
  } catch (e) {
    return (e as NodeJS.ErrnoException).code === "EPERM";
  }
}

function pushIfLive(path: string, fileName: string, out: string[]): void {
  const pid = socketPid(fileName);
  if (pid === null || !isProcessAlive(pid) || !socketPathFits(path)) return;
  out.push(path);
}

/**
 * There are two default locations: with XDG_RUNTIME_DIR unset it is
 * `$TMPDIR/nvim.$USER/<random>/nvim.<pid>.0`, and with it set `$XDG_RUNTIME_DIR/nvim.<pid>.0`.
 * Looking at both the root and one level below picks up either layout through the same code path.
 */
export async function listSockets(root: string): Promise<string[]> {
  const found: string[] = [];
  let entries;
  try {
    entries = await readdir(root, { withFileTypes: true });
  } catch {
    return found;
  }
  const subdirs: string[] = [];
  for (const e of entries) {
    if (e.isDirectory()) subdirs.push(e.name);
    else pushIfLive(join(root, e.name), e.name, found);
  }
  for (const dir of subdirs) {
    let names: string[];
    try {
      names = await readdir(join(root, dir));
    } catch {
      continue;
    }
    for (const n of names) pushIfLive(join(root, dir, n), n, found);
  }
  return found.sort();
}

export class NvimCursor {
  private readonly enabled: boolean;
  private readonly forcedSocket: string | null;
  private lastWorkingSocket: string | null = null;
  private timer: ReturnType<typeof setTimeout> | null = null;
  private pending: number | null = null;
  private running = false;
  private readonly aborter = new AbortController();

  constructor(
    private readonly mdPath: string,
    target: NvimTarget,
  ) {
    this.enabled = target.mode !== "off";
    this.forcedSocket = target.mode === "socket" ? target.path : null;
  }

  /**
   * The same line as last time is sent again. The nvim cursor may have moved independently, so
   * skipping equal values would leave positions misaligned when the user scrolls back.
   */
  send(line: number): void {
    if (!this.enabled || this.aborter.signal.aborted) return;
    this.pending = line;
    this.arm();
  }

  private arm(): void {
    if (this.timer) clearTimeout(this.timer);
    this.timer = setTimeout(() => {
      this.timer = null;
      this.pump().catch(() => {});
    }, SCROLL_SETTLE_DEBOUNCE_MS);
  }

  close(): void {
    if (this.timer) clearTimeout(this.timer);
    this.timer = null;
    this.pending = null;
    this.aborter.abort();
  }

  /**
   * It deliberately does not loop and keep sending, because that would bypass the debounce entirely.
   * A line that arrives mid-flight re-arms the timer and waits for the next settle, keeping the send
   * rate bounded by the debounce interval.
   */
  private async pump(): Promise<void> {
    if (this.running || this.pending === null) return;
    this.running = true;
    const line = this.pending;
    this.pending = null;
    try {
      await this.deliver(line);
    } finally {
      this.running = false;
      if (this.pending !== null && !this.timer) this.arm();
    }
  }

  private async deliver(line: number): Promise<void> {
    // Try the cached socket first and rediscover **immediately** if it misses. Waiting for the next
    // settle would drop that line when the user leaves the buffer in nvim and comes back without scrolling
    const cached = this.lastWorkingSocket;
    if (cached && (await this.trySend(cached, line))) return;
    this.lastWorkingSocket = null;
    for (const socket of await this.discover()) {
      if (this.aborter.signal.aborted) return;
      if (socket === cached) continue;
      if (await this.trySend(socket, line)) return;
    }
  }

  /**
   * Send to one session; true if it landed. buffer-missing / window-missing mean that session is simply
   * not the target, so they return false and move to the next candidate (which makes "prefer the
   * session showing it in a window" fall out of the search order).
   */
  private async trySend(socket: string, line: number): Promise<boolean> {
    if (this.aborter.signal.aborted) return true; // give up without trying the remaining candidates
    const result = await sendCursor(socket, this.mdPath, line, this.aborter.signal);
    if (result !== "moved" && result !== "editing") return false;
    this.lastWorkingSocket = socket;
    return true;
  }

  private async discover(): Promise<string[]> {
    if (this.forcedSocket) return [this.forcedSocket];
    const root = socketRoot();
    return root ? listSockets(root) : [];
  }
}
