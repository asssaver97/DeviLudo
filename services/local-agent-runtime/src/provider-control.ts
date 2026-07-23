import { createHash } from "node:crypto";
import type { GatewayCredentialLease } from "../../inference-gateway/src/production-connector";
import {
  PROVIDER_PROBE_CHECKS,
  StrictGatewayProviderProbe,
  parseProviderProbeRequest,
  type GatewayProviderProbeRequest,
  type GatewayProviderProbeService,
  type ProviderProbeCheck,
} from "../../inference-gateway/src/provider-probe";
import { NodeGatewayDnsResolver } from "../../inference-gateway/src/dns-resolver";
import type { LocalAgentPreflightRequest, LocalProviderBindingVerifier } from "./contracts";

const SAFE_ID = /^[A-Za-z0-9][A-Za-z0-9._:-]{0,199}$/;

export class LocalProviderControlInputError extends Error {}
export class LocalProviderControlConflictError extends Error {}
export class LocalProviderProbeError extends Error {}

export interface LocalCredentialPutReceipt {
  readonly credentialVersionId: string;
  readonly secretRef: string;
  readonly fingerprint: `sha256:${string}`;
  readonly state: "STORED";
}

export interface LocalProviderProbeReceipt {
  readonly providerRevisionId: string;
  readonly credentialVersionId: string;
  readonly checks: Readonly<Record<ProviderProbeCheck, "PASS">>;
  readonly state: "READY";
}

type VerifiedBinding = Readonly<{
  agent: GatewayProviderProbeRequest["agent"];
  credentialVersionId: string;
  models: GatewayProviderProbeRequest["models"];
}>;

/**
 * Process-local development Vault and Provider authority. Secret bytes never
 * leave this sidecar after ingress and are deliberately lost on restart.
 * Production uses the mTLS Secret Broker and Vault/KMS instead.
 */
export class LocalProviderControl implements LocalProviderBindingVerifier {
  readonly #credentials = new Map<string, Buffer>();
  readonly #bindings = new Map<string, VerifiedBinding>();
  readonly #probe: GatewayProviderProbeService;

  constructor(probe?: GatewayProviderProbeService) {
    this.#probe = probe ?? new StrictGatewayProviderProbe({
      credentials: { resolveProviderProbe: (input) => this.#lease(input) },
      dns: new NodeGatewayDnsResolver(),
    });
  }

  putCredential(value: unknown): LocalCredentialPutReceipt {
    const body = record(value);
    exactKeys(body, ["credentialVersionId", "secret"]);
    const credentialVersionId = safeId(body.credentialVersionId);
    const secret = secretBytes(body.secret);
    const fingerprint = `sha256:${createHash("sha256").update(secret).digest("hex")}` as const;
    const current = this.#credentials.get(credentialVersionId);
    if (current) {
      const currentFingerprint = createHash("sha256").update(current).digest("hex");
      secret.fill(0);
      if (`sha256:${currentFingerprint}` !== fingerprint) {
        throw new LocalProviderControlConflictError("Credential version already contains different material");
      }
      return credentialReceipt(credentialVersionId, fingerprint);
    }
    this.#credentials.set(credentialVersionId, secret);
    return credentialReceipt(credentialVersionId, fingerprint);
  }

  revokeCredential(value: unknown): Readonly<{ credentialVersionId: string; state: "REVOKED" }> {
    const body = record(value);
    exactKeys(body, ["credentialVersionId"]);
    const credentialVersionId = safeId(body.credentialVersionId);
    const secret = this.#credentials.get(credentialVersionId);
    secret?.fill(0);
    this.#credentials.delete(credentialVersionId);
    for (const [providerRevisionId, binding] of this.#bindings) {
      if (binding.credentialVersionId === credentialVersionId) this.#bindings.delete(providerRevisionId);
    }
    return Object.freeze({ credentialVersionId, state: "REVOKED" });
  }

  async probe(value: unknown): Promise<LocalProviderProbeReceipt> {
    let provider: GatewayProviderProbeRequest;
    try { provider = parseProviderProbeRequest(value); }
    catch { throw new LocalProviderControlInputError("Provider probe request is invalid"); }
    if (!this.#credentials.has(provider.credentialVersionId)) {
      throw new LocalProviderProbeError("Provider credential version is unavailable");
    }
    let result: Awaited<ReturnType<GatewayProviderProbeService["run"]>>;
    try { result = await this.#probe.run(provider); }
    catch { throw new LocalProviderProbeError("Provider compatibility probe failed"); }
    if (result.providerRevisionId !== provider.providerRevisionId
      || JSON.stringify(Object.keys(result.checks).sort()) !== JSON.stringify([...PROVIDER_PROBE_CHECKS].sort())
      || !PROVIDER_PROBE_CHECKS.every((check) => result.checks[check] === "PASS")) {
      throw new LocalProviderProbeError("Provider compatibility probe receipt is invalid");
    }
    this.#bindings.set(provider.providerRevisionId, Object.freeze({
      agent: provider.agent,
      credentialVersionId: provider.credentialVersionId,
      models: Object.freeze({ ...provider.models }),
    }));
    return Object.freeze({
      providerRevisionId: provider.providerRevisionId,
      credentialVersionId: provider.credentialVersionId,
      checks: result.checks,
      state: "READY",
    });
  }

  async verify(request: LocalAgentPreflightRequest): Promise<boolean> {
    const binding = this.#bindings.get(request.providerRevisionId);
    return Boolean(binding
      && this.#credentials.has(request.credentialVersionId)
      && binding.agent === request.agent
      && binding.credentialVersionId === request.credentialVersionId
      && request.model === binding.models.primaryModel
      && sameModels(request.modelRoles, binding.models));
  }

  close(): void {
    for (const secret of this.#credentials.values()) secret.fill(0);
    this.#credentials.clear();
    this.#bindings.clear();
  }

  async #lease(input: Readonly<{ providerRevisionId: string; credentialVersionId: string }>): Promise<GatewayCredentialLease> {
    safeId(input.providerRevisionId);
    const credentialVersionId = safeId(input.credentialVersionId);
    const stored = this.#credentials.get(credentialVersionId);
    if (!stored) throw new LocalProviderProbeError("Provider credential version is unavailable");
    const value = Buffer.from(stored);
    let destroyed = false;
    return Object.freeze({
      value,
      destroy() {
        if (!destroyed) value.fill(0);
        destroyed = true;
      },
    });
  }
}

function credentialReceipt(credentialVersionId: string, fingerprint: `sha256:${string}`): LocalCredentialPutReceipt {
  return Object.freeze({
    credentialVersionId,
    secretRef: `secret://local-agent-runtime/${credentialVersionId}`,
    fingerprint,
    state: "STORED",
  });
}

function secretBytes(value: unknown): Buffer {
  if (typeof value !== "string" || value.length < 8 || value.length > 64 * 1024 || /[\0\r\n]/.test(value)) {
    throw new LocalProviderControlInputError("Credential material is invalid");
  }
  return Buffer.from(value, "utf8");
}

function safeId(value: unknown): string {
  if (typeof value !== "string" || !SAFE_ID.test(value)) throw new LocalProviderControlInputError("Provider control identifier is invalid");
  return value;
}

function record(value: unknown): Record<string, unknown> {
  if (!value || typeof value !== "object" || Array.isArray(value)) throw new LocalProviderControlInputError("Provider control request is invalid");
  return value as Record<string, unknown>;
}

function exactKeys(value: Record<string, unknown>, keys: readonly string[]): void {
  if (JSON.stringify(Object.keys(value).sort()) !== JSON.stringify([...keys].sort())) {
    throw new LocalProviderControlInputError("Provider control request shape is invalid");
  }
}

function sameModels(left: LocalAgentPreflightRequest["modelRoles"], right: GatewayProviderProbeRequest["models"]): boolean {
  return left.primaryModel === right.primaryModel
    && left.planningModel === right.planningModel
    && left.smallFastModel === right.smallFastModel
    && left.subagentModel === right.subagentModel;
}
