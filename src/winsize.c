// Read the PTY's window dimensions (cells plus pixels) via TIOCGWINSZ (§4.7's 16t fallback).
//
// ioctl is variadic (int, unsigned long, ...), and on the arm64 ABI the variadic part is passed on
// the stack. bun:ffi passes fixed arguments in registers, so declaring and calling it directly never
// delivers the third argument, producing the silent failure "rc=0 yet every field is 0" (measured).
// A fixed-arity C wrapper leaves the variadic call to the compiler.
//
// No system headers are used, so bun:ffi's cc works even without the Command Line Tools installed.
// struct winsize is four unsigned shorts (ws_row, ws_col, ws_xpixel, ws_ypixel).
int ioctl(int, unsigned long, ...);

int mdv_winsize(int fd, unsigned short *out) {
  unsigned short ws[4] = {0, 0, 0, 0};
  if (ioctl(fd, 0x40087468UL, ws) != 0) return -1; // TIOCGWINSZ (Darwin)
  out[0] = ws[0];
  out[1] = ws[1];
  out[2] = ws[2];
  out[3] = ws[3];
  return 0;
}
