// Test helper for winsize.c. Opens a PTY with known dimensions so a unit test can exercise the path
// where TIOCGWINSZ actually returns values (the request constant and the field order).
// Never referenced in production. System headers are avoided for the same reason as in winsize.c
// (so bun:ffi's cc works without the Command Line Tools installed).
int openpty(int *, int *, char *, void *, void *);
int ioctl(int, unsigned long, ...);
int close(int);

/** Open a PTY with the given rows/cols/xpixel/ypixel and return [master, slave] in out. -1 on failure. */
int mdv_test_pty(unsigned short rows, unsigned short cols, unsigned short xp, unsigned short yp,
                 int *out) {
  int m, s;
  if (openpty(&m, &s, 0, 0, 0) != 0) return -1;
  unsigned short ws[4] = {rows, cols, xp, yp};
  if (ioctl(s, 0x80087467UL, ws) != 0) { // TIOCSWINSZ (Darwin)
    close(m);
    close(s);
    return -1;
  }
  out[0] = m;
  out[1] = s;
  return 0;
}
