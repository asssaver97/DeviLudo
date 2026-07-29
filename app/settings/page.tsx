import type { Metadata } from "next";
import { AgentSettings } from "@/components/AgentSettings";

export const metadata: Metadata = {
  title: "设置 · DeviLudo",
  description: "配置租户 Agent 运行时、Provider Base URL 与 API Key。",
};

export default function SettingsPage() {
  return <AgentSettings />;
}
