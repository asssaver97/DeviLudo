import type { Metadata } from "next";
import { AgentSettings } from "@/components/AgentSettings";
import { TelemetrySettingsPanel } from "@/components/TelemetrySettings";
import { SteamSettings } from "@/components/SteamSettings";
import { localizedMetadata } from "@/lib/web/localized-metadata";

export async function generateMetadata(): Promise<Metadata> {
  return localizedMetadata(
    "设置 · DeviLudo",
    "Settings · DeviLudo",
    "配置 DeviLudo 全局 Agent 运行时、Provider Base URL 与 API Key。",
    "Configure the global Agent runtime, Provider Base URL, and API key.",
  );
}

export default function SettingsPage() {
  return (
    <>
      <AgentSettings />
      <div className="settings-secondary-grid">
        <SteamSettings />
        <TelemetrySettingsPanel />
      </div>
    </>
  );
}
