import { createHash } from "node:crypto";
import { assertPinnedModelId } from "../../../lib/agent/providers";
import type { GatewayProviderRevision } from "../../inference-gateway/src/contracts";
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
export class LocalProviderBindingConflictError extends Error {}
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

export interface LocalProviderBindingRebindReceipt {
  readonly providerRevisionId: string;
  readonly sourceProfileRevisionId: string;
  readonly targetProfileRevisionId: string;
  readonly state: "READY" | "ACTIVE";
  readonly sourceRemainsActive: true;
}

export interface LocalProviderBindingCheckReceipt {
  readonly providerRevisionId: string;
  readonly profileRevisionId: string;
  readonly active: boolean;
}

export type LocalProviderScope = "platform" | "tenant" | "project";

type VerifiedBinding = Readonly<{
  profileRevisionId: string;
  sourceProfileRevisionId: string | null;
  scope: LocalProviderScope;
  scopeId: string;
  provider: GatewayProviderRevision;
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
    for (const [key, binding] of this.#bindings) {
      if (binding.provider.credentialVersionId === credentialVersionId) this.#bindings.delete(key);
    }
    return Object.freeze({ credentialVersionId, state: "REVOKED" });
  }

  async probe(value: unknown): Promise<LocalProviderProbeReceipt> {
    const command = record(value);
    exactKeys(command, ["binding", "provider"]);
    let provider: GatewayProviderProbeRequest;
    try { provider = parseProviderProbeRequest(command.provider); }
    catch { throw new LocalProviderControlInputError("Provider probe request is invalid"); }
    const binding = providerBinding(command.binding);
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
    this.#bindings.set(bindingKey(provider.providerRevisionId, binding.profileRevisionId), Object.freeze({
      profileRevisionId: binding.profileRevisionId,
      sourceProfileRevisionId: null,
      scope: binding.scope,
      scopeId: binding.scopeId,
      // Gateway revisions intentionally have no READY state; a passed probe is
      // retained as disabled until the separate admin activation command.
      provider: gatewayProvider(provider, binding.pricing, "DISABLED"),
    }));
    return Object.freeze({
      providerRevisionId: provider.providerRevisionId,
      credentialVersionId: provider.credentialVersionId,
      checks: result.checks,
      state: "READY",
    });
  }

  rebind(value: unknown): LocalProviderBindingRebindReceipt {
    const body = bindingRebind(value);
    if (body.sourceProfileRevisionId === body.targetProfileRevisionId) {
      throw new LocalProviderControlInputError("Provider binding successor must have a new Profile revision identifier");
    }
    const source = this.#bindings.get(bindingKey(body.providerRevisionId, body.sourceProfileRevisionId));
    if (!source || source.profileRevisionId !== body.sourceProfileRevisionId
      || source.provider.state !== "ACTIVE"
      || source.provider.credentialVersionId !== body.credentialVersionId
      || source.scope !== body.scope || source.scopeId !== body.scopeId
      || !this.#credentials.has(body.credentialVersionId)) {
      throw new LocalProviderProbeError("Active source Provider binding is unavailable");
    }
    const targetKey = bindingKey(body.providerRevisionId, body.targetProfileRevisionId);
    const target = this.#bindings.get(targetKey);
    if (target) {
      if (target.profileRevisionId !== body.targetProfileRevisionId
        || target.sourceProfileRevisionId !== body.sourceProfileRevisionId
        || target.provider.credentialVersionId !== body.credentialVersionId
        || target.scope !== body.scope || target.scopeId !== body.scopeId) {
        throw new LocalProviderBindingConflictError("Provider binding successor already has different immutable lineage");
      }
      return bindingRebindReceipt(body, target.provider.state === "ACTIVE" ? "ACTIVE" : "READY");
    }
    this.#bindings.set(targetKey, Object.freeze({
      profileRevisionId: body.targetProfileRevisionId,
      sourceProfileRevisionId: body.sourceProfileRevisionId,
      scope: source.scope,
      scopeId: source.scopeId,
      // Installation rebinding never grants execution by itself. The new
      // immutable Profile still requires the separate SecurityAdmin gate.
      provider: Object.freeze({ ...snapshotProvider(source.provider), state: "DISABLED" }),
    }));
    return bindingRebindReceipt(body, "READY");
  }

  checkBinding(value: unknown): LocalProviderBindingCheckReceipt {
    const body = bindingCheck(value);
    const binding = this.#bindings.get(bindingKey(body.providerRevisionId, body.profileRevisionId));
    return Object.freeze({
      providerRevisionId: body.providerRevisionId,
      profileRevisionId: body.profileRevisionId,
      active: Boolean(binding
        && binding.profileRevisionId === body.profileRevisionId
        && binding.provider.state === "ACTIVE"
        && binding.provider.agent === body.agent
        && binding.provider.credentialVersionId === body.credentialVersionId
        && this.#credentials.has(body.credentialVersionId)
        && sameModels(body.modelRoles, binding.provider.models)),
    });
  }

  async verify(request: LocalAgentPreflightRequest): Promise<boolean> {
    const binding = this.#bindings.get(bindingKey(request.providerRevisionId, request.profileRevisionId));
    return Boolean(binding
      && this.#credentials.has(request.credentialVersionId)
      && binding.profileRevisionId === request.profileRevisionId
      && binding.provider.state === "ACTIVE"
      && binding.provider.agent === request.agent
      && binding.provider.credentialVersionId === request.credentialVersionId
      && request.model === binding.provider.models.primaryModel
      && sameModels(request.modelRoles, binding.provider.models));
  }

  activate(value: unknown): Readonly<{ providerRevisionId: string; profileRevisionId: string; state: "ACTIVE" }> {
    const body = activation(value);
    const key = bindingKey(body.providerRevisionId, body.profileRevisionId);
    const current = this.#bindings.get(key);
    if (!current || current.profileRevisionId !== body.profileRevisionId
      || current.provider.credentialVersionId !== body.credentialVersionId
      || !this.#credentials.has(body.credentialVersionId)) {
      throw new LocalProviderProbeError("Verified Provider binding is unavailable");
    }
    this.#bindings.set(key, Object.freeze({
      ...current,
      provider: Object.freeze({ ...current.provider, state: "ACTIVE" }),
    }));
    return Object.freeze({
      providerRevisionId: body.providerRevisionId,
      profileRevisionId: body.profileRevisionId,
      state: "ACTIVE",
    });
  }

  disable(value: unknown): Readonly<{ providerRevisionId: string; profileRevisionId: string; state: "DISABLED" }> {
    const body = activation(value, false);
    const key = bindingKey(body.providerRevisionId, body.profileRevisionId);
    const current = this.#bindings.get(key);
    if (!current || current.profileRevisionId !== body.profileRevisionId) {
      throw new LocalProviderProbeError("Verified Provider binding is unavailable");
    }
    this.#bindings.set(key, Object.freeze({
      ...current,
      provider: Object.freeze({ ...current.provider, state: "DISABLED" }),
    }));
    return Object.freeze({
      providerRevisionId: body.providerRevisionId,
      profileRevisionId: body.profileRevisionId,
      state: "DISABLED",
    });
  }

  authorizeExecution(request: LocalAgentPreflightRequest & Readonly<{ tenantId: string; projectId: string }>): GatewayProviderRevision | null {
    const binding = this.#bindings.get(bindingKey(request.providerRevisionId, request.profileRevisionId));
    if (!binding || binding.profileRevisionId !== request.profileRevisionId
      || binding.provider.state !== "ACTIVE"
      || binding.provider.agent !== request.agent
      || binding.provider.credentialVersionId !== request.credentialVersionId
      || request.model !== binding.provider.models.primaryModel
      || !sameModels(request.modelRoles, binding.provider.models)
      || !scopeAllows(binding, request.tenantId, request.projectId)) return null;
    return snapshotProvider(binding.provider);
  }

  providerForTenant(tenantId: string, providerRevisionId: string): GatewayProviderRevision | null {
    const revisionId = safeId(providerRevisionId);
    const binding = [...this.#bindings.values()].find((candidate) =>
      candidate.provider.providerRevisionId === revisionId
      && candidate.provider.state === "ACTIVE"
      && (candidate.scope !== "tenant" || candidate.scopeId === tenantId));
    return binding ? snapshotProvider(binding.provider) : null;
  }

  async resolveCredential(input: Readonly<{ providerRevisionId: string; credentialVersionId: string }>): Promise<GatewayCredentialLease> {
    const revisionId = safeId(input.providerRevisionId);
    const binding = [...this.#bindings.values()].find((candidate) =>
      candidate.provider.providerRevisionId === revisionId
      && candidate.provider.state === "ACTIVE"
      && candidate.provider.credentialVersionId === input.credentialVersionId);
    if (!binding || binding.provider.state !== "ACTIVE"
      || binding.provider.credentialVersionId !== input.credentialVersionId) {
      throw new LocalProviderProbeError("Active Provider credential binding is unavailable");
    }
    return this.#lease(input);
  }

  async probeCredentialStore(): Promise<void> {
    if (this.#credentials.size === 0) throw new LocalProviderProbeError("Provider credential store is empty");
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

function providerBinding(value: unknown): Readonly<{
  profileRevisionId: string;
  scope: LocalProviderScope;
  scopeId: string;
  pricing: GatewayProviderRevision["pricing"];
}> {
  const body = record(value);
  exactKeys(body, ["pricing", "profileRevisionId", "scope", "scopeId"]);
  if (body.scope !== "platform" && body.scope !== "tenant" && body.scope !== "project") {
    throw new LocalProviderControlInputError("Provider binding scope is invalid");
  }
  const pricing = record(body.pricing);
  exactKeys(pricing, ["inputUsdPerMillionTokens", "outputUsdPerMillionTokens"]);
  const input = nonNegative(pricing.inputUsdPerMillionTokens);
  const output = nonNegative(pricing.outputUsdPerMillionTokens);
  return Object.freeze({
    profileRevisionId: safeId(body.profileRevisionId),
    scope: body.scope,
    scopeId: safeId(body.scopeId),
    pricing: Object.freeze({ inputUsdPerMillionTokens: input, outputUsdPerMillionTokens: output }),
  });
}

function activation(value: unknown, requireCredential = true): Readonly<{
  providerRevisionId: string;
  profileRevisionId: string;
  credentialVersionId: string;
}> {
  const body = record(value);
  exactKeys(body, requireCredential
    ? ["credentialVersionId", "profileRevisionId", "providerRevisionId"]
    : ["profileRevisionId", "providerRevisionId"]);
  return Object.freeze({
    providerRevisionId: safeId(body.providerRevisionId),
    profileRevisionId: safeId(body.profileRevisionId),
    credentialVersionId: requireCredential ? safeId(body.credentialVersionId) : "disabled",
  });
}

function bindingRebind(value: unknown): Readonly<{
  providerRevisionId: string;
  sourceProfileRevisionId: string;
  targetProfileRevisionId: string;
  credentialVersionId: string;
  scope: LocalProviderScope;
  scopeId: string;
}> {
  const body = record(value);
  exactKeys(body, [
    "credentialVersionId", "providerRevisionId", "scope", "scopeId",
    "sourceProfileRevisionId", "targetProfileRevisionId",
  ]);
  if (body.scope !== "platform" && body.scope !== "tenant" && body.scope !== "project") {
    throw new LocalProviderControlInputError("Provider binding scope is invalid");
  }
  return Object.freeze({
    providerRevisionId: safeId(body.providerRevisionId),
    sourceProfileRevisionId: safeId(body.sourceProfileRevisionId),
    targetProfileRevisionId: safeId(body.targetProfileRevisionId),
    credentialVersionId: safeId(body.credentialVersionId),
    scope: body.scope,
    scopeId: safeId(body.scopeId),
  });
}

function bindingRebindReceipt(
  body: ReturnType<typeof bindingRebind>,
  state: LocalProviderBindingRebindReceipt["state"],
): LocalProviderBindingRebindReceipt {
  return Object.freeze({
    providerRevisionId: body.providerRevisionId,
    sourceProfileRevisionId: body.sourceProfileRevisionId,
    targetProfileRevisionId: body.targetProfileRevisionId,
    state,
    sourceRemainsActive: true,
  });
}

function bindingCheck(value: unknown): Readonly<{
  providerRevisionId: string;
  profileRevisionId: string;
  credentialVersionId: string;
  agent: "claude-code" | "codex-cli";
  modelRoles: LocalAgentPreflightRequest["modelRoles"];
}> {
  const body = record(value);
  exactKeys(body, ["agent", "credentialVersionId", "modelRoles", "profileRevisionId", "providerRevisionId"]);
  if (body.agent !== "claude-code" && body.agent !== "codex-cli") {
    throw new LocalProviderControlInputError("Provider binding Agent is invalid");
  }
  const roles = record(body.modelRoles);
  exactKeys(roles, ["planningModel", "primaryModel", "smallFastModel", "subagentModel"]);
  const modelRoles = Object.freeze({
    primaryModel: pinnedModel(roles.primaryModel),
    planningModel: pinnedModel(roles.planningModel),
    smallFastModel: pinnedModel(roles.smallFastModel),
    subagentModel: pinnedModel(roles.subagentModel),
  });
  return Object.freeze({
    providerRevisionId: safeId(body.providerRevisionId),
    profileRevisionId: safeId(body.profileRevisionId),
    credentialVersionId: safeId(body.credentialVersionId),
    agent: body.agent,
    modelRoles,
  });
}

function pinnedModel(value: unknown): string {
  if (typeof value !== "string") throw new LocalProviderControlInputError("Provider binding model is invalid");
  try { assertPinnedModelId(value); }
  catch { throw new LocalProviderControlInputError("Provider binding model is invalid"); }
  return value;
}

function gatewayProvider(
  provider: GatewayProviderProbeRequest,
  pricing: GatewayProviderRevision["pricing"],
  state: GatewayProviderRevision["state"],
): GatewayProviderRevision {
  return Object.freeze({
    providerRevisionId: provider.providerRevisionId,
    agent: provider.agent,
    protocol: provider.protocol,
    baseUrl: provider.baseUrl,
    approvedPorts: Object.freeze([...provider.approvedPorts]),
    authentication: provider.authentication,
    models: Object.freeze({ ...provider.models }),
    credentialVersionId: provider.credentialVersionId,
    pricing: Object.freeze({ ...pricing }),
    state,
  });
}

function snapshotProvider(provider: GatewayProviderRevision): GatewayProviderRevision {
  return Object.freeze({
    ...provider,
    approvedPorts: Object.freeze([...provider.approvedPorts]),
    models: Object.freeze({ ...provider.models }),
    pricing: Object.freeze({ ...provider.pricing }),
  });
}

function scopeAllows(binding: VerifiedBinding, tenantId: string, projectId: string): boolean {
  if (binding.scope === "platform") return binding.scopeId === "global";
  if (binding.scope === "tenant") return binding.scopeId === tenantId;
  return binding.scopeId === projectId;
}

function nonNegative(value: unknown): number {
  if (typeof value !== "number" || !Number.isFinite(value) || value < 0 || value > 1_000_000) {
    throw new LocalProviderControlInputError("Provider pricing is invalid");
  }
  return value;
}

function bindingKey(providerRevisionId: string, profileRevisionId: string): string {
  return `${providerRevisionId}\0${profileRevisionId}`;
}
