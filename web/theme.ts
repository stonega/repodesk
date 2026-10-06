export type Theme = "light" | "dark";

export function readTheme(): Theme {
  try {
    const saved = localStorage.getItem("repodesk.theme");
    if (saved === "light" || saved === "dark") return saved;
  } catch {
    // The switch still works when browser storage is unavailable.
  }
  return matchMedia("(prefers-color-scheme: dark)").matches ? "dark" : "light";
}

export function applyTheme(theme: Theme) {
  document.documentElement.dataset.theme = theme;
  document
    .querySelector('meta[name="theme-color"]')
    ?.setAttribute("content", theme === "dark" ? "#11171e" : "#f1f2f6");
}

export function saveTheme(theme: Theme) {
  applyTheme(theme);
  try {
    localStorage.setItem("repodesk.theme", theme);
  } catch {
    // Keep the selected theme for this page even without persistence.
  }
}
