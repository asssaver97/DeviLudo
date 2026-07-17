import { deepFreeze, type ActorType, type DeepReadonly, type EntityId, type ISODateTime, type Sha256 } from "./types";

export interface AuditActor {
  readonly type: ActorType;
  readonly id: EntityId;
  readonly ipAddress: string | null;
}

export interface AuditEvent {
  readonly id: EntityId;
  readonly tenantId: EntityId | null;
  readonly projectId: EntityId | null;
  readonly actor: AuditActor;
  readonly action: string;
  readonly resourceType: string;
  readonly resourceId: EntityId;
  readonly requestId: string;
  readonly idempotencyKey: string | null;
  readonly beforeDigest: Sha256 | null;
  readonly afterDigest: Sha256 | null;
  readonly metadata: Readonly<Record<string, string | number | boolean | null>>;
  readonly previousEventHash: Sha256 | null;
  readonly eventHash: Sha256;
  readonly occurredAt: ISODateTime;
}

export type NewAuditEvent = Omit<AuditEvent, "eventHash" | "previousEventHash">;

const SECRET_KEY_PATTERN = /(api[-_]?key|secret|password|authorization|token|credential|session|cookie)/i;

export function sanitizeAuditMetadata(
  metadata: Readonly<Record<string, string | number | boolean | null>>,
): Readonly<Record<string, string | number | boolean | null>> {
  return Object.freeze(
    Object.fromEntries(
      Object.entries(metadata).map(([key, value]) => [key, SECRET_KEY_PATTERN.test(key) ? "[REDACTED]" : value]),
    ),
  );
}

function canonicalJson(value: unknown): string {
  if (value === null || typeof value !== "object") return JSON.stringify(value);
  if (Array.isArray(value)) return `[${value.map(canonicalJson).join(",")}]`;
  const entries = Object.entries(value as Record<string, unknown>).sort(([left], [right]) => left.localeCompare(right));
  return `{${entries.map(([key, child]) => `${JSON.stringify(key)}:${canonicalJson(child)}`).join(",")}}`;
}

async function sha256Hex(value: string): Promise<Sha256> {
  const bytes = new TextEncoder().encode(value);
  const digest = await crypto.subtle.digest("SHA-256", bytes);
  return [...new Uint8Array(digest)].map((byte) => byte.toString(16).padStart(2, "0")).join("");
}

/** Append-only, hash-chained audit entry. The database must reject UPDATE and DELETE. */
export async function appendAuditEvent(
  previous: AuditEvent | null,
  input: NewAuditEvent,
): Promise<DeepReadonly<AuditEvent>> {
  const previousEventHash = previous?.eventHash ?? null;
  const safeInput = { ...input, metadata: sanitizeAuditMetadata(input.metadata), previousEventHash };
  const eventHash = await sha256Hex(canonicalJson(safeInput));
  return deepFreeze({ ...safeInput, eventHash });
}
