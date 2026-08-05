import { execFileSync } from "node:child_process";

export type Theme = "light" | "dark";

export function pickTheme(override: string | undefined, systemDark: boolean): Theme {
  const o = override?.trim().toLowerCase();
  if (o === "light" || o === "dark") return o;
  return systemDark ? "dark" : "light";
}

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
