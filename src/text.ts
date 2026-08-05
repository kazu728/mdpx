export function sanitizeTerminalLine(s: string): string {
  return s.replace(/[\x00-\x1f\x7f]/g, "?");
}

export function sanitizeTerminalBlock(s: string): string {
  return s.replace(/[\x00-\x08\x0b-\x1f\x7f]/g, "?");
}

const graphemes = new Intl.Segmenter(undefined, { granularity: "grapheme" });

export function truncateToDisplayWidth(
  text: string,
  maxDisplayWidth: number,
): { text: string; displayWidth: number } {
  let truncatedText = "";
  let displayWidth = 0;
  for (const { segment } of graphemes.segment(text)) {
    const segmentWidth = Bun.stringWidth(segment);
    if (displayWidth + segmentWidth > maxDisplayWidth) break;
    truncatedText += segment;
    displayWidth += segmentWidth;
  }
  return { text: truncatedText, displayWidth };
}
