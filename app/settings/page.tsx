import type { Metadata } from "next";
import { AgentSettings } from "@/components/AgentSettings";
import { AccessSettings } from "@/components/AccessSettings";
import { ImageGenerationSettings } from "@/components/ImageGenerationSettings";
import { SteamSettings } from "@/components/SteamSettings";

export const metadata: Metadata = {
  title: "设置 · DeviLudo",
  description: "配置 Deviludo 全局 Agent 运行时、Provider Base URL 与 API Key。",
};

export default function SettingsPage() {
  return (
    <>
      <AgentSettings />
      <ImageGenerationSettings />
      <SteamSettings />
      <AccessSettings />
    </>
  );
}
