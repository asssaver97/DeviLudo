import type { Metadata } from "next";
import { Geist, Geist_Mono } from "next/font/google";
import "./globals.css";

const geistSans = Geist({
  variable: "--font-geist-sans",
  subsets: ["latin"],
});

const geistMono = Geist_Mono({
  variable: "--font-geist-mono",
  subsets: ["latin"],
});

export const metadata: Metadata = {
  metadataBase: new URL("https://deviludo.example"),
  title: {
    default: "DeviLudo · 游戏 AI 开发平台",
    template: "%s · DeviLudo",
  },
  description: "把游戏构想变成经过跨平台验证、可交付到 Steam 的成品。",
  icons: {
    icon: "/favicon.svg",
    shortcut: "/favicon.svg",
  },
  openGraph: {
    title: "DeviLudo · 游戏 AI 开发平台",
    description: "构想、自动开发、跨平台 E2E、验收与 Steam 发布的一体化控制台。",
    images: ["/og-developer-platform.png"],
  },
};

export default function RootLayout({
  children,
}: Readonly<{
  children: React.ReactNode;
}>) {
  return (
    <html lang="zh-CN">
      <body
        className={`${geistSans.variable} ${geistMono.variable} antialiased`}
      >
        {children}
      </body>
    </html>
  );
}
