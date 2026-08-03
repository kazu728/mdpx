// Sending side of nvim cursor following (§4.9). Projects mdpx's scroll position one way onto the
// cursor line of an nvim that has the same file open. An I/O module on par with chrome.ts.
//
// Because the direction is only mdpx → nvim, the mutual-trigger suppression a two-way sync needs
// (crossnote keeps a 500ms suppression window) is structurally unnecessary: no loop exists.
//
// The path goes through neither the terminal nor a pane: mdpx connects straight to the unix socket
// nvim has opened, unconfigured, since startup (v:servername). The only condition for connecting is
// "has the same file open"; pane adjacency is irrelevant. No nvim-side config or plugin is required.
//
// The feature is best-effort and every failure degrades to a silent no-op. It never gets in the way
// of the actual rendering or scrolling (with no target nvim around it simply stays dormant).

import { readdir } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";

/** How long scrolling must settle before a send (key repeat at 30/s must not become a spawn storm). */
const DEBOUNCE_MS = 100;

/** Cap on one round trip. Guards against nvim being fully blocked on a hit-enter prompt or similar. */
const SPAWN_TIMEOUT_MS = 1000;

/**
 * Maximum unix socket path length (sun_path, 104 bytes on macOS). **Anything longer is truncated
 * silently**, so two differently-named sockets can resolve to the same path and connect to the wrong
 * one (reproduced). Drop candidates known not to reach before attempting a connection.
 */
const SUN_PATH_MAX = 104;

export type JumpResult =
  | "ok" // the cursor moved
  | "busy" // the target window is current and not in normal mode (never disturb an edit in progress)
  | "nobuf" // that session does not have this file open
  | "nowin" // the buffer exists but is not in a window (never :edit on our own initiative)
  | "failed"; // unreachable, timed out, or an unexpected reply

/** Result of interpreting MDPX_NVIM (§5). */
export type NvimTarget =
  | { mode: "auto" } // search the default locations
  | { mode: "socket"; path: string } // socket given explicitly
  | { mode: "off"; warning?: string }; // disabled; if warning is set the caller prints a one-line warning

/** Whether the path is short enough to work as a unix socket (§4.9's misconnection guard). */
export function socketPathFits(path: string): boolean {
  return Buffer.byteLength(path) < SUN_PATH_MAX;
}

/**
 * Interpret MDPX_NVIM. `0`/`off` disables it, a path pins that socket, unset means auto-discovery.
 * An over-long path is disabled with a stated reason rather than silently misconnecting (§6).
 */
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

/** Extract the pid from nvim's default socket name `nvim.<pid>.0`. Null if the shape differs. */
export function socketPid(fileName: string): number | null {
  const m = /^nvim\.(\d+)\.\d+$/.exec(fileName);
  if (!m) return null;
  const pid = Number(m[1]);
  return Number.isSafeInteger(pid) && pid > 0 ? pid : null;
}

/**
 * The lua chunk that performs the jump. One round trip covers finding the buffer whose realpath
 * matches, finding the window showing it, the mode guard, clamping the line, and moving the cursor
 * (14–16ms measured).
 *
 * Every string literal uses double quotes. The vimscript wrapping it is a single-quoted string, so
 * mixing them would double up the escaping.
 *
 * Design decisions:
 *  - Do nothing if the buffer is not in a window. Running :edit unasked oversteps
 *  - The mode comparison is exact. A prefix comparison would treat "no" (operator-pending) as
 *    normal and move the cursor in the middle of a `d`
 *  - The line is clamped to the end of the buffer (so an nvim-side edit that shortened it cannot break this)
 *  - No jumplist entry. Pushing one on every scroll would fill the <C-o> history with garbage
 *  - **Set topline as well as the cursor** (winrestview). nvim_win_set_cursor alone does not scroll
 *    at all when the destination is already on screen, and centres it when it is far away (measured:
 *    in a 23-row window the target line landed on screen rows 10, 20, and 12). Where the line shows
 *    up in nvim relative to mdpx's top edge would be undetermined, so hitting the right line number
 *    still would not line the two up visually
 *  - `scrolloff` is not overridden, though. As long as the cursor sits on the target line nvim always
 *    reserves that many rows above it, so `topline = cursor line` is by definition incompatible
 *    (setting it to 0 and restoring it was measured to re-clamp the moment it is restored). Obeying
 *    it instead makes the offset a constant `scrolloff` and stays consistent with the user's nvim config
 */
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
  'if not buf then return "nobuf" end',
  "local win = nil",
  "for _, w in ipairs(vim.api.nvim_list_wins()) do",
  "if vim.api.nvim_win_get_buf(w) == buf then win = w break end end",
  'if not win then return "nowin" end',
  'if win == vim.api.nvim_get_current_win() and vim.api.nvim_get_mode().mode ~= "n" then return "busy" end',
  "local n = vim.api.nvim_buf_line_count(buf)",
  "if line < 1 then line = 1 end",
  "if line > n then line = n end",
  "vim.api.nvim_win_call(win, function() vim.fn.winrestview({topline = line, lnum = line, col = 0}) end)",
  'return "ok"',
  "end)(_A)",
].join(" ");

/** A vimscript single-quoted string literal (inner ' is doubled). */
function vimString(s: string): string {
  return `'${s.replaceAll("'", "''")}'`;
}

/** The expression passed to --remote-expr. Path and line go through _A, never mixed into the chunk's syntax. */
export function jumpExpr(mdPath: string, line: number): string {
  const n = Number.isFinite(line) ? Math.max(1, Math.trunc(line)) : 1;
  return `luaeval(${vimString(JUMP_CHUNK)}, [${vimString(mdPath)}, ${n}])`;
}

/** Standard output of --remote-expr. Anything unexpected collapses to failed. */
export function parseJumpResult(stdout: string): JumpResult {
  const s = stdout.trim();
  return s === "ok" || s === "busy" || s === "nobuf" || s === "nowin" ? s : "failed";
}

/**
 * Send a cursor move to one nvim session. Spawning the CLI each time rather than holding a
 * persistent msgpack-rpc connection: a persistent one would drag in either a hand-rolled msgpack
 * implementation or a dependency, plus restart detection and connection-state management, whereas a
 * spawn is 14–16ms, stateless, and fails visibly — fast enough for a 100ms debounce.
 */
export async function sendCursor(
  socket: string,
  mdPath: string,
  line: number,
  signal?: AbortSignal,
): Promise<JumpResult> {
  // Do not spawn if already aborted (addEventListener never fires on an already-aborted signal)
  if (signal?.aborted) return "failed";
  const spawn = () => {
    try {
      return Bun.spawn(["nvim", "--server", socket, "--remote-expr", jumpExpr(mdPath, line)], {
        stdin: "ignore",
        stdout: "pipe",
        // A dead socket emits E247. That failure is expected, so keep it off the terminal
        stderr: "ignore",
      });
    } catch {
      return null; // nvim is not on PATH
    }
  };
  const proc = spawn();
  if (!proc) return "failed";
  const kill = () => {
    try {
      proc.kill();
    } catch {
      // already exited
    }
  };
  const timer = setTimeout(kill, SPAWN_TIMEOUT_MS);
  signal?.addEventListener("abort", kill, { once: true });
  try {
    const stdout = await new Response(proc.stdout).text();
    return (await proc.exited) === 0 ? parseJumpResult(stdout) : "failed";
  } catch {
    return "failed";
  } finally {
    clearTimeout(timer);
    signal?.removeEventListener("abort", kill);
  }
}

/** Where nvim keeps its sockets: the parent of stdpath("run") (measured). */
function socketRoot(): string | null {
  const xdg = process.env.XDG_RUNTIME_DIR;
  if (xdg) return xdg;
  const user = process.env.USER;
  return user ? join(process.env.TMPDIR ?? tmpdir(), `nvim.${user}`) : null;
}

/** Whether the pid is alive. EPERM (a pid owned by another user) counts as alive. */
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
  // Sockets of dead nvims are never cleaned up and pile up (11 of 14 on this machine were stale).
  // Dropping them on pid liveness first keeps the sweep from spawning uselessly when no target exists
  if (pid === null || !isProcessAlive(pid) || !socketPathFits(path)) return;
  out.push(path);
}

/**
 * Collect live nvim sockets in ascending path order.
 *
 * There are two default locations (measured): with XDG_RUNTIME_DIR unset it is
 * `$TMPDIR/nvim.$USER/<random>/nvim.<pid>.0`, and with it set `$XDG_RUNTIME_DIR/nvim.<pid>.0`.
 * Looking at both the root and one level below picks up either layout through the same code path.
 */
export async function listSockets(root: string): Promise<string[]> {
  const found: string[] = [];
  let entries;
  try {
    entries = await readdir(root, { withFileTypes: true });
  } catch {
    return found; // nvim has never been started
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
  // The root and the subdirectories are walked separately, so sort once at the end (sorting per
  // level would always put the root's entries first and break ascending path order)
  return found.sort();
}

/**
 * Projection of the scroll position onto nvim (§4.9). Owns the debounce, the in-flight bookkeeping,
 * and the discovery and caching of the target socket. What triggers a send is the caller's call
 * (key-driven scrolls only).
 */
export class NvimCursor {
  private readonly enabled: boolean;
  /** Socket pinned by MDPX_NVIM. Null means search the default locations. */
  private readonly forced: string | null;
  /** Socket that last accepted a send. On failure it is dropped and rediscovered at the next settle. */
  private socket: string | null = null;
  private timer: ReturnType<typeof setTimeout> | null = null;
  private pending: number | null = null;
  private running = false;
  private readonly aborter = new AbortController();

  constructor(
    private readonly mdPath: string,
    target: NvimTarget,
  ) {
    this.enabled = target.mode !== "off";
    this.forced = target.mode === "socket" ? target.path : null;
  }

  /**
   * Queue a new line. The actual send happens after the debounce, once nothing is in flight.
   *
   * The same line as last time is sent again. "We put it there, so it is still there" is not a fact
   * about nvim's state — it becomes a lie the moment the user moves the cursor in nvim. Skipping
   * equal values would create positions that never line up again no matter how often you scroll back
   * to them, and all it saves is one spawn per settle (14–16ms measured).
   */
  send(line: number): void {
    if (!this.enabled || this.aborter.signal.aborted) return;
    this.pending = line;
    this.arm();
  }

  /** Re-arm the debounce timer. This is the only place a send originates. */
  private arm(): void {
    if (this.timer) clearTimeout(this.timer);
    this.timer = setTimeout(() => {
      this.timer = null;
      // A best-effort helper must not take the main program down, so stop unexpected throws here
      // (an unhandled rejection goes straight to main's shutdown(1))
      this.pump().catch(() => {});
    }, DEBOUNCE_MS);
  }

  /**
   * Shutdown. Drops the queued line and kills the running child process.
   * Every later `send` is ignored outright (no re-armed timer keeping the event loop alive).
   */
  close(): void {
    if (this.timer) clearTimeout(this.timer);
    this.timer = null;
    this.pending = null;
    this.aborter.abort();
  }

  /**
   * One line per firing, with at most one send in flight.
   *
   * It deliberately does not loop and keep sending, because that would bypass the debounce entirely.
   * Consuming a line that arrived mid-flight on the spot would start the next send as soon as one
   * finishes, firing at the round-trip interval for the whole key repeat (80 spawns/second measured).
   * A line that arrives mid-flight re-arms the timer and waits for the next settle — the added
   * latency is one debounce, and the send rate tops out at once per 100 ms.
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
      // A line that arrived mid-flight is not dropped, but it goes through the debounce again
      if (this.pending !== null && !this.timer) this.arm();
    }
  }

  private async deliver(line: number): Promise<void> {
    // Try the cached socket first and rediscover **immediately** if it misses. Waiting for the next
    // settle would drop that line when the user leaves the buffer in nvim and comes back without scrolling
    const cached = this.socket;
    if (cached && (await this.trySend(cached, line))) return;
    this.socket = null;
    for (const socket of await this.discover()) {
      if (this.aborter.signal.aborted) return;
      if (socket === cached) continue; // it just missed
      if (await this.trySend(socket, line)) return;
    }
    // No target around (nvim was closed, moved to another file, or never had it open). Stay dormant
  }

  /**
   * Send to one session; true if it landed. nobuf / nowin are no-ops meaning that session is simply
   * not the target, so they return false and move to the next candidate (which makes "prefer the
   * session showing it in a window" fall out of the search order).
   */
  private async trySend(socket: string, line: number): Promise<boolean> {
    if (this.aborter.signal.aborted) return true; // give up without trying the remaining candidates
    const result = await sendCursor(socket, this.mdPath, line, this.aborter.signal);
    if (result !== "ok" && result !== "busy") return false;
    this.socket = socket;
    return true;
  }

  private async discover(): Promise<string[]> {
    if (this.forced) return [this.forced];
    const root = socketRoot();
    return root ? listSockets(root) : [];
  }
}
