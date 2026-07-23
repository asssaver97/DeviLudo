import { createLocalProject } from "../../lib/projects/local-project-catalog.ts";

export async function ensureLocalProject(projectId) {
  const result = await createLocalProject({
    slug: projectId,
    name: `Test ${projectId}`.slice(0, 120),
    installationId: "local-fixture-9001",
    repositoryId: 7001,
  }, `test-project:${projectId}`);
  return result.project;
}
