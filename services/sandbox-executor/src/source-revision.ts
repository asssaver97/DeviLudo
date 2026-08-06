export type AgentSourceReference = Readonly<{
  revision: number;
  relativePath: string;
  digest: string;
}>;

export function validateAgentSourceReference(
  payload: Readonly<Record<string, unknown>>,
  workspaceId: string,
  projectId: string,
): AgentSourceReference | null {
  const revision = payload.sourceRevision;
  const relativePath = payload.sourceRelativePath;
  const digest = payload.sourceDigest;
  const values = [revision, relativePath, digest];

  if (values.every(value => value === undefined || value === null)) return null;
  if (!Number.isSafeInteger(revision) || Number(revision) < 1
    || typeof relativePath !== "string"
    || typeof digest !== "string"
    || !/^sha256:[0-9a-f]{64}$/.test(digest)) {
    throw new Error("Agent source revision is invalid");
  }

  const expectedPath = `workspaces/${workspaceId}/projects/${projectId}/revisions/r${String(revision).padStart(12, "0")}-${digest.slice(7, 23)}`;
  if (relativePath !== expectedPath) throw new Error("Agent source revision is invalid");

  return Object.freeze({ revision: Number(revision), relativePath, digest });
}
