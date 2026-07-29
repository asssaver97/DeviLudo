import type { Metadata } from "next";
import "./globals.css";

export const metadata: Metadata = {
  title: "DeviLudo · 游戏 AI 开发平台",
  description: "把游戏构想变成经过跨平台验证、可交付到 Steam 的成品。",
};

export default function RootLayout({ children }: Readonly<{ children: React.ReactNode }>) {
  return (
    <html lang="zh-CN">
      <body>{children}</body>
    </html>
  );
}
