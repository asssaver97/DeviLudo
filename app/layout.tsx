import type { Metadata } from "next";
import { Geist, Geist_Mono } from "next/font/google";
import { headers } from "next/headers";
import "./globals.css";

const geistSans = Geist({
  variable: "--font-geist-sans",
  subsets: ["latin"],
});

const geistMono = Geist_Mono({
  variable: "--font-geist-mono",
  subsets: ["latin"],
});

export async function generateMetadata(): Promise<Metadata> {
  const requestHeaders = await headers();
  const forwardedHost = requestHeaders.get("x-forwarded-host")?.split(",")[0]?.trim();
  const host = forwardedHost ?? requestHeaders.get("host") ?? "127.0.0.1:3000";
  const forwardedProtocol = requestHeaders.get("x-forwarded-proto")?.split(",")[0]?.trim();
  const protocol = forwardedProtocol === "http" || forwardedProtocol === "https"
    ? forwardedProtocol
    : host.startsWith("localhost") || host.startsWith("127.0.0.1") ? "http" : "https";
  const safeHost = /^[a-z0-9.:[\]-]+$/i.test(host) ? host : "127.0.0.1:3000";
  const metadataBase = new URL(`${protocol}://${safeHost}`);
  const socialImage = new URL("/og-gameforge.png", metadataBase).toString();

  return {
    metadataBase,
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
      title: "DeviLudo · GAMEFORGE OS",
      description: "构想、自动开发、跨平台 E2E、验收与 Steam 发布的一体化游戏开发指挥台。",
      images: [{ url: socialImage, width: 1672, height: 941, alt: "DeviLudo GAMEFORGE OS 游戏开发指挥台" }],
    },
    twitter: {
      card: "summary_large_image",
      title: "DeviLudo · GAMEFORGE OS",
      description: "BUILD. TEST. SHIP. 从游戏构想到 Steam 交付。",
      images: [socialImage],
    },
  };
}

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
