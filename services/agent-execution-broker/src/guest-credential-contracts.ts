import { sha256Canonical } from "../../runner-control/src/canonical";

const SHA256 = /^[a-f0-9]{64}$/;
const UUID = /^[a-f0-9]{8}-[a-f0-9]{4}-4[a-f0-9]{3}-[89ab][a-f0-9]{3}-[a-f0-9]{12}$/;
const SAFE_ID = /^[A-Za-z0-9][A-Za-z0-9._:-]{2,199}$/;

export interface AgentMicrovmCredentialImageRequest {
  readonly schemaVersion: "deviludo.agent-microvm-credential-image-request.v1";
  readonly tenantId: string;
  readonly projectId: string;
  readonly runId: string;
  readonly attemptId: string;
  readonly profileRevisionId: string;
  readonly installationId: string;
  readonly agent: "claude-code" | "codex-cli";
  readonly exactAgentVersion: string;
  readonly adapterVersion: string;
  readonly workerImageDigest: `sha256:${string}`;
  readonly providerRevisionId: string;
  readonly credentialVersionId: string;
  readonly attestationKeyId: string;
  readonly nativeRequestDigest: string;
  readonly expiresAt: string;
}

export function parseAgentMicrovmCredentialImageRequest(value: unknown): AgentMicrovmCredentialImageRequest {
  const body = record(value);
  exactKeys(body, ["schemaVersion", "tenantId", "projectId", "runId", "attemptId", "profileRevisionId",
    "installationId", "agent", "exactAgentVersion", "adapterVersion", "workerImageDigest",
    "providerRevisionId", "credentialVersionId", "attestationKeyId", "nativeRequestDigest", "expiresAt"]);
  if (body.schemaVersion !== "deviludo.agent-microvm-credential-image-request.v1"
    || ![body.tenantId, body.projectId, body.runId, body.attemptId].every((item) => typeof item === "string" && UUID.test(item))
    || ![body.profileRevisionId, body.installationId, body.providerRevisionId, body.credentialVersionId,
      body.attestationKeyId].every((item) => typeof item === "string" && SAFE_ID.test(item))
    || (body.agent !== "claude-code" && body.agent !== "codex-cli")
    || typeof body.exactAgentVersion !== "string" || !/^\d+\.\d+\.\d+(?:-[0-9A-Za-z.-]+)?$/.test(body.exactAgentVersion)
    || typeof body.adapterVersion !== "string" || !/^\d+\.\d+\.\d+$/.test(body.adapterVersion)
    || typeof body.workerImageDigest !== "string" || !/^sha256:[a-f0-9]{64}$/.test(body.workerImageDigest)
    || typeof body.nativeRequestDigest !== "string" || !SHA256.test(body.nativeRequestDigest)
    || typeof body.expiresAt !== "string" || !canonicalTimestamp(body.expiresAt)) invalid();
  return Object.freeze({ ...body }) as unknown as AgentMicrovmCredentialImageRequest;
}

export function agentMicrovmCredentialRequestDigest(value: AgentMicrovmCredentialImageRequest): string {
  return sha256Canonical(parseAgentMicrovmCredentialImageRequest(value));
}

function record(value: unknown): Record<string, unknown> {
  if (!value || typeof value !== "object" || Array.isArray(value)) invalid();
  return value as Record<string, unknown>;
}
function exactKeys(value: Record<string, unknown>, expected: readonly string[]): void {
  if (JSON.stringify(Object.keys(value).sort()) !== JSON.stringify([...expected].sort())) invalid();
}
function canonicalTimestamp(value: string): boolean {
  return Number.isFinite(Date.parse(value)) && new Date(value).toISOString() === value;
}
function invalid(): never { throw new Error("Agent microVM credential issuance request is invalid"); }
