import { execFile } from "node:child_process";
import { createHash, type KeyObject } from "node:crypto";
import { lstat, mkdir, open, readFile, realpath, rm, writeFile } from "node:fs/promises";
import { isAbsolute, join, resolve, sep } from "node:path";
import { canonicalJson } from "../../runner-control/src/canonical";
import { verifyGitHubCandidateArtifact } from "../../scm-proxy/src/github-artifacts";
import type { IsolatedAgentExecutionRequest, IsolatedAgentExecutionResult } from "./contracts";
import { validateIsolatedResult } from "./contracts";
import type { IsolatedAgentExecutionDispatcher } from "./operations";
import type { AgentDevelopmentWorkPackagePort } from "./postgres-work-package";

const SHA256 = /^[a-f0-9]{64}$/;
const MAX_RESPONSE_BYTES = 150 * 1024 * 1024;
const FORBIDDEN_OUTPUT = /api.?key|authorization|bearer|run.?token|secret:\/\/|vault:\/\//i;

export interface AgentBaselineSourcePort {
  materialize(input: Readonly<{ tenantId: string; projectId: string; runId: string; sourceBaselineReceiptId: string;
    commitSha: string; sourceDigest: string; destinationPath: string }>): Promise<Readonly<{ sourceDigest: string }>>;
  probe(): Promise<void>;
}

export interface NativeMicrovmProcessResult { readonly exitCode: number; readonly stdout: string; readonly stderr: string }
export type NativeMicrovmProcess = (executable: string, args: readonly string[], options: Readonly<{
  cwd: string; env: NodeJS.ProcessEnv; timeoutMs: number; maxOutputBytes: number }>) => Promise<NativeMicrovmProcessResult>;

/**
 * Fixed adapter for an audited microVM launcher. The launcher receives one
 * immutable source tree, an internal Gateway URL and an opaque DLRT SecretRef;
 * it never receives the third-party Provider URL or a GitHub credential.
 */
export class LockedNativeMicrovmAgentExecutor implements IsolatedAgentExecutionDispatcher {
  readonly #executable: string;
  readonly #executableDigest: string;
  readonly #configFile: string;
  readonly #configDigest: string;
  readonly #workRoot: string;
  readonly #gatewayUrl: string;
  readonly #timeoutMs: number;
  readonly #attestationKeyId: string;
  readonly #attestationKey: KeyObject;
  readonly #sources: AgentBaselineSourcePort;
  readonly #packages: AgentDevelopmentWorkPackagePort;
  readonly #process: NativeMicrovmProcess;
  readonly #now: () => Date;

  constructor(options: Readonly<{ executable: string; executableDigest: string; configFile: string; configDigest: string;
    workRoot: string; inferenceGatewayUrl: string; timeoutMs?: number; attestationKeyId: string;
    attestationPublicKey: KeyObject; sources: AgentBaselineSourcePort; packages: AgentDevelopmentWorkPackagePort;
    process?: NativeMicrovmProcess; now?: () => Date }>) {
    this.#executable = absolute(options.executable, "executable");
    this.#configFile = absolute(options.configFile, "configuration file");
    this.#workRoot = absolute(options.workRoot, "work root");
    if (!SHA256.test(options.executableDigest) || !SHA256.test(options.configDigest)) invalid("artifact digest");
    this.#executableDigest = options.executableDigest; this.#configDigest = options.configDigest;
    this.#gatewayUrl = gateway(options.inferenceGatewayUrl);
    this.#timeoutMs = integer(options.timeoutMs ?? 15 * 60_000, 60_000, 15 * 60_000);
    if (!/^[A-Za-z0-9][A-Za-z0-9._:-]{2,159}$/.test(options.attestationKeyId)) invalid("attestation key ID");
    const publicKey = options.attestationPublicKey;
    if (publicKey.type !== "public" || publicKey.asymmetricKeyType !== "ed25519") invalid("attestation public key");
    this.#attestationKeyId = options.attestationKeyId; this.#attestationKey = publicKey;
    this.#sources = options.sources; this.#packages = options.packages;
    this.#process = options.process ?? executeNativeMicrovm; this.#now = options.now ?? (() => new Date());
  }

  async execute(input: IsolatedAgentExecutionRequest,
    context: Readonly<{ heartbeat: () => Promise<void> }>): Promise<IsolatedAgentExecutionResult> {
    const packageValue = await this.#packages.resolve(input);
    await context.heartbeat();
    const root = await privateRoot(this.#workRoot);
    const runRoot = boundedChild(root, input.tenantId, input.projectId, input.runId, input.attemptId);
    const controlRoot = join(runRoot, "control"); const workspace = join(runRoot, "workspace");
    await mkdir(controlRoot, { recursive: true, mode: 0o700 });
    const requestFile = join(controlRoot, "request.json"); const responseFile = join(controlRoot, "response.json");
    const request = nativeRequest(input, packageValue, this.#gatewayUrl);
    const requestBytes = Buffer.from(canonicalJson(request));
    await writeImmutable(requestFile, requestBytes);
    const replay = await readResponse(responseFile, controlRoot);
    if (replay) return this.#validate(replay, input);
    await rm(workspace, { recursive: true, force: true });
    const source = await this.#sources.materialize({ tenantId: input.tenantId, projectId: input.projectId,
      runId: input.runId, sourceBaselineReceiptId: input.sourceBaselineReceiptId,
      commitSha: input.baseCommitSha, sourceDigest: input.sourceDigest, destinationPath: workspace });
    if (source.sourceDigest !== input.sourceDigest || await realpath(workspace) !== workspace) invalid("source workspace");
    await context.heartbeat();
    await this.#verifyRuntime();
    const timeoutMs = executionTimeout(input, this.#timeoutMs, this.#now());
    const result = await this.#process(this.#executable, ["execute", "--config-file", this.#configFile,
      "--request-file", requestFile, "--workspace", workspace, "--response-file", responseFile],
    processOptions(runRoot, timeoutMs));
    if (result.exitCode !== 0 || result.stdout || result.stderr
      || FORBIDDEN_OUTPUT.test(`${result.stdout}\n${result.stderr}`)) invalid("execution");
    await context.heartbeat();
    const response = await readResponse(responseFile, controlRoot);
    if (!response) invalid("missing response");
    return this.#validate(response, input);
  }

  async probe(): Promise<void> {
    await Promise.all([this.#sources.probe(), this.#packages.probe(), this.#verifyRuntime()]);
    const result = await this.#process(this.#executable,
      ["probe", "--config-file", this.#configFile, "--json"], processOptions(this.#workRoot, 30_000));
    if (result.exitCode !== 0 || result.stderr || FORBIDDEN_OUTPUT.test(result.stdout)) invalid("probe");
    const body = parseJson(result.stdout);
    if (JSON.stringify(Object.keys(body).sort()) !== '["configDigest","schemaVersion","status"]'
      || body.schemaVersion !== "deviludo.native-agent-microvm-probe.v1" || body.status !== "READY"
      || body.configDigest !== this.#configDigest) invalid("probe");
  }

  async #verifyRuntime(): Promise<void> {
    await Promise.all([verifyFile(this.#executable, this.#executableDigest, 1024 * 1024 * 1024),
      verifyFile(this.#configFile, this.#configDigest, 1024 * 1024), privateRoot(this.#workRoot)]);
  }

  #validate(value: unknown, input: IsolatedAgentExecutionRequest): IsolatedAgentExecutionResult {
    const result = validateIsolatedResult(value, input, input.attemptId);
    if (result.status === "COMPLETED" && (result.candidateArtifact.attestation.keyId !== this.#attestationKeyId
      || !verifyGitHubCandidateArtifact(result.candidateArtifact,
        new Map([[this.#attestationKeyId, this.#attestationKey]])))) invalid("candidate attestation");
    return result;
  }
}

function nativeRequest(input: IsolatedAgentExecutionRequest, work: Awaited<ReturnType<AgentDevelopmentWorkPackagePort["resolve"]>>,
  inferenceGatewayUrl: string) {
  return Object.freeze({ schemaVersion: "deviludo.native-agent-microvm-request.v1", tenantId: input.tenantId,
    projectId: input.projectId, runId: input.runId, attemptId: input.attemptId,
    resolutionDigest: input.resolutionDigest, profileRevisionId: input.profileRevisionId,
    installationId: input.installationId, imageDigest: input.imageDigest, exactAgentVersion: input.exactAgentVersion,
    adapterVersion: input.adapterVersion, agent: input.agent, providerRevisionId: input.providerRevisionId,
    providerProtocol: input.providerProtocol, credentialVersionId: input.credentialVersionId,
    model: input.model, modelRoles: input.modelRoles,
    authorizedModels: Object.freeze([...input.authorizedModels]), budget: input.budget,
    specRevisionId: input.specRevisionId, specDigest: work.specDigest,
    testPlanRevisionId: input.testPlanRevisionId, testPlanDigest: work.testPlanDigest,
    targetMatrix: Object.freeze([...input.targetMatrix]), sourceBaselineReceiptId: input.sourceBaselineReceiptId,
    baseCommitSha: input.baseCommitSha, sourceDigest: input.sourceDigest,
    inferenceGatewayUrl, inferenceTokenSecretRef: input.inferenceTokenSecretRef,
    inferenceTokenExpiresAt: input.inferenceTokenExpiresAt, prompt: work.prompt,
    promptContentDigest: createHash("sha256").update(work.prompt).digest("hex"), promptDigest: work.promptDigest });
}

export function executeNativeMicrovm(executable: string, args: readonly string[], options: Readonly<{
  cwd: string; env: NodeJS.ProcessEnv; timeoutMs: number; maxOutputBytes: number }>): Promise<NativeMicrovmProcessResult> {
  return new Promise((accept) => execFile(executable, [...args], { cwd: options.cwd, env: options.env,
    encoding: "utf8", windowsHide: true, timeout: options.timeoutMs, maxBuffer: options.maxOutputBytes, shell: false },
  (error, stdout, stderr) => accept(Object.freeze({ exitCode: error ? 1 : 0,
    stdout: bounded(stdout, options.maxOutputBytes), stderr: bounded(stderr, options.maxOutputBytes) }))));
}

async function verifyFile(path: string, expectedDigest: string, maximum: number): Promise<void> {
  const metadata = await lstat(path);
  if (!metadata.isFile() || metadata.isSymbolicLink() || metadata.size < 1 || metadata.size > maximum) invalid("runtime file");
  const file = await open(path, "r");
  try {
    const hash = createHash("sha256"); const buffer = Buffer.allocUnsafe(1024 * 1024); let position = 0;
    while (position < metadata.size) { const read = await file.read(buffer, 0, Math.min(buffer.length, metadata.size - position), position);
      if (read.bytesRead < 1) invalid("runtime file"); hash.update(buffer.subarray(0, read.bytesRead)); position += read.bytesRead; }
    const after = await file.stat();
    if (after.size !== metadata.size || after.mtimeMs !== metadata.mtimeMs || hash.digest("hex") !== expectedDigest) invalid("runtime digest");
  } finally { await file.close(); }
}
async function writeImmutable(path: string, bytes: Buffer): Promise<void> {
  try { await writeFile(path, bytes, { flag: "wx", mode: 0o400 }); }
  catch (error) { if ((error as NodeJS.ErrnoException).code !== "EEXIST") throw error;
    const metadata = await lstat(path); if (!metadata.isFile() || metadata.isSymbolicLink()
      || metadata.size !== bytes.length || !(await readFile(path)).equals(bytes)) invalid("request replay"); }
}
async function readResponse(path: string, root: string): Promise<unknown | null> {
  try { const metadata = await lstat(path); if (!metadata.isFile() || metadata.isSymbolicLink()
      || metadata.size < 2 || metadata.size > MAX_RESPONSE_BYTES) invalid("response file");
    if (!(await realpath(path)).startsWith(`${await realpath(root)}${sep}`)) invalid("response boundary");
    return JSON.parse(await readFile(path, "utf8")) as unknown;
  } catch (error) { if ((error as NodeJS.ErrnoException).code === "ENOENT") return null; throw error; }
}
async function privateRoot(path: string): Promise<string> { const metadata = await lstat(path); const canonical = await realpath(path);
  if (!metadata.isDirectory() || metadata.isSymbolicLink() || canonical !== path) invalid("work root"); return canonical; }
function boundedChild(root: string, ...parts: string[]): string { const value = resolve(root, ...parts);
  if (!value.startsWith(`${root}${sep}`) || value.includes("\0") || value.length > 4_096) invalid("run path"); return value; }
function processOptions(root: string, timeoutMs: number) { return Object.freeze({ cwd: root,
  env: Object.freeze({ NODE_ENV: "production", HOME: root, USERPROFILE: root, TMPDIR: root, TMP: root, TEMP: root, LANG: "C.UTF-8" }),
  timeoutMs, maxOutputBytes: 256 * 1024 }); }
function executionTimeout(input: IsolatedAgentExecutionRequest, configured: number, now: Date): number {
  const remaining = Date.parse(input.inferenceTokenExpiresAt) - now.getTime() - 30_000;
  const requested = input.budget.timeoutSeconds * 1_000;
  if (!Number.isFinite(remaining) || remaining < 60_000) invalid("DLRT lifetime");
  return Math.min(configured, requested, remaining);
}
function gateway(value: string): string { const url = new URL(value); if (url.protocol !== "https:" || url.username || url.password
  || url.search || url.hash || (url.pathname !== "/" && url.pathname !== "")) invalid("inference Gateway"); return url.toString(); }
function absolute(value: string, label: string): string { if (!isAbsolute(value) || resolve(value) !== value || value.length > 4_096 || value.includes("\0")) invalid(label); return value; }
function integer(value: number, minimum: number, maximum: number): number { if (!Number.isSafeInteger(value) || value < minimum || value > maximum) invalid("timeout"); return value; }
function bounded(value: string, maximum: number): string { return value.length <= maximum ? value : value.slice(0, maximum); }
function parseJson(value: string): Record<string, unknown> { try { const parsed = JSON.parse(value) as unknown;
    if (!parsed || typeof parsed !== "object" || Array.isArray(parsed)) invalid("JSON"); return parsed as Record<string, unknown>; } catch { invalid("JSON"); } }
function invalid(label: string): never { throw new Error(`Native Agent microVM ${label} is invalid`); }
