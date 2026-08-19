import type { Metadata } from "next";
import { cookies } from "next/headers";
import "@fontsource/dotgothic16/400.css";
import "@fontsource/press-start-2p/400.css";
import { LanguageProvider, type Locale } from "@/components/i18n/LanguageProvider";
import { ProductShell } from "@/components/ProductShell";
import { ThemeProvider } from "@/components/theme/ThemeProvider";
import { localizedMetadata } from "@/lib/web/localized-metadata";
import "./globals.css";
import "./product.css";
import "./asset-manifest.css";
import "./theme.css";

const themeBootstrap = `(()=>{try{const k="deviludo_theme",v=localStorage.getItem(k),m=v==="light"||v==="dark"||v==="system"?v:"system",d=m==="system"?matchMedia("(prefers-color-scheme: dark)").matches?"dark":"light":m,e=document.documentElement;e.dataset.themeMode=m;e.dataset.theme=d;e.style.colorScheme=d}catch{}})()`;

export async function generateMetadata(): Promise<Metadata> {
  const localized = await localizedMetadata(
    "DeviLudo · 游戏 AI 开发平台",
    "DeviLudo · AI Game Development Platform",
    "把游戏构想变成经过跨平台验证、可交付到 Steam 的成品。",
    "Turn game ideas into cross-platform validated builds ready for Steam delivery.",
  );
  return {
    ...localized,
    icons: {
      icon: [{ url: "/favicon-deviludo.png", sizes: "64x64", type: "image/png" }],
      shortcut: "/favicon-deviludo.png",
      apple: [{ url: "/deviludo-brand-mark.png", sizes: "256x256", type: "image/png" }],
    },
  };
}

export default async function RootLayout({ children }: Readonly<{ children: React.ReactNode }>) {
  const storedLocale = (await cookies()).get("deviludo_locale")?.value;
  const initialLocale: Locale = storedLocale === "en" ? "en" : "zh";
  return (
    <html lang={initialLocale === "en" ? "en" : "zh-CN"} suppressHydrationWarning>
      <head><script dangerouslySetInnerHTML={{ __html: themeBootstrap }} /></head>
      <body className="antialiased">
        <ThemeProvider>
          <LanguageProvider initialLocale={initialLocale}>
            <ProductShell>{children}</ProductShell>
          </LanguageProvider>
        </ThemeProvider>
      </body>
    </html>
  );
}
