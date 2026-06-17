"use client";

import {
  createContext,
  useContext,
  useEffect,
  useMemo,
  useState,
  type ReactNode,
} from "react";
import {
  DICTS,
  resolveInitialLang,
  type Lang,
  type Theme,
} from "@/lib/i18n";

interface AppPrefs {
  lang: Lang;
  setLang: (l: Lang) => void;
  theme: Theme;
  setTheme: (t: Theme) => void;
  /** Resolved theme — what's actually applied (system → light/dark). */
  resolvedTheme: "light" | "dark";
  /** Convenience access to the active dictionary. */
  t: ReturnType<typeof getDict>;
}

function getDict(lang: Lang) {
  const base = DICTS.en;
  const active = DICTS[lang] ?? base;
  // Shallow merge so any missing key in the active lang falls back to English.
  return new Proxy(active, {
    get(target, prop: string) {
      if (prop in target) return (target as any)[prop];
      return (base as any)[prop];
    },
  });
}

const AppPrefCtx = createContext<AppPrefs | null>(null);

const STORAGE_LANG = "f1tv:lang";
const STORAGE_THEME = "f1tv:theme";

function applyTheme(theme: Theme): "light" | "dark" {
  const root = document.documentElement;
  let resolved: "light" | "dark";
  if (theme === "system") {
    resolved = window.matchMedia("(prefers-color-scheme: dark)").matches
      ? "dark"
      : "light";
  } else {
    resolved = theme;
  }
  root.classList.toggle("dark", resolved === "dark");
  root.classList.toggle("light", resolved === "light");
  root.style.colorScheme = resolved;
  return resolved;
}

export function AppPrefProvider({ children }: { children: ReactNode }) {
  // Lazy init — only runs on client. The first server-rendered paint uses the
  // HTML class set by <html className="dark"> in layout.tsx, which is fine.
  const [lang, setLangState] = useState<Lang>("en");
  const [theme, setThemeState] = useState<Theme>("system");
  const [resolvedTheme, setResolvedTheme] = useState<"light" | "dark">("dark");

  // Hydrate from localStorage / navigator on mount.
  useEffect(() => {
    setLangState(resolveInitialLang());
    const storedT = (localStorage.getItem(STORAGE_THEME) as Theme | null) ?? "system";
    setThemeState(storedT);
    setResolvedTheme(applyTheme(storedT));
  }, []);

  // React to system theme changes when in "system" mode.
  useEffect(() => {
    if (theme !== "system") return;
    const mq = window.matchMedia("(prefers-color-scheme: dark)");
    const handler = () => setResolvedTheme(applyTheme("system"));
    mq.addEventListener("change", handler);
    return () => mq.removeEventListener("change", handler);
  }, [theme]);

  // Re-apply whenever theme changes.
  useEffect(() => {
    setResolvedTheme(applyTheme(theme));
  }, [theme]);

  const setLang = (l: Lang) => {
    setLangState(l);
    try {
      localStorage.setItem(STORAGE_LANG, l);
    } catch {
      // ignore
    }
  };

  const setTheme = (t: Theme) => {
    setThemeState(t);
    try {
      localStorage.setItem(STORAGE_THEME, t);
    } catch {
      // ignore
    }
  };

  const value = useMemo<AppPrefs>(
    () => ({
      lang,
      setLang,
      theme,
      setTheme,
      resolvedTheme,
      t: getDict(lang),
    }),
    [lang, theme, resolvedTheme],
  );

  return <AppPrefCtx.Provider value={value}>{children}</AppPrefCtx.Provider>;
}

export function useAppPref() {
  const ctx = useContext(AppPrefCtx);
  if (!ctx)
    throw new Error("useAppPref must be used inside <AppPrefProvider>");
  return ctx;
}
