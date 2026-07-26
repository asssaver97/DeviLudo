import type { Metadata } from "next";
import { Dashboard } from "@/components/console/Dashboard";

export const metadata: Metadata = {
  title: "工作台",
  description: "从游戏构想到跨平台测试与 Steam 发布的自动开发控制台。",
};

export default function Home() {
  return <Dashboard />;
}
