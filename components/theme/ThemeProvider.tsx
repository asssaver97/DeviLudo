"use client";

import { createContext, useContext, useEffect, useRef, useState, type ReactNode } from "react";
import { useLanguage } from "../i18n/LanguageProvider";

export type ThemeMode = "system" | "light" | "dark";
type ResolvedTheme = Exclude<ThemeMode, "system">;

type ThemeContextValue = Readonly<{
  mode: ThemeMode;
  setMode: (mode: ThemeMode) => void;
}>;

export const THEME_STORAGE_KEY = "deviludo_theme";

const ThemeContext = createContext<ThemeContextValue | null>(null);

function isThemeMode(value: string | null): value is ThemeMode {
  return value === "system" || value === "light" || value === "dark";
}

function storedThemeMode(): ThemeMode {
  try {
    const stored = window.localStorage.getItem(THEME_STORAGE_KEY);
    return isThemeMode(stored) ? stored : "system";
  } catch {
    return "system";
  }
}

function resolvedTheme(mode: ThemeMode, systemPrefersDark: boolean): ResolvedTheme {
  return mode === "system" ? (systemPrefersDark ? "dark" : "light") : mode;
}

function applyTheme(mode: ThemeMode, media: MediaQueryList): void {
  const resolved = resolvedTheme(mode, media.matches);
  document.documentElement.dataset.themeMode = mode;
  document.documentElement.dataset.theme = resolved;
  document.documentElement.style.colorScheme = resolved;
}

export function ThemeProvider({ children }: Readonly<{ children: ReactNode }>) {
  const [mode, setModeState] = useState<ThemeMode>("system");
  const modeRef = useRef<ThemeMode>("system");

  useEffect(() => {
    const media = window.matchMedia("(prefers-color-scheme: dark)");
    const initialMode = storedThemeMode();
    modeRef.current = initialMode;
    applyTheme(initialMode, media);

    // Keep the first server/client render identical, then reflect a persisted
    // preference in the control after hydration.
    const stateTimer = window.setTimeout(() => setModeState(initialMode), 0);
    const handleSystemChange = () => {
      if (modeRef.current === "system") applyTheme("system", media);
    };
    const handleStorage = (event: StorageEvent) => {
      if (event.key !== THEME_STORAGE_KEY) return;
      const nextMode = isThemeMode(event.newValue) ? event.newValue : "system";
      modeRef.current = nextMode;
      setModeState(nextMode);
      applyTheme(nextMode, media);
    };

    media.addEventListener("change", handleSystemChange);
    window.addEventListener("storage", handleStorage);
    return () => {
      window.clearTimeout(stateTimer);
      media.removeEventListener("change", handleSystemChange);
      window.removeEventListener("storage", handleStorage);
    };
  }, []);

  function setMode(nextMode: ThemeMode): void {
    const media = window.matchMedia("(prefers-color-scheme: dark)");
    modeRef.current = nextMode;
    setModeState(nextMode);
    try {
      window.localStorage.setItem(THEME_STORAGE_KEY, nextMode);
    } catch {
      // A private browser context may reject storage. The current page can
      // still switch themes, so storage failure is intentionally non-fatal.
    }
    applyTheme(nextMode, media);
  }

  return <ThemeContext.Provider value={{ mode, setMode }}>{children}</ThemeContext.Provider>;
}

export function useTheme(): ThemeContextValue {
  const value = useContext(ThemeContext);
  if (!value) throw new Error("ThemeProvider is missing");
  return value;
}

export function ThemeSwitcher({ compact = false }: Readonly<{ compact?: boolean }>) {
  const { mode, setMode } = useTheme();
  const { text } = useLanguage();
  const options: ReadonlyArray<Readonly<{ mode: ThemeMode; chinese: string; english: string; icon: ReactNode }>> = [
    { mode: "system", chinese: "自动", english: "Auto", icon: <SystemThemeIcon /> },
    { mode: "light", chinese: "浅色", english: "Light", icon: <LightThemeIcon /> },
    { mode: "dark", chinese: "深色", english: "Dark", icon: <DarkThemeIcon /> },
  ];

  return (
    <div aria-label={text("主题", "Theme")} className={`theme-switcher ${compact ? "is-compact" : ""}`} role="group">
      {options.map(option => {
        const label = text(option.chinese, option.english);
        return (
          <button
            aria-label={label}
            aria-pressed={mode === option.mode}
            key={option.mode}
            onClick={() => setMode(option.mode)}
            title={label}
            type="button"
          >
            {option.icon}<span>{label}</span>
          </button>
        );
      })}
    </div>
  );
}

function SystemThemeIcon() {
  return <svg aria-hidden="true" fill="none" viewBox="0 0 16 16"><rect height="9" rx="1" stroke="currentColor" width="13" x="1.5" y="2" /><path d="M5 14h6M8 11v3" stroke="currentColor" /></svg>;
}

function LightThemeIcon() {
  return <svg aria-hidden="true" fill="none" viewBox="0 0 16 16"><circle cx="8" cy="8" r="2.5" stroke="currentColor" /><path d="M8 1v2M8 13v2M1 8h2M13 8h2M3.05 3.05l1.4 1.4M11.55 11.55l1.4 1.4M12.95 3.05l-1.4 1.4M4.45 11.55l-1.4 1.4" stroke="currentColor" /></svg>;
}

function DarkThemeIcon() {
  return <svg aria-hidden="true" fill="none" viewBox="0 0 16 16"><path d="M13.5 10.2A6 6 0 0 1 5.8 2.5a5.5 5.5 0 1 0 7.7 7.7Z" stroke="currentColor" /></svg>;
}
