import { createPublicKey, sign, verify, type KeyObject } from "node:crypto";
import { open } from "node:fs/promises";
import type { DeliveryCommandDestination } from "./contracts";
import type { WorkflowTenantAssignmentSource } from "./job-worker-host";

const UUID = /^[a-f0-9]{8}-[a-f0-9]{4}-[1-5][a-f0-9]{3}-[89ab][a-f0-9]{3}-[a-f0-9]{12}$/i;
const SAFE_ID = /^[A-Za-z0-9][A-Za-z0-9._:-]{2,159}$/;
const MAX_MANIFEST_BYTES = 256 * 1024;
const MAX_VALIDITY_MS = 15 * 60_000;
const CLOCK_SKEW_MS = 30_000;

export interface WorkflowTenantAssignmentClaims {
  readonly kind: "deviludo-workflow-tenant-assignments";
  readonly version: 1;
  readonly workloadId: string;
  readonly destination: DeliveryCommandDestination;
  readonly revision: number;
  readonly tenantIds: readonly string[];
  readonly issuedAt: string;
  readonly expiresAt: string;
}

export interface SignedWorkflowTenantAssignments {
  readonly keyId: string;
  readonly claims: WorkflowTenantAssignmentClaims;
  readonly signature: string;
}

export interface WorkflowTenantAssignmentEnvelopeLoader {
  load(): Promise<unknown>;
}

export function signWorkflowTenantAssignments(
  keyId: string,
  privateKey: KeyObject,
  claims: WorkflowTenantAssignmentClaims,
): SignedWorkflowTenantAssignments {
  if (!SAFE_ID.test(keyId)) throw new Error("Workflow assignment key ID is invalid");
  validateClaims(claims, claims.workloadId, claims.destination, new Date(claims.issuedAt));
  return Object.freeze({
    keyId,
    claims: Object.freeze({ ...claims, tenantIds: Object.freeze([...claims.tenantIds]) }),
    signature: sign(null, Buffer.from(canonicalJson(claims)), privateKey).toString("base64"),
  });
}

/** Reads an atomically replaceable, read-only assignment manifest. */
export class FileWorkflowTenantAssignmentEnvelopeLoader implements WorkflowTenantAssignmentEnvelopeLoader {
  constructor(private readonly path: string) {
    if (!path.startsWith("/") || path.length > 4_096 || /\0/.test(path)) {
      throw new Error("Workflow tenant assignment manifest path is invalid");
    }
  }

  async load(): Promise<unknown> {
    const file = await open(this.path, "r");
    try {
      const stat = await file.stat();
      if (!stat.isFile() || stat.size < 2 || stat.size > MAX_MANIFEST_BYTES) {
        throw new Error("Workflow tenant assignment manifest file is invalid");
      }
      return JSON.parse(await file.readFile({ encoding: "utf8" })) as unknown;
    } finally {
      await file.close();
    }
  }
}

/**
 * Verifies the control-plane signature and short validity window on every
 * polling cycle, so a stale or tampered assignment cannot expand RLS access.
 */
export class SignedWorkflowTenantAssignmentSource implements WorkflowTenantAssignmentSource {
  constructor(
    private readonly loader: WorkflowTenantAssignmentEnvelopeLoader,
    private readonly publicKeys: ReadonlyMap<string, KeyObject>,
    private readonly workloadId: string,
    private readonly now: () => Date = () => new Date(),
  ) {
    if (!SAFE_ID.test(workloadId)) throw new Error("Workflow workload identity is invalid");
    if (publicKeys.size < 1 || publicKeys.size > 10) throw new Error("Workflow assignment key set is invalid");
  }

  async listTenantIds(destination: DeliveryCommandDestination): Promise<readonly string[]> {
    const envelope = parseEnvelope(await this.loader.load());
    const key = this.publicKeys.get(envelope.keyId);
    if (!key || !verify(null, Buffer.from(canonicalJson(envelope.claims)), key, Buffer.from(envelope.signature, "base64"))) {
      throw new Error("Workflow tenant assignment signature is invalid");
    }
    validateClaims(envelope.claims, this.workloadId, destination, this.now());
    return Object.freeze(envelope.claims.tenantIds.map((tenantId) => tenantId.toLowerCase()));
  }
}

export function workflowAssignmentSourceFromEnv(
  env: Readonly<Record<string, string | undefined>> = process.env,
  now: () => Date = () => new Date(),
): SignedWorkflowTenantAssignmentSource {
  const manifestPath = requiredEnv(env, "DEVILUDO_WORKFLOW_ASSIGNMENT_MANIFEST_FILE");
  const keyId = requiredEnv(env, "DEVILUDO_WORKFLOW_ASSIGNMENT_KEY_ID");
  const publicKey = requiredEnv(env, "DEVILUDO_WORKFLOW_ASSIGNMENT_PUBLIC_KEY");
  const workloadId = requiredEnv(env, "DEVILUDO_WORKLOAD_ID");
  if (!SAFE_ID.test(keyId)) throw new Error("Workflow assignment key ID is invalid");
  return new SignedWorkflowTenantAssignmentSource(
    new FileWorkflowTenantAssignmentEnvelopeLoader(manifestPath),
    new Map([[keyId, createPublicKey(publicKey)]]),
    workloadId,
    now,
  );
}

function parseEnvelope(value: unknown): SignedWorkflowTenantAssignments {
  if (!value || typeof value !== "object" || Array.isArray(value)) invalid();
  const envelope = value as Partial<SignedWorkflowTenantAssignments>;
  if (!SAFE_ID.test(envelope.keyId ?? "") || typeof envelope.signature !== "string"
    || envelope.signature.length < 40 || envelope.signature.length > 512
    || !envelope.claims || typeof envelope.claims !== "object") invalid();
  return envelope as SignedWorkflowTenantAssignments;
}

function validateClaims(
  claims: WorkflowTenantAssignmentClaims,
  workloadId: string,
  destination: DeliveryCommandDestination,
  at: Date,
): void {
  const issuedAt = Date.parse(claims.issuedAt);
  const expiresAt = Date.parse(claims.expiresAt);
  if (claims.kind !== "deviludo-workflow-tenant-assignments" || claims.version !== 1
    || claims.workloadId !== workloadId || claims.destination !== destination
    || !Number.isSafeInteger(claims.revision) || claims.revision < 1
    || !Number.isFinite(issuedAt) || !Number.isFinite(expiresAt)
    || !Number.isFinite(at.getTime()) || issuedAt > at.getTime() + CLOCK_SKEW_MS
    || expiresAt <= at.getTime() || expiresAt - issuedAt > MAX_VALIDITY_MS
    || !Array.isArray(claims.tenantIds) || claims.tenantIds.length > 10_000) invalid();
  const tenants = new Set<string>();
  for (const tenantId of claims.tenantIds) {
    if (typeof tenantId !== "string" || !UUID.test(tenantId) || tenants.has(tenantId.toLowerCase())) invalid();
    tenants.add(tenantId.toLowerCase());
  }
}

function canonicalJson(value: unknown): string {
  if (value === null || typeof value !== "object") return JSON.stringify(value);
  if (Array.isArray(value)) return `[${value.map(canonicalJson).join(",")}]`;
  return `{${Object.entries(value as Record<string, unknown>)
    .sort(([left], [right]) => left.localeCompare(right))
    .map(([key, entry]) => `${JSON.stringify(key)}:${canonicalJson(entry)}`)
    .join(",")}}`;
}

function requiredEnv(env: Readonly<Record<string, string | undefined>>, name: string): string {
  const value = env[name]?.trim();
  if (!value) throw new Error(`${name} is required`);
  return value;
}

function invalid(): never {
  throw new Error("Workflow tenant assignment manifest is invalid");
}
