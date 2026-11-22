"use client";

import { useEffect, useSyncExternalStore, type ReactNode } from "react";

type Theme = "light" | "dark" | "system";
type ResolvedTheme = "light" | "dark";

const THEME_STORAGE_KEY = "theme";
const themeListeners = new Set<() => void>();
let selectedTheme: Theme = "system";
let themeStoreInitialized = false;

function isTheme(value: string | null): value is Theme {
  return value === "light" || value === "dark" || value === "system";
}

function getThemeSnapshot(): Theme {
  if (typeof window === "undefined") return "system";
  if (!themeStoreInitialized) {
    try {
      const storedTheme = localStorage.getItem(THEME_STORAGE_KEY);
      selectedTheme = isTheme(storedTheme) ? storedTheme : "system";
    } catch {
      selectedTheme = "system";
    }
    themeStoreInitialized = true;
  }
  return selectedTheme;
}

function subscribeToTheme(listener: () => void) {
  themeListeners.add(listener);
  const handleStorage = (event: StorageEvent) => {
    if (event.key !== THEME_STORAGE_KEY) return;
    selectedTheme = isTheme(event.newValue) ? event.newValue : "system";
    themeStoreInitialized = true;
    themeListeners.forEach((notify) => notify());
  };
  window.addEventListener("storage", handleStorage);
  return () => {
    themeListeners.delete(listener);
    window.removeEventListener("storage", handleStorage);
  };
}

function getSystemThemeSnapshot(): ResolvedTheme {
  return window.matchMedia("(prefers-color-scheme: dark)").matches ? "dark" : "light";
}

function applyThemeToDocument(theme: Theme, systemTheme = getSystemThemeSnapshot()) {
  if (typeof document === "undefined") return;
  const resolvedTheme = theme === "system" ? systemTheme : theme;
  document.documentElement.classList.toggle("dark", resolvedTheme === "dark");

  const walletSurface = document.querySelector(".wallet-shell");
  const themeColor = walletSurface
    ? getComputedStyle(walletSurface).backgroundColor
    : resolvedTheme === "dark" ? "#151B2A" : "#F6F7FB";
  const themeColorTags = document.querySelectorAll<HTMLMetaElement>('meta[name="theme-color"]');
  themeColorTags.forEach((tag) => {
    tag.content = themeColor;
  });
}

function subscribeToSystemTheme(listener: () => void) {
  const mediaQuery = window.matchMedia("(prefers-color-scheme: dark)");
  const handleChange = () => {
    if (selectedTheme === "system") applyThemeToDocument("system", mediaQuery.matches ? "dark" : "light");
    listener();
  };
  mediaQuery.addEventListener("change", handleChange);
  return () => mediaQuery.removeEventListener("change", handleChange);
}

function setThemeValue(theme: Theme) {
  selectedTheme = theme;
  themeStoreInitialized = true;
  try { localStorage.setItem(THEME_STORAGE_KEY, theme); } catch { /* The current session still changes if storage is unavailable. */ }
  applyThemeToDocument(theme);
  themeListeners.forEach((listener) => listener());
}

export function useTheme() {
  const theme = useSyncExternalStore<Theme>(subscribeToTheme, getThemeSnapshot, (): Theme => "system");
  const systemTheme = useSyncExternalStore<ResolvedTheme>(subscribeToSystemTheme, getSystemThemeSnapshot, (): ResolvedTheme => "light");
  const resolvedTheme = theme === "system" ? systemTheme : theme;
  return { theme, resolvedTheme, setTheme: setThemeValue };
}

type ThemeProviderProps = {
  children: ReactNode;
  defaultTheme?: Theme;
  enableSystem?: boolean;
  disableTransitionOnChange?: boolean;
};

export function ThemeProvider({
  children,
  defaultTheme = "system",
  disableTransitionOnChange = false,
}: ThemeProviderProps) {
  const { theme, resolvedTheme } = useTheme();

  useEffect(() => {
    if (!themeStoreInitialized && defaultTheme !== "system") setThemeValue(defaultTheme);
    applyThemeToDocument(theme, resolvedTheme);

    let transitionStyle: HTMLStyleElement | undefined;
    if (disableTransitionOnChange) {
      transitionStyle = document.createElement("style");
      transitionStyle.textContent = "*,*::before,*::after{transition:none!important}";
      document.head.appendChild(transitionStyle);
      window.requestAnimationFrame(() => window.requestAnimationFrame(() => transitionStyle?.remove()));
    }

  }, [defaultTheme, disableTransitionOnChange, resolvedTheme, theme]);

  return children;
}
