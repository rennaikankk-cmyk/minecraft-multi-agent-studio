"use client";

import { useEffect, useState } from "react";

export type ThemeId = "tactical" | "modern" | "pixel";

const THEMES: ReadonlyArray<{ id: ThemeId; label: string }> = [
  { id: "tactical", label: "指挥" },
  { id: "modern", label: "简洁" },
  { id: "pixel", label: "像素" },
];

const STORAGE_KEY = "studio-theme";

function isThemeId(value: unknown): value is ThemeId {
  return value === "tactical" || value === "modern" || value === "pixel";
}

function applyTheme(theme: ThemeId): void {
  if (theme === "tactical") {
    document.documentElement.removeAttribute("data-theme");
  } else {
    document.documentElement.setAttribute("data-theme", theme);
  }
}

export function ThemeSwitcher() {
  const [theme, setTheme] = useState<ThemeId>("tactical");

  useEffect(() => {
    const stored = window.localStorage.getItem(STORAGE_KEY);
    if (isThemeId(stored)) {
      setTheme(stored);
      applyTheme(stored);
    }
  }, []);

  const select = (next: ThemeId) => {
    setTheme(next);
    applyTheme(next);
    try {
      window.localStorage.setItem(STORAGE_KEY, next);
    } catch {
      // Persisting the preference is best-effort; the theme still applies.
    }
  };

  return (
    <div className="themeSwitcher" role="group" aria-label="界面风格切换" data-testid="theme-switcher">
      {THEMES.map((entry) => (
        <button
          key={entry.id}
          type="button"
          className={theme === entry.id ? "active" : ""}
          aria-pressed={theme === entry.id}
          onClick={() => select(entry.id)}
          data-testid={`theme-${entry.id}`}
        >
          {entry.label}
        </button>
      ))}
    </div>
  );
}
