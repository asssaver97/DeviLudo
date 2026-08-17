import type { Metadata } from "next";
import { ProjectStudio } from "@/components/ProjectStudio";
import { localizedMetadata } from "@/lib/web/localized-metadata";

export async function generateMetadata(): Promise<Metadata> {
  return localizedMetadata("项目 · DeviLudo", "Project · DeviLudo");
}

export default async function ProjectPage({ params }: { params: Promise<{ projectId: string }> }) {
  const { projectId } = await params;
  return <ProjectStudio projectId={projectId} />;
}
