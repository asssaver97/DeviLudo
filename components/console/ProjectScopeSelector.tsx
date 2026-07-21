"use client";

import type { ProjectCatalogItem } from "./useProjectCatalog";

export function ProjectScopeSelector({
  projects,
  selectedProjectId,
  onChange,
}: {
  projects: readonly ProjectCatalogItem[];
  selectedProjectId: string | null;
  onChange: (projectId: string) => void;
}) {
  if (!selectedProjectId || projects.length === 0) return null;
  return (
    <label className="project-scope-selector">
      <span>当前项目</span>
      <select aria-label="选择当前项目" onChange={(event) => onChange(event.target.value)} value={selectedProjectId}>
        {projects.map((project) => <option key={project.projectId} value={project.projectId}>{project.name} · {project.owner}/{project.repositoryName}</option>)}
      </select>
    </label>
  );
}
