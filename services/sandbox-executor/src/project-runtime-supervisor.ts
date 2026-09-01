import { createHash } from "node:crypto";
import { cp, mkdir, readFile, rm, writeFile } from "node:fs/promises";
import { dirname, join, resolve, sep } from "node:path";
import type {
  ProjectRuntimeControlRequest,
  ProjectRuntimeEnsureRequest,
  ProjectRuntimeProgressEvent,
  ProjectRuntimeStatus,
  ProjectRuntimeTurnRequest,
  ProjectRuntimeTurnResult,
} from "@/lib/product/project-runtime";
import {
  MAX_PROJECT_RUNTIME_ATTACHMENT_PATHS,
  MAX_PROJECT_RUNTIME_PROMPT_CHARS,
} from "@/lib/product/project-runtime";

type DockerOptions = Readonly<{
  signal?: AbortSignal;
  onStderr?: (chunk: string) => void;
}>;
type Docker = (
  arguments_: readonly string[],
  timeout: number,
  input?: Buffer,
  options?: DockerOptions,
) => Promise<string>;
type SecretResolver = (reference: string) => Promise<string>;

export class ProjectRuntimeSupervisor {
  private readonly activeTurns = new Map<string, Readonly<{
    controller: AbortController;
    settled: Promise<void>;
  }>>();

  constructor(private readonly options: Readonly<{
    docker: Docker;
    resolveSecret: SecretResolver;
    executorId: string;
    projectsRoot: string;
    projectsVolume: string;
    agentNetwork: string;
    egressProxy: string;
    mcpGateway: string;
    codexModelsCacheFile?: string;
    allowlistedImages: ReadonlySet<string>;
  }>) {}

  async ensure(request: ProjectRuntimeEnsureRequest): Promise<ProjectRuntimeStatus> {
    validateEnsure(request, this.options.allowlistedImages);
    validateProjectsVolume(this.options.projectsVolume);
    const name = runtimeName(this.options.projectsVolume, request.workspaceId, request.projectId);
    const runtimeImageId = await this.imageId(request.runtimeImage);
    const existing = await this.inspect(name);
    if (existing && (existing.generation !== request.generation
      || existing.fencingToken !== request.fencingToken
      || existing.runtime !== request.runtime
      || existing.imageId !== runtimeImageId)) {
      this.abortProjectTurns(request.workspaceId, request.projectId);
      await this.destroyExisting(name, request.projectId);
    } else if (existing?.state === "FAILED") {
      await this.destroyExisting(name, request.projectId);
    } else if (existing) {
      if (existing.state === "PAUSED") await this.options.docker(["unpause", name], 30_000);
      return this.status(request);
    }

    await this.prepareWorktree(request);
    const runtimeVolume = runtimeVolumeName(this.options.projectsVolume, request.projectId);
    await this.options.docker([
      "volume", "create",
      "--label", "deviludo.kind=project-runtime-state",
      "--label", `deviludo.projects-volume=${this.options.projectsVolume}`,
      runtimeVolume,
    ], 30_000);
    await this.options.docker([
      "run", "--rm", "--network=none", "--read-only", "--cap-drop=ALL",
      "--cap-add=CHOWN", "--cap-add=FOWNER", "--user=0:0",
      "--mount", `type=volume,src=${runtimeVolume},dst=/var/lib/deviludo-runtime`,
      "--entrypoint", "/usr/local/bin/deviludo-runtime-volume-init",
      request.runtimeImage,
    ], 30_000);
    const projectPrefix = "/workspace/project";
    const projectSubpath = `workspaces/${request.workspaceId}/projects/${request.projectId}`;
    const args = [
      "create", "--name", name, "--read-only", "--cap-drop=ALL",
      "--security-opt=no-new-privileges", "--pids-limit=512", "--memory=6g", "--cpus=2.00",
      "--tmpfs=/run/deviludo:rw,noexec,nosuid,nodev,size=256m,mode=0700,uid=10001,gid=10001",
      "--tmpfs=/tmp:rw,noexec,nosuid,nodev,size=256m,mode=0700,uid=10001,gid=10001",
      // Runtime owns its private state by UID, while project source is shared
      // through the Core/Executor project group for validated checkpoints and
      // generated-asset cleanup.
      "--user=10001:1001", "--group-add=1001", `--network=${this.options.agentNetwork}`,
      "--mount", `type=volume,src=${this.options.projectsVolume},dst=${projectPrefix},volume-subpath=${projectSubpath}`,
      "--mount", `type=volume,src=${runtimeVolume},dst=/var/lib/deviludo-runtime`,
      "--workdir", `${projectPrefix}/runtime/worktree`,
      "--env", `DEVILUDO_AGENT_RUNTIME=${request.runtime}`,
      "--env", `DEVILUDO_WORKSPACE_ID=${request.workspaceId}`,
      "--env", `DEVILUDO_PROJECT_ID=${request.projectId}`,
      "--env", "DEVILUDO_RUNTIME_STATE_ROOT=/var/lib/deviludo-runtime",
      "--env", `DEVILUDO_PROJECT_SOURCE_DIR=${projectPrefix}/runtime/worktree`,
      "--env", `DEVILUDO_PROJECT_CONTEXT_FILE=${projectPrefix}/context/project-context.json.zst`,
      "--env", `DEVILUDO_MCP_GATEWAY=${this.options.mcpGateway}`,
      "--env", `HTTPS_PROXY=${this.options.egressProxy}`,
      "--env", `HTTP_PROXY=${this.options.egressProxy}`,
      "--env", "NO_PROXY=core-api,127.0.0.1,localhost",
      "--label", "deviludo.managed=true",
      "--label", "deviludo.kind=project-runtime",
      "--label", `deviludo.executor=${this.options.executorId}`,
      "--label", `deviludo.workspace=${request.workspaceId}`,
      "--label", `deviludo.project=${request.projectId}`,
      "--label", `deviludo.generation=${request.generation}`,
      "--label", `deviludo.fencing=${request.fencingToken}`,
      "--label", `deviludo.runtime=${request.runtime}`,
      "--label", `deviludo.projects-volume=${this.options.projectsVolume}`,
      "--entrypoint", "/usr/local/bin/deviludo-project-runtime",
      request.runtimeImage,
    ];
    await this.options.docker(args, 60_000);
    try {
      await this.options.docker(["start", name], 60_000);
    } catch (error) {
      await this.destroyExisting(name, request.projectId).catch(() => undefined);
      throw error;
    }
    return this.status(request);
  }

  async turn(
    request: ProjectRuntimeTurnRequest,
    onEvent?: (event: ProjectRuntimeProgressEvent) => void,
    signal?: AbortSignal,
  ): Promise<ProjectRuntimeTurnResult> {
    validateTurn(request, this.options.allowlistedImages);
    await this.ensure({
      schemaVersion: request.schemaVersion,
      workspaceId: request.workspaceId,
      projectId: request.projectId,
      generation: request.generation,
      fencingToken: request.fencingToken,
      runtime: request.runtime,
      runtimeImage: request.runtimeImage,
      sourceRelativePath: request.sourceRelativePath,
      contextRelativePath: contextRelativePath(request.workspaceId, request.projectId),
    });
    const key = request.mode === "READ_ONLY_BRANCH"
      ? `${request.workspaceId}:${request.projectId}:${request.turnId}`
      : `${request.workspaceId}:${request.projectId}:${request.role}:PRIMARY`;
    if (this.activeTurns.has(key)) throw new Error(`${request.role} Runtime session already has an active primary turn`);
    const controller = new AbortController();
    let settle = () => {};
    const settled = new Promise<void>(resolve => { settle = resolve; });
    const abort = () => controller.abort();
    signal?.addEventListener("abort", abort, { once: true });
    if (signal?.aborted) controller.abort();
    this.activeTurns.set(key, Object.freeze({ controller, settled }));
    const name = runtimeName(this.options.projectsVolume, request.workspaceId, request.projectId);
    try {
      const provider = Buffer.from(await this.options.resolveSecret(request.credentialRef));
      await this.inject(name, request.turnId, "provider", provider);
      await this.inject(name, request.turnId, "mcp", Buffer.from(request.mcpToken));
      if (request.runtime === "CODEX_CLI"
        && new URL(request.baseUrl).hostname === "chatgpt.com"
        && this.options.codexModelsCacheFile) {
        const modelsCache = await readFile(this.options.codexModelsCacheFile);
        if (modelsCache.length < 2 || modelsCache.length > 8 * 1024 * 1024) {
          throw new Error("Codex models cache file is invalid");
        }
        await this.inject(name, request.turnId, "models", modelsCache);
      }
      const safeRequest = Buffer.from(JSON.stringify({ ...request, credentialRef: undefined, mcpToken: undefined }));
      const output = await this.dockerTurn(name, request, safeRequest, controller.signal, onEvent);
      const result = JSON.parse(output) as ProjectRuntimeTurnResult;
      return validateTurnResult(result, request);
    } finally {
      signal?.removeEventListener("abort", abort);
      this.activeTurns.delete(key);
      settle();
      await this.options.docker(["exec", name, "rm", "-rf", `/run/deviludo/${request.turnId}`], 10_000).catch(() => undefined);
    }
  }

  async pause(request: ProjectRuntimeControlRequest): Promise<ProjectRuntimeStatus> {
    validateControl(request);
    const prefix = `${request.workspaceId}:${request.projectId}:`;
    if ([...this.activeTurns.keys()].some(key => key.startsWith(prefix))) throw new Error("Project Runtime cannot pause during an active turn");
    await this.assertCurrent(request);
    await this.options.docker(["pause", runtimeName(this.options.projectsVolume, request.workspaceId, request.projectId)], 30_000);
    return this.status(request);
  }

  async resume(request: ProjectRuntimeControlRequest): Promise<ProjectRuntimeStatus> {
    validateControl(request);
    await this.assertCurrent(request);
    const status = await this.status(request);
    if (status.state === "PAUSED") await this.options.docker(["unpause", runtimeName(this.options.projectsVolume, request.workspaceId, request.projectId)], 30_000);
    return this.status(request);
  }

  async cancel(request: ProjectRuntimeControlRequest): Promise<ProjectRuntimeStatus> {
    validateControl(request);
    await this.assertCurrent(request);
    const prefix = `${request.workspaceId}:${request.projectId}:`;
    const active = [...this.activeTurns.entries()].filter(([key]) => key.startsWith(prefix));
    for (const [, turn] of active) turn.controller.abort();
    await Promise.allSettled(active.map(([, turn]) => turn.settled));
    return this.status(request);
  }

  async destroy(request: ProjectRuntimeControlRequest): Promise<ProjectRuntimeStatus> {
    validateControl(request);
    const name = runtimeName(this.options.projectsVolume, request.workspaceId, request.projectId);
    const current = await this.inspect(name);
    // Destroy is intentionally idempotent. Core can retain a container record
    // briefly after Docker has already removed the physical Runtime, and that
    // state must not prevent the project itself from being deleted. Preserve
    // fencing when a container does exist so a stale request cannot destroy a
    // newer Runtime generation.
    if (current && (current.generation !== request.generation || current.fencingToken !== request.fencingToken)) {
      throw new Error("Project Runtime generation or fencing token is stale");
    }
    this.abortProjectTurns(request.workspaceId, request.projectId);
    await this.destroyExisting(name, request.projectId);
    return destroyedStatus(request);
  }

  async status(request: ProjectRuntimeControlRequest): Promise<ProjectRuntimeStatus> {
    validateControl(request);
    const inspected = await this.inspect(runtimeName(this.options.projectsVolume, request.workspaceId, request.projectId));
    if (!inspected) return destroyedStatus(request);
    if (inspected.generation !== request.generation || inspected.fencingToken !== request.fencingToken) {
      throw new Error("Project Runtime generation or fencing token is stale");
    }
    return Object.freeze({
      workspaceId: request.workspaceId,
      projectId: request.projectId,
      generation: inspected.generation,
      fencingToken: inspected.fencingToken,
      state: inspected.state,
      runtime: inspected.runtime,
      containerId: inspected.containerId,
      activeRole: null,
      activeTurnId: null,
      lastActivityAt: new Date().toISOString(),
      pausedAt: inspected.state === "PAUSED" ? new Date().toISOString() : null,
      contextRevision: 0,
      contextSha256: "sha256:" + "0".repeat(64),
    });
  }

  async list(): Promise<readonly Readonly<Record<string, unknown>>[]> {
    const raw = await this.options.docker([
      "ps", "-aq", "--filter", "label=deviludo.kind=project-runtime",
      "--filter", `label=deviludo.executor=${this.options.executorId}`,
    ], 30_000);
    const records: Readonly<Record<string, unknown>>[] = [];
    for (const id of raw.split("\n").map(value => value.trim()).filter(Boolean)) {
      const inspected = await this.inspectByReference(id);
      if (inspected) records.push(Object.freeze(inspected));
    }
    return Object.freeze(records);
  }

  private async prepareWorktree(request: ProjectRuntimeEnsureRequest): Promise<void> {
    const projectRoot = resolve(this.options.projectsRoot, "workspaces", request.workspaceId, "projects", request.projectId);
    assertWithin(this.options.projectsRoot, projectRoot);
    const worktree = join(projectRoot, "runtime", "worktree");
    const marker = join(projectRoot, "runtime", "source.json");
    await mkdir(dirname(worktree), { recursive: true, mode: 0o770 });
    let current: { sourceRelativePath?: string | null } | null = null;
    try { current = JSON.parse(await readFile(marker, "utf8")); } catch { current = null; }
    if (current?.sourceRelativePath === request.sourceRelativePath) return;
    await rm(worktree, { recursive: true, force: true });
    await mkdir(worktree, { recursive: true, mode: 0o770 });
    if (request.sourceRelativePath) {
      const source = resolve(this.options.projectsRoot, request.sourceRelativePath);
      assertWithin(this.options.projectsRoot, source);
      await cp(source, worktree, { recursive: true, force: false, errorOnExist: true });
    }
    await writeFile(marker, JSON.stringify({ sourceRelativePath: request.sourceRelativePath }), { mode: 0o660 });
  }

  private async inject(name: string, turnId: string, target: "provider" | "mcp" | "models", value: Buffer): Promise<void> {
    await this.options.docker(["exec", "-i", name, "/usr/local/bin/deviludo-runtime-io", target, turnId], 30_000, value);
  }

  private async dockerTurn(
    name: string,
    request: ProjectRuntimeTurnRequest,
    input: Buffer,
    signal: AbortSignal,
    onEvent?: (event: ProjectRuntimeProgressEvent) => void,
  ): Promise<string> {
    let stderr = "";
    try {
      return await this.options.docker([
        "exec", "-i",
        "--env", `DEVILUDO_AGENT_ROLE=${request.role}`,
        "--env", `DEVILUDO_AGENT_TURN_ID=${request.turnId}`,
        "--env", `DEVILUDO_PROVIDER_CREDENTIAL_FILE=/run/deviludo/${request.turnId}/provider-credential`,
        "--env", `DEVILUDO_MCP_TOKEN_FILE=/run/deviludo/${request.turnId}/mcp-token`,
        name, "/usr/local/bin/deviludo-project-turn",
      ], 86_400_000, input, {
        signal,
        onStderr: chunk => {
          stderr += chunk;
          const lines = stderr.split(/\r?\n/);
          stderr = lines.pop() ?? "";
          for (const line of lines) {
            const event = runtimeProgressEvent(line);
            if (event && (event.kind !== "CONTENT_DELTA" || request.mode === "READ_ONLY_BRANCH")) onEvent?.(event);
          }
        },
      });
    } catch (error) {
      const logs = await this.options.docker(["logs", "--tail", "40", name], 10_000).catch(() => "");
      const message = error instanceof Error ? error.message : String(error);
      throw new Error(logs.trim() ? `${message}; Runtime startup log: ${logs.trim().slice(-2_000)}` : message);
    }
  }

  private async assertCurrent(request: ProjectRuntimeControlRequest): Promise<void> {
    const status = await this.inspect(runtimeName(this.options.projectsVolume, request.workspaceId, request.projectId));
    if (!status) throw new Error("Project Runtime container does not exist");
    if (status.generation !== request.generation || status.fencingToken !== request.fencingToken) {
      throw new Error("Project Runtime generation or fencing token is stale");
    }
  }

  private async inspect(name: string): Promise<Readonly<{
    containerId: string;
    imageId: string;
    generation: number;
    fencingToken: number;
    runtime: "CLAUDE_CODE" | "CODEX_CLI";
    state: "RUNNING" | "PAUSED" | "FAILED";
  }> | null> {
    const inspected = await this.inspectByReference(name);
    if (!inspected) return null;
    return Object.freeze({
      containerId: String(inspected.containerId),
      imageId: String(inspected.imageId),
      generation: Number(inspected.generation),
      fencingToken: Number(inspected.fencingToken),
      runtime: inspected.runtime as "CLAUDE_CODE" | "CODEX_CLI",
      state: inspected.state as "RUNNING" | "PAUSED" | "FAILED",
    });
  }

  private async inspectByReference(reference: string): Promise<Readonly<Record<string, unknown>> | null> {
    let raw: string;
    try { raw = await this.options.docker(["inspect", reference], 30_000); } catch { return null; }
    const item = JSON.parse(raw)?.[0];
    const labels = item?.Config?.Labels ?? {};
    if (labels["deviludo.kind"] !== "project-runtime" || labels["deviludo.executor"] !== this.options.executorId) return null;
    return Object.freeze({
      containerId: String(item.Id),
      imageId: String(item.Image),
      workspaceId: String(labels["deviludo.workspace"]),
      projectId: String(labels["deviludo.project"]),
      generation: Number(labels["deviludo.generation"]),
      fencingToken: Number(labels["deviludo.fencing"]),
      runtime: labels["deviludo.runtime"],
      state: item.State?.Paused ? "PAUSED" : item.State?.Running ? "RUNNING" : "FAILED",
    });
  }

  private async imageId(reference: string): Promise<string> {
    const raw = await this.options.docker(["image", "inspect", reference], 30_000);
    const id = JSON.parse(raw)?.[0]?.Id;
    if (typeof id !== "string" || !/^sha256:[0-9a-f]{64}$/i.test(id)) {
      throw new Error("Project Runtime image identity is invalid");
    }
    return id;
  }

  private abortProjectTurns(workspaceId: string, projectId: string): void {
    const prefix = `${workspaceId}:${projectId}:`;
    for (const [key, turn] of this.activeTurns) if (key.startsWith(prefix)) turn.controller.abort();
  }

  private async destroyExisting(name: string, projectId: string): Promise<void> {
    await this.options.docker(["rm", "-f", "-v", name], 30_000).catch(() => undefined);
    await this.options.docker(["volume", "rm", "-f", runtimeVolumeName(this.options.projectsVolume, projectId)], 30_000).catch(() => undefined);
  }
}

export function runtimeProgressEvent(
  line: string,
): ProjectRuntimeProgressEvent | null {
  const prefix = "DEVILUDO_RUNTIME_EVENT:";
  if (!line.startsWith(prefix)) return null;
  const content = line.slice(prefix.length);
  try {
    const event = JSON.parse(content) as Record<string, unknown>;
    const eventType = typeof event.type === "string" ? event.type : "";
    if (eventType === "deviludo.content_delta" && typeof event.delta === "string" && event.delta) {
      return progressEvent("CONTENT_DELTA", event.delta);
    }
    // Every provider JSONL record is forwarded byte-for-byte (apart from the
    // transport prefix and restored line ending). Presentation belongs to the
    // conversation UI; the Runtime bridge must not summarize or redact it.
    return progressEvent("RUNTIME_OUTPUT", `${content}\n`);
  } catch {
    // Preserve malformed provider output too. The final signed Runtime result
    // remains independently validated, while live output stays lossless.
    return progressEvent("RUNTIME_OUTPUT", `${content}\n`);
  }
}

function progressEvent(kind: ProjectRuntimeProgressEvent["kind"], content: string): ProjectRuntimeProgressEvent {
  return Object.freeze({ kind, content });
}

function validateEnsure(value: ProjectRuntimeEnsureRequest, images: ReadonlySet<string>): void {
  validateControl(value);
  if (!["CLAUDE_CODE", "CODEX_CLI"].includes(value.runtime) || !images.has(value.runtimeImage)
    || value.contextRelativePath !== contextRelativePath(value.workspaceId, value.projectId)
    || (value.sourceRelativePath !== null && !value.sourceRelativePath.startsWith(`workspaces/${value.workspaceId}/projects/${value.projectId}/revisions/`))) {
    throw new Error("Project Runtime ensure request is invalid");
  }
}

function validateTurn(value: ProjectRuntimeTurnRequest, images: ReadonlySet<string>): void {
  validateControl(value);
  if (!["INTENT", "ANALYSIS", "DESIGN", "UI_DESIGN", "DEVELOPMENT", "TEST"].includes(value.role)
    || !["PRIMARY", "READ_ONLY_BRANCH", "COMPACT"].includes(value.mode)
    || !["CLAUDE_CODE", "CODEX_CLI"].includes(value.runtime) || !images.has(value.runtimeImage)
    || !/^[0-9a-f-]{36}$/i.test(value.turnId) || !/^[A-Za-z0-9_-]{24,256}$/.test(value.leaseToken)
    || Date.parse(value.leaseExpiresAt) <= Date.now()
    || !/^[A-Za-z0-9_-]{32,512}$/.test(value.mcpToken)
    || !value.credentialRef.startsWith("vault://instance/agent-runtime/api-key/versions/")
    || !Array.isArray(value.attachmentPaths)
    || value.attachmentPaths.length > MAX_PROJECT_RUNTIME_ATTACHMENT_PATHS
    || value.attachmentPaths.some(path => typeof path !== "string"
      || !path.startsWith(`/workspace/project/runtime/attachments/${value.turnId}/`)
      || !/\.(?:png|jpg|webp)$/.test(path))
    || typeof value.prompt !== "string" || value.prompt.length < 1
    || value.prompt.length > MAX_PROJECT_RUNTIME_PROMPT_CHARS) {
    throw new Error("Project Runtime turn request is invalid");
  }
}

function validateTurnResult(
  value: ProjectRuntimeTurnResult,
  request: ProjectRuntimeTurnRequest,
): ProjectRuntimeTurnResult {
  let structuredBytes = 0;
  try { structuredBytes = Buffer.byteLength(JSON.stringify(value.structured)); } catch { structuredBytes = Number.POSITIVE_INFINITY; }
  if (!value || value.schemaVersion !== request.schemaVersion || value.turnId !== request.turnId
    || value.role !== request.role || value.mode !== request.mode
    || typeof value.content !== "string" || Buffer.byteLength(value.content) > 1_048_576
    || !value.structured || typeof value.structured !== "object" || Array.isArray(value.structured)
    || structuredBytes > 262_144
    || !Array.isArray(value.toolCalls) || value.toolCalls.length > 1_000
    || typeof value.sessionId !== "string" || value.sessionId.length < 1 || value.sessionId.length > 512
    || (value.branchId !== null && (typeof value.branchId !== "string" || value.branchId.length > 512))
    || !Number.isFinite(Date.parse(value.startedAt)) || !Number.isFinite(Date.parse(value.completedAt))) {
    throw new Error("Project Runtime returned an invalid turn result");
  }
  return Object.freeze(value);
}

function validateControl(value: ProjectRuntimeControlRequest): void {
  if (!value || value.schemaVersion !== "deviludo.project-runtime.v2"
    || !["CLAUDE_CODE", "CODEX_CLI"].includes(value.runtime)
    || !/^[0-9a-f-]{36}$/i.test(value.workspaceId) || !/^[0-9a-f-]{36}$/i.test(value.projectId)
    || !Number.isSafeInteger(value.generation) || value.generation < 1
    || !Number.isSafeInteger(value.fencingToken) || value.fencingToken < 1) {
    throw new Error("Project Runtime control request is invalid");
  }
}

function runtimeName(projectsVolume: string, workspaceId: string, projectId: string): string {
  return `deviludo-project-${runtimeScope(projectsVolume)}-${workspaceId.slice(0, 8)}-${projectId}`;
}

function runtimeVolumeName(projectsVolume: string, projectId: string): string {
  return `deviludo-runtime-${runtimeScope(projectsVolume)}-${projectId}`;
}

function runtimeScope(projectsVolume: string): string {
  return createHash("sha256").update(projectsVolume).digest("hex").slice(0, 12);
}

function validateProjectsVolume(value: string): void {
  if (!/^[A-Za-z0-9][A-Za-z0-9_.-]{0,127}$/.test(value)) {
    throw new Error("Project Runtime projects volume name is invalid");
  }
}

function contextRelativePath(workspaceId: string, projectId: string): string {
  return `workspaces/${workspaceId}/projects/${projectId}/context/project-context.json.zst`;
}

function destroyedStatus(request: ProjectRuntimeControlRequest): ProjectRuntimeStatus {
  return Object.freeze({
    ...request,
    state: "DESTROYED",
    runtime: request.runtime,
    containerId: null,
    activeRole: null,
    activeTurnId: null,
    lastActivityAt: new Date().toISOString(),
    pausedAt: null,
    contextRevision: 0,
    contextSha256: "sha256:" + "0".repeat(64),
  });
}

function assertWithin(root: string, target: string): void {
  const normalizedRoot = resolve(root);
  if (target !== normalizedRoot && !target.startsWith(`${normalizedRoot}${sep}`)) throw new Error("Project Runtime path escapes the projects root");
}
