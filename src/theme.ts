// Theme resolution (§4.2). By default it follows the macOS appearance; MDPX_THEME overrides it
// explicitly. The decision logic (pure) is kept apart from the OS lookup (I/O) so it can be tested.

import { execFileSync } from "node:child_process";

export type Theme = "light" | "dark";

export function pickTheme(override: string | undefined, systemDark: boolean): Theme {
  const o = override?.trim().toLowerCase();
  if (o === "light" || o === "dark") return o;
  return systemDark ? "dark" : "light";
}

/**
 * macOS dark mode check. AppleInterfaceStyle returns "Dark" only in dark mode; in light mode the key
 * is unset and `defaults` exits non-zero (which counts as light).
 */
function systemPrefersDark(): boolean {
  try {
    const out = execFileSync("defaults", ["read", "-g", "AppleInterfaceStyle"], {
      encoding: "utf8",
      stdio: ["ignore", "pipe", "ignore"],
    });
    return out.trim() === "Dark";
  } catch {
    return false;
  }
}

export function resolveTheme(): Theme {
  return pickTheme(process.env.MDPX_THEME, systemPrefersDark());
}
