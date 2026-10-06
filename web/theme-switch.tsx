import { useState } from "react";
import { IconButton } from "./icon-button.tsx";
import { readTheme, saveTheme } from "./theme.ts";

export function ThemeSwitch() {
  const [theme, setTheme] = useState(() => {
    const applied = document.documentElement.dataset.theme;
    return applied === "light" || applied === "dark" ? applied : readTheme();
  });
  return (
    <IconButton
      icon={theme === "dark" ? "sun" : "moon"}
      label={
        theme === "dark" ? "Switch to light theme" : "Switch to dark theme"
      }
      onClick={() => {
        const next = theme === "dark" ? "light" : "dark";
        saveTheme(next);
        setTheme(next);
      }}
    />
  );
}
