import type { Metadata } from "next";
import { ProjectStudio } from "@/components/ProjectStudio";

export const metadata: Metadata = { title: "项目工作室 · DeviLudo" };

export default async function ProjectPage({ params }: { params: Promise<{ projectId: string }> }) {
  const { projectId } = await params;
  return <ProjectStudio projectId={projectId} />;
}
