import type { AgentKind, ProbePlan } from "../../../lib/agent/types";
import { CliInstallationVerifier } from "../../agent-worker/src/installation-verifier";
import type { LocalAgentReadiness, LocalAgentRuntimeHealth } from "./contracts";

const EXACT_VERSION = /^\d+\.\d+\.\d+(?:-[0-9A-Za-z.-]+)?$/;

export interface CliVersionInspector {
  inspect(executable: ProbePlan["executable"]): Promise<string>;
}

export class LocalAgentReadinessService {
  readonly #inspector: CliVersionInspector;
  readonly #catalog: readonly { agent: AgentKind; executable: ProbePlan["executable"]; expectedVersion: string }[];
  readonly #executionEnabled: boolean;
  readonly #gatewayConfigured: boolean;
  readonly #workerImageIdentity: string | null;
  readonly #expectedWorkerImageIdentity: string | null;

  constructor(options: {
    readonly inspector?: CliVersionInspector;
    readonly claudeVersion?: string;
    readonly codexVersion?: string;
    readonly executionEnabled?: boolean;
    readonly inferenceGatewayUrl?: string;
    readonly workerImageIdentity?: string;
    readonly expectedWorkerImageIdentity?: string;
  } = {}) {
    const claudeVersion = options.claudeVersion ?? "2.1.14";
    const codexVersion = options.codexVersion ?? "0.91.0";
    for (const version of [claudeVersion, codexVersion]) {
      if (!EXACT_VERSION.test(version) || /latest|stable|default/i.test(version)) throw new Error("Local Agent readiness requires exact versions");
    }
    this.#inspector = options.inspector ?? new CliInstallationVerifier();
    this.#catalog = Object.freeze([
      Object.freeze({ agent: "claude-code" as const, executable: "claude" as const, expectedVersion: claudeVersion }),
      Object.freeze({ agent: "codex-cli" as const, executable: "codex" as const, expectedVersion: codexVersion }),
    ]);
    this.#executionEnabled = options.executionEnabled === true;
    this.#gatewayConfigured = isSecureGatewayOrigin(options.inferenceGatewayUrl);
    this.#workerImageIdentity = exactDigest(options.workerImageIdentity);
    this.#expectedWorkerImageIdentity = exactDigest(options.expectedWorkerImageIdentity);
  }

  async health(): Promise<LocalAgentRuntimeHealth> {
    const agents = await Promise.all(this.#catalog.map((entry) => this.#inspect(entry)));
    const workerImageVerified = this.#workerImageIdentity !== null
      && this.#workerImageIdentity === this.#expectedWorkerImageIdentity;
    const ready = agents.some((entry) => entry.state === "READY")
      && this.#executionEnabled
      && this.#gatewayConfigured
      && workerImageVerified;
    return Object.freeze({
      status: ready ? "ok" : "degraded",
      service: "deviludo-local-agent-runtime",
      executionEnabled: this.#executionEnabled,
      inferenceGateway: this.#gatewayConfigured ? "CONFIGURED" : "NOT_CONFIGURED",
      workerImageIdentity: this.#workerImageIdentity,
      expectedWorkerImageIdentity: this.#expectedWorkerImageIdentity,
      workerImageVerified,
      agents: Object.freeze(agents),
    });
  }

  async #inspect(entry: { agent: AgentKind; executable: ProbePlan["executable"]; expectedVersion: string }): Promise<LocalAgentReadiness> {
    try {
      const observedVersion = await this.#inspector.inspect(entry.executable);
      return Object.freeze({
        ...entry,
        observedVersion,
        state: observedVersion === entry.expectedVersion ? "READY" : "VERSION_MISMATCH",
      });
    } catch {
      return Object.freeze({ ...entry, observedVersion: null, state: "UNAVAILABLE" });
    }
  }
}

function exactDigest(value: string | undefined): string | null {
  return value && /^sha256:[a-f0-9]{64}$/.test(value) ? value : null;
}

function isSecureGatewayOrigin(value: string | undefined): boolean {
  if (!value) return false;
  try {
    const url = new URL(value);
    return url.protocol === "https:"
      && Boolean(url.hostname)
      && !url.username
      && !url.password
      && !url.search
      && !url.hash;
  } catch {
    return false;
  }
}
