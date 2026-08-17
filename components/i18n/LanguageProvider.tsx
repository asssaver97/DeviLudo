"use client";

import { createContext, useContext, useEffect, useMemo, useState, type ReactNode } from "react";

export type Locale = "zh" | "en";

type LanguageContextValue = Readonly<{
  locale: Locale;
  setLocale: (locale: Locale) => void;
  text: (chinese: string, english: string) => string;
  errorText: (message: unknown, chineseFallback: string, englishFallback: string) => string;
}>;

const LanguageContext = createContext<LanguageContextValue | null>(null);

export function LanguageProvider({ children, initialLocale }: Readonly<{ children: ReactNode; initialLocale: Locale }>) {
  const [locale, setLocaleState] = useState<Locale>(initialLocale);

  useEffect(() => {
    document.documentElement.lang = locale === "en" ? "en" : "zh-CN";
  }, [locale]);

  const value = useMemo<LanguageContextValue>(() => ({
    locale,
    setLocale(nextLocale) {
      setLocaleState(nextLocale);
      document.cookie = `deviludo_locale=${nextLocale}; Path=/; Max-Age=31536000; SameSite=Lax`;
      document.documentElement.lang = nextLocale === "en" ? "en" : "zh-CN";
    },
    text(chinese, english) {
      return locale === "en" ? english : chinese;
    },
    errorText(message, chineseFallback, englishFallback) {
      const fallback = locale === "en" ? englishFallback : chineseFallback;
      if (typeof message !== "string" || !message.trim()) return fallback;
      // Core error details are not presentation copy and can originate from an
      // older job or a provider. Never leak a Chinese server fallback into the
      // English UI; keep useful provider messages that are already English.
      if (locale === "en" && /\p{Script=Han}/u.test(message)) return englishFallback;
      return message;
    },
  }), [locale]);

  return <LanguageContext.Provider value={value}>{children}</LanguageContext.Provider>;
}

export function useLanguage(): LanguageContextValue {
  const value = useContext(LanguageContext);
  if (!value) throw new Error("LanguageProvider is missing");
  return value;
}

export function LanguageSwitcher({ compact = false }: Readonly<{ compact?: boolean }>) {
  const { locale, setLocale, text } = useLanguage();
  return (
    <div aria-label={text("语言", "Language")} className={`language-switcher ${compact ? "is-compact" : ""}`} role="group">
      <button aria-label="中文" aria-pressed={locale === "zh"} onClick={() => setLocale("zh")} type="button">中</button>
      <button aria-label="English" aria-pressed={locale === "en"} onClick={() => setLocale("en")} type="button">EN</button>
    </div>
  );
}

export function localeTag(locale: Locale): string {
  return locale === "en" ? "en-US" : "zh-CN";
}
