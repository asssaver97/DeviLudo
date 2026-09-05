export function synchronizeLocalArtifactCache(
  root: string,
  projectId: string,
  artifactIds: readonly string[],
): Promise<Readonly<{ removed: number; retained: number }>>;
