import type { Metadata } from "next";
import { ProjectSteamSettings } from "@/components/console/ProjectSteamSettings";

export const metadata: Metadata = { title: "Steam 发布设置", description: "通过隔离安全页面冻结项目 Steam App、Depot 与私有 Beta 配置。" };
export default async function ProjectSteamSettingsPage({ params }: { params: Promise<{ projectId: string }> }) {
  const { projectId } = await params;
  return <ProjectSteamSettings projectId={projectId} />;
}
