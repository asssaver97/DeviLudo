import type { Metadata } from "next";
import { ProjectAgentSettings } from "@/components/console/ProjectAgentSettings";

export const metadata: Metadata = { title: "项目 Agent", description: "选择项目使用的已批准 Agent Profile。" };
export default async function ProjectAgentSettingsPage({ params }: { params: Promise<{ projectId: string }> }) {
  const { projectId } = await params;
  return <ProjectAgentSettings projectId={projectId} />;
}
