int openpty(int *, int *, char *, void *, void *);
int ioctl(int, unsigned long, ...);
int close(int);

#define TIOCSWINSZ_DARWIN 0x80087467UL

int mdpx_test_pty(unsigned short rows, unsigned short cols, unsigned short xp, unsigned short yp,
                 int *out) {
  int m, s;
  if (openpty(&m, &s, 0, 0, 0) != 0) return -1;
  unsigned short ws[4] = {rows, cols, xp, yp};
  if (ioctl(s, TIOCSWINSZ_DARWIN, ws) != 0) {
    close(m);
    close(s);
    return -1;
  }
  out[0] = m;
  out[1] = s;
  return 0;
}
