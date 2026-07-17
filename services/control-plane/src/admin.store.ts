import { Injectable } from "@nestjs/common";
import type {
  AdminRole,
  AgentVersionRecord,
  AuditRecord,
  CredentialVersionRecord,
  InstallationRecord,
  ProfileRevisionRecord,
  ProviderRevisionRecord,
} from "./contracts";

export class AdminStore {
  readonly versions = new Map<string, AgentVersionRecord>();
  readonly installations = new Map<string, InstallationRecord>();
  readonly providers = new Map<string, ProviderRevisionRecord>();
  readonly profiles = new Map<string, ProfileRevisionRecord>();
  readonly credentials = new Map<string, CredentialVersionRecord>();
  readonly defaults = new Map<string, string>();
  readonly audit: AuditRecord[] = [];

  constructor() {
    this.seed();
  }

  recordAudit(input: {
    action: string;
    resource: string;
    role: AdminRole;
    requestId: string;
    metadata?: Readonly<Record<string, unknown>>;
  }): AuditRecord {
    const record: AuditRecord = Object.freeze({
      id: `audit-${String(this.audit.length + 1).padStart(8, "0")}`,
      action: input.action,
      resource: input.resource,
      actorRole: input.role,
      requestId: input.requestId,
      at: new Date().toISOString(),
      metadata: Object.freeze(redact(input.metadata ?? {})),
    });
    this.audit.unshift(record);
    return record;
  }

  private seed(): void {
    const now = new Date().toISOString();
    const claudeVersion: AgentVersionRecord = {
      id: "claude-code@2.1.14",
      agent: "claude-code",
      version: "2.1.14",
      state: "APPROVED",
      source: "https://code.claude.com/docs/en/installation",
      integrity: `sha256:${"1".repeat(64)}`,
      signatureVerified: true,
      sbomRef: "oci://registry.internal/sbom/claude-code-2.1.14.spdx.json",
      scan: "PASS",
      discoveredAt: now,
    };
    const codexVersion: AgentVersionRecord = {
      id: "codex-cli@0.91.0",
      agent: "codex-cli",
      version: "0.91.0",
      state: "APPROVED",
      source: "https://github.com/openai/codex",
      integrity: `sha256:${"2".repeat(64)}`,
      signatureVerified: true,
      sbomRef: "oci://registry.internal/sbom/codex-cli-0.91.0.spdx.json",
      scan: "PASS",
      discoveredAt: now,
    };
    this.versions.set(claudeVersion.id, claudeVersion);
    this.versions.set(codexVersion.id, codexVersion);

    const credential: CredentialVersionRecord = {
      id: "credential-platform-claude-v1",
      familyId: "credential-platform-claude",
      version: 1,
      label: "Platform Claude gateway key",
      scope: "platform",
      scopeId: "global",
      secretRef: "vault://kv/data/deviludo/platform/claude?version=1",
      maskedFingerprint: "sha256:managed0…000001",
      state: "ACTIVE",
      createdAt: now,
      lastUsedAt: null,
    };
    const installation: InstallationRecord = {
      id: "claude-code-installation-2-1-14",
      agent: "claude-code",
      agentVersionId: claudeVersion.id,
      workerPool: "development-linux-primary",
      imageDigest: `sha256:${"a".repeat(64)}`,
      adapterVersion: "1.0.0",
      state: "ACTIVE",
      rolloutPercent: 100,
      previousRolloutPercent: 25,
      selfUpdateDisabled: true,
      createdAt: now,
    };
    const provider: ProviderRevisionRecord = {
      id: "provider-platform-claude-r1",
      revision: 1,
      agent: "claude-code",
      protocol: "anthropic-messages",
      baseUrl: "https://gateway.anthropic.com/",
      models: {
        primaryModel: "claude-sonnet-4-6-20250514",
        planningModel: "claude-sonnet-4-6-20250514",
        smallFastModel: "claude-sonnet-4-6-20250514",
        subagentModel: "claude-sonnet-4-6-20250514",
      },
      credentialVersionId: credential.id,
      state: "ACTIVE",
      probe: {
        authentication: "PASS",
        modelExistence: "PASS",
        streaming: "PASS",
        toolCalling: "PASS",
        cancellation: "PASS",
        usage: "PASS",
        timeout: "PASS",
      },
      governance: {
        dataRegion: "vendor-managed",
        retentionPolicy: "platform-approved",
        trainingPolicy: "no-training",
        confirmedBy: "bootstrap",
        confirmedAt: now,
      },
    };
    const profile: ProfileRevisionRecord = {
      id: "profile-platform-claude-r1",
      revision: 1,
      scope: "platform",
      scopeId: "global",
      agent: "claude-code",
      installationId: installation.id,
      providerRevisionId: provider.id,
      credentialVersionId: credential.id,
      budget: { maxUsd: 25, maxTurns: 100, timeoutSeconds: 7200 },
      fallbackProfileRevisionId: null,
      state: "ACTIVE",
      createdAt: now,
    };
    this.credentials.set(credential.id, credential);
    this.installations.set(installation.id, installation);
    this.providers.set(provider.id, provider);
    this.profiles.set(profile.id, profile);
    this.defaults.set("platform", profile.id);
  }
}

Injectable()(AdminStore);

const REDACTED_KEY = /(api[-_]?key|secret|password|token|authorization|credential)/i;

function redact(value: Readonly<Record<string, unknown>>): Record<string, unknown> {
  return Object.fromEntries(
    Object.entries(value).map(([key, child]) => [
      key,
      REDACTED_KEY.test(key) ? "[REDACTED]" : redactValue(child),
    ]),
  );
}

function redactValue(value: unknown): unknown {
  if (Array.isArray(value)) return value.map(redactValue);
  if (value && typeof value === "object") return redact(value as Record<string, unknown>);
  return value;
}
