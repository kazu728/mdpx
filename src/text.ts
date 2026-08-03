// Preprocessing for strings written to the terminal. Neutralizing control bytes and measuring
// display width both live here (the status bar in frame.ts and the early errors in main.ts use the
// same rules). Pure functions only.

/** Neutralize every terminal control byte (C0 and DEL). For single-line display (guards against escape injection through a file name). */
export function sanitizeLine(s: string): string {
  return s.replace(/[\x00-\x1f\x7f]/g, "?");
}

/** Neutralize control bytes except newline and tab. For multi-line error output (keeps a stack readable). */
export function sanitizeBlock(s: string): string {
  return s.replace(/[\x00-\x08\x0b-\x1f\x7f]/g, "?");
}

// Width is measured per grapheme cluster. Stepping per code point separates VS16 (U+FE0F) from its
// base and splits `❤️` into widths 1 and 2 (`Bun.stringWidth` returns 2 for the whole string).
const graphemes = new Intl.Segmenter(undefined, { granularity: "grapheme" });

/**
 * The longest prefix whose display width does not exceed max, plus that width (full-width, EAW=Wide,
 * and emoji count as 2). The width comes from the same accumulator as the truncation, so the caller's
 * padding math always stays within max.
 * The width itself is delegated to Bun.stringWidth (a hand-rolled range table misses EAW=Wide symbols).
 */
export function truncateToWidth(s: string, max: number): { text: string; width: number } {
  let text = "";
  let width = 0;
  for (const { segment } of graphemes.segment(s)) {
    const w = Bun.stringWidth(segment);
    if (width + w > max) break;
    text += segment;
    width += w;
  }
  return { text, width };
}
