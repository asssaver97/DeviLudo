import type { Metadata } from "next";
import { ProjectStudio } from "@/components/console/ProjectStudio";

export const metadata: Metadata = {
  title: "余烬群岛",
  description: "余烬群岛的规格、开发、测试和反馈迭代工作区。",
};

export default async function ProjectPage({ params }: { params: Promise<{ projectId: string }> }) {
  const { projectId } = await params;
  return <ProjectStudio mode="existing" projectId={projectId} />;
}
