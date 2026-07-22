import type { PostgresWorkflowPool } from "../../temporal/src/postgres-inbox";
import { probePostgresRelations } from "../../temporal/src/postgres-readiness";
import { providerPolicyDigest, validateProviderBinding } from "./contract";
import type { SpecModelProviderAuthority, SpecModelProviderBinding } from "./contracts";
import { SpecModelProviderUnavailableError } from "./contracts";

const SAFE_ID = /^[A-Za-z0-9][A-Za-z0-9._:-]{0,199}$/;

/** Resolves one exact ACTIVE platform Profile without trusting request data. */
export class PostgresSpecModelProviderAuthority implements SpecModelProviderAuthority {
  constructor(private readonly pool: PostgresWorkflowPool) {}

  async resolve(profileRevisionId: string): Promise<SpecModelProviderBinding> {
    if (!SAFE_ID.test(profileRevisionId)) invalid();
    const client = await this.pool.connect();
    try {
      await client.query("BEGIN ISOLATION LEVEL REPEATABLE READ READ ONLY");
      const selected = await client.query<{ payload: unknown }>(
        "SELECT payload FROM deviludo.admin_catalog_state WHERE singleton = true FOR SHARE",
      );
      if (selected.rows.length !== 1) invalid();
      const catalog = record(selected.rows[0]!.payload);
      const profiles = list(catalog.profiles);
      const providers = list(catalog.providers);
      const credentials = list(catalog.credentials);
      const profile = profiles.map(record).find((item) => item.id === profileRevisionId);
      if (!profile || profile.state !== "ACTIVE" || profile.scope !== "platform" || profile.scopeId !== "global") invalid();
      const providerRevisionId = safeId(profile.providerRevisionId);
      const credentialVersionId = safeId(profile.credentialVersionId);
      const agent = agentKind(profile.agent);
      const provider = providers.map(record).find((item) => item.id === providerRevisionId);
      if (!provider || provider.state !== "ACTIVE" || provider.agent !== agent
        || provider.credentialVersionId !== credentialVersionId) invalid();
      const credential = credentials.map(record).find((item) => item.id === credentialVersionId);
      if (!credential || credential.state !== "ACTIVE" || credential.scope !== "platform"
        || credential.scopeId !== "global") invalid();
      const protocol = provider.protocol === "anthropic-messages" || provider.protocol === "openai-responses"
        ? provider.protocol : invalid();
      const authentication = provider.authentication === "bearer" || provider.authentication === "x-api-key"
        || provider.authentication === "authorization-bearer" ? provider.authentication : invalid();
      const models = record(provider.models);
      const withoutDigest = Object.freeze({
        profileRevisionId,
        providerRevisionId,
        credentialVersionId,
        agent,
        protocol,
        baseUrl: string(provider.baseUrl),
        approvedPorts: integerList(provider.approvedPorts),
        authentication,
        model: string(models.smallFastModel),
      });
      const binding = validateProviderBinding(Object.freeze({
        ...withoutDigest,
        policyDigest: providerPolicyDigest(withoutDigest),
      }));
      await client.query("COMMIT");
      return binding;
    } catch (error) {
      try { await client.query("ROLLBACK"); } catch { /* preserve authority failure */ }
      throw error;
    } finally { client.release(); }
  }

  async probe(): Promise<void> {
    await probePostgresRelations(this.pool, ["admin_catalog_state"],
      () => new SpecModelProviderUnavailableError("Specification model Provider authority schema is unavailable"));
  }
}

export class MemorySpecModelProviderAuthority implements SpecModelProviderAuthority {
  constructor(readonly binding: SpecModelProviderBinding) {}
  async resolve(profileRevisionId: string): Promise<SpecModelProviderBinding> {
    if (profileRevisionId !== this.binding.profileRevisionId) invalid();
    return validateProviderBinding(this.binding);
  }
  async probe(): Promise<void> {}
}

function record(value: unknown): Record<string, unknown> {
  if (!value || typeof value !== "object" || Array.isArray(value)) invalid();
  return value as Record<string, unknown>;
}
function list(value: unknown): readonly unknown[] { if (!Array.isArray(value)) invalid(); return value; }
function string(value: unknown): string { if (typeof value !== "string" || !value) invalid(); return value; }
function safeId(value: unknown): string { const result = string(value); if (!SAFE_ID.test(result)) invalid(); return result; }
function agentKind(value: unknown): "claude-code" | "codex-cli" {
  if (value !== "claude-code" && value !== "codex-cli") invalid();
  return value;
}
function integerList(value: unknown): readonly number[] {
  if (!Array.isArray(value) || value.length < 1 || value.length > 16
    || value.some((item) => !Number.isInteger(item))) invalid();
  return Object.freeze(value as number[]);
}
function invalid(): never { throw new SpecModelProviderUnavailableError("Specification model Provider authority rejected the binding"); }
