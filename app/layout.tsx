import type { Metadata } from "next";
import { cookies } from "next/headers";
import "@fontsource/dotgothic16/400.css";
import "@fontsource/press-start-2p/400.css";
import { LanguageProvider, type Locale } from "@/components/i18n/LanguageProvider";
import { ProductShell } from "@/components/ProductShell";
import "./globals.css";
import "./product.css";
import "./asset-manifest.css";

export const metadata: Metadata = {
  title: "DeviLudo · 游戏 AI 开发平台",
  description: "把游戏构想变成经过跨平台验证、可交付到 Steam 的成品。",
  icons: {
    icon: [{ url: "/favicon-deviludo.png", sizes: "64x64", type: "image/png" }],
    shortcut: "/favicon-deviludo.png",
    apple: [{ url: "/deviludo-brand-mark.png", sizes: "256x256", type: "image/png" }],
  },
};

export default async function RootLayout({ children }: Readonly<{ children: React.ReactNode }>) {
  const storedLocale = (await cookies()).get("deviludo_locale")?.value;
  const initialLocale: Locale = storedLocale === "en" ? "en" : "zh";
  return (
    <html lang={initialLocale === "en" ? "en" : "zh-CN"} suppressHydrationWarning>
      <body className="antialiased"><LanguageProvider initialLocale={initialLocale}><ProductShell>{children}</ProductShell></LanguageProvider></body>
    </html>
  );
}
