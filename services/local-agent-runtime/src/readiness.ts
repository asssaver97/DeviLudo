import type { AgentKind, ProbePlan } from "../../../lib/agent/types";
import { assertPinnedModelId } from "../../../lib/agent/providers";
import { localWorkerImageDigest } from "../../../lib/agent/local-worker-identity";
import { builtInAdapterVersion } from "../../../lib/agent/adapter-registry";
import { CliInstallationVerifier } from "../../agent-worker/src/installation-verifier";
import type { LocalAgentPreflightRequest, LocalAgentPreflightResult, LocalAgentReadiness, LocalAgentRuntimeHealth, LocalProviderBindingVerifier } from "./contracts";

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
  readonly #localDeterministicWorkerAttestation: boolean;
  readonly #providerBindingVerifier: LocalProviderBindingVerifier | null;

  constructor(options: {
    readonly inspector?: CliVersionInspector;
    readonly claudeVersion?: string;
    readonly codexVersion?: string;
    readonly executionEnabled?: boolean;
    readonly inferenceGatewayUrl?: string;
    readonly workerImageIdentity?: string;
    readonly expectedWorkerImageIdentity?: string;
    readonly localDeterministicWorkerAttestation?: boolean;
    readonly providerBindingVerifier?: LocalProviderBindingVerifier;
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
    this.#localDeterministicWorkerAttestation = options.localDeterministicWorkerAttestation === true;
    this.#providerBindingVerifier = options.providerBindingVerifier ?? null;
  }

  async health(): Promise<LocalAgentRuntimeHealth> {
    const agents = await Promise.all(this.#catalog.map((entry) => this.#inspect(entry)));
    const pinnedWorkerImageVerified = this.#workerImageIdentity !== null
      && this.#workerImageIdentity === this.#expectedWorkerImageIdentity;
    const workerImageVerified = pinnedWorkerImageVerified || this.#localDeterministicWorkerAttestation;
    const workerIdentityMode = this.#localDeterministicWorkerAttestation
      ? "LOCAL_DETERMINISTIC" as const
      : pinnedWorkerImageVerified ? "PINNED_ENV" as const : "NOT_CONFIGURED" as const;
    const ready = agents.some((entry) => entry.state === "READY")
      && this.#executionEnabled
      && this.#gatewayConfigured
      && this.#providerBindingVerifier !== null
      && workerImageVerified;
    return Object.freeze({
      status: ready ? "ok" : "degraded",
      service: "deviludo-local-agent-runtime",
      executionEnabled: this.#executionEnabled,
      inferenceGateway: this.#gatewayConfigured ? "CONFIGURED" : "NOT_CONFIGURED",
      providerBindingProbe: this.#providerBindingVerifier ? "CONFIGURED" : "NOT_CONFIGURED",
      workerImageIdentity: this.#workerImageIdentity,
      expectedWorkerImageIdentity: this.#expectedWorkerImageIdentity,
      workerImageVerified,
      workerIdentityMode,
      agents: Object.freeze(agents),
    });
  }

  async preflight(request: LocalAgentPreflightRequest): Promise<LocalAgentPreflightResult> {
    validatePreflightRequest(request);
    const health = await this.health();
    const installation = health.agents.find((entry) => entry.agent === request.agent);
    if (!installation || installation.state === "UNAVAILABLE") {
      return preflightResult(request, installation?.observedVersion ?? null, "INSTALLATION_UNAVAILABLE", "锁定的 Agent CLI 在本机不可用。");
    }
    if (installation.observedVersion !== request.expectedVersion) {
      return preflightResult(request, installation.observedVersion, "INSTALLATION_MISMATCH", "本机 CLI 版本与任务锁定版本不一致，禁止启动。");
    }
    if (builtInAdapterVersion(request.agent) !== request.adapterVersion) {
      return preflightResult(request, installation.observedVersion, "ADAPTER_MISMATCH", "本机运行服务编译的 Adapter 版本与任务锁定版本不一致，禁止启动。");
    }
    if (!await this.#workerIdentityMatches(request, health)) {
      return preflightResult(request, installation.observedVersion, "WORKER_IMAGE_MISMATCH", "本机 WorkerImage 身份未与任务锁定 digest 完成匹配。");
    }
    if (health.inferenceGateway !== "CONFIGURED") {
      return preflightResult(request, installation.observedVersion, "WAITING_PROVIDER", "Inference Gateway/Provider 尚未就绪；任务保持原 Profile 锁并等待恢复。");
    }
    if (!this.#providerBindingVerifier || !await this.#verifyProviderBinding(request)) {
      return preflightResult(request, installation.observedVersion, "WAITING_PROVIDER", "锁定 Provider、凭据版本与模型尚未通过 Gateway 探针；任务不会切换 Agent。");
    }
    if (!health.executionEnabled) {
      return preflightResult(request, installation.observedVersion, "EXECUTION_DISABLED", "本地真实 Agent 执行未显式启用。");
    }
    return preflightResult(request, installation.observedVersion, "READY", "所有本地 Agent 启动门禁均已满足。", "READY");
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

  async #verifyProviderBinding(request: LocalAgentPreflightRequest): Promise<boolean> {
    try {
      return await this.#providerBindingVerifier!.verify(request);
    } catch {
      return false;
    }
  }

  async #workerIdentityMatches(request: LocalAgentPreflightRequest, health: LocalAgentRuntimeHealth): Promise<boolean> {
    if (health.workerIdentityMode === "LOCAL_DETERMINISTIC") {
      return await localWorkerImageDigest(request.agent, request.expectedVersion, request.adapterVersion) === request.imageDigest;
    }
    return health.workerIdentityMode === "PINNED_ENV"
      && health.expectedWorkerImageIdentity === request.imageDigest;
  }
}

function validatePreflightRequest(request: LocalAgentPreflightRequest): void {
  for (const value of [request.projectId, request.runId, request.profileRevisionId, request.installationId,
    request.providerRevisionId, request.credentialVersionId]) {
    if (!/^[A-Za-z0-9][A-Za-z0-9._:-]{0,127}$/.test(value)) throw new Error("Local Agent preflight binding is invalid");
  }
  if ((request.agent !== "claude-code" && request.agent !== "codex-cli")
    || !EXACT_VERSION.test(request.expectedVersion)
    || !EXACT_VERSION.test(request.adapterVersion)
    || !/^sha256:[a-f0-9]{64}$/.test(request.imageDigest)) {
    throw new Error("Local Agent preflight lock is invalid");
  }
  assertPinnedModelId(request.model);
  for (const model of Object.values(request.modelRoles)) assertPinnedModelId(model);
  if (request.model !== request.modelRoles.primaryModel) throw new Error("Local Agent primary model binding is inconsistent");
}

function preflightResult(
  request: LocalAgentPreflightRequest,
  observedVersion: string | null,
  code: LocalAgentPreflightResult["code"],
  message: string,
  status: LocalAgentPreflightResult["status"] = "BLOCKED",
): LocalAgentPreflightResult {
  return Object.freeze({
    status,
    code,
    projectId: request.projectId,
    runId: request.runId,
    profileRevisionId: request.profileRevisionId,
    installationId: request.installationId,
    agent: request.agent,
    expectedVersion: request.expectedVersion,
    observedVersion,
    imageDigest: request.imageDigest,
    adapterVersion: request.adapterVersion,
    model: request.model,
    modelRoles: Object.freeze({ ...request.modelRoles }),
    message,
  });
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
