import { constants } from "node:fs";
import { createHash, createPublicKey, type KeyObject } from "node:crypto";
import { lstat, open, readdir, realpath } from "node:fs/promises";
import { isAbsolute, join, relative, resolve, sep } from "node:path";
import { getRuntimeAdapter } from "../../../adapters";
import {
  DEFAULT_RUNTIME_PERMISSIONS,
  type AgentProfileRevision,
  type RunContext,
  type RunHandle,
} from "../../../lib/agent/types";
import type { AgentExecutionRequest, SupervisedRun } from "../../agent-worker/src/contracts";
import { AgentExecutionSupervisor } from "../../agent-worker/src/supervisor";
import { sha256Canonical } from "../../runner-control/src/canonical";
import { contentSha256, signGitHubCandidateArtifact } from "../../scm-proxy/src/github-artifacts";
import type {
  GitHubCandidateArtifactCore,
  GitHubCandidateChange,
  SignedGitHubCandidateArtifact,
} from "../../scm-proxy/src/github-contracts";
import type { IsolatedAgentExecutionResult } from "./contracts";
import type { NativeGuestInferenceRelay } from "./native-inference-relay";
import { parseNativeMicrovmAgentRequest, type NativeMicrovmAgentRequest } from "./native-microvm-contracts";

const MAX_FILES = 100_000;
const MAX_TREE_BYTES = 8 * 1024 * 1024 * 1024;
const MAX_CHANGED_FILES = 20_000;
const MAX_CHANGED_FILE_BYTES = 20 * 1024 * 1024;
const MAX_CHANGED_TOTAL_BYTES = 100 * 1024 * 1024;

type RepositoryEntry = Readonly<{
  path: string;
  absolutePath: string;
  mode: "100644" | "100755";
  sizeBytes: number;
  contentDigest: string;
  blobSha: string;
}>;

export interface CandidateArtifactSigner {
  sign(core: GitHubCandidateArtifactCore): Promise<SignedGitHubCandidateArtifact>;
}

/** Private key material is allowed only in the sealed guest image or guest KMS sidecar. */
export class Ed25519GuestCandidateArtifactSigner implements CandidateArtifactSigner {
  constructor(private readonly privateKey: KeyObject, private readonly keyId: string) {
    if (privateKey.type !== "private" || createPublicKey(privateKey).asymmetricKeyType !== "ed25519"
      || !/^[A-Za-z0-9][A-Za-z0-9._:-]{2,159}$/.test(keyId)) invalid("attestation signer");
  }
  async sign(core: GitHubCandidateArtifactCore): Promise<SignedGitHubCandidateArtifact> {
    return signGitHubCandidateArtifact(core, this.privateKey, this.keyId);
  }
}

export interface NativeGuestSupervisor {
  start(request: AgentExecutionRequest): Promise<SupervisedRun>;
}

/**
 * Runs inside one isolated Linux microVM. It receives no GitHub credential or
 * Provider URL, executes one locked adapter, then emits only an attested file
 * delta for the host-side SCM Broker.
 */
export class NativeMicrovmAgentGuest {
  readonly #supervisor: NativeGuestSupervisor | null;
  readonly #relay: NativeGuestInferenceRelay;
  readonly #signer: CandidateArtifactSigner;
  readonly #now: () => Date;

  constructor(options: Readonly<{
    relay: NativeGuestInferenceRelay;
    signer: CandidateArtifactSigner;
    supervisor?: NativeGuestSupervisor;
    now?: () => Date;
  }>) {
    this.#supervisor = options.supervisor ?? null;
    this.#relay = options.relay;
    this.#signer = options.signer;
    this.#now = options.now ?? (() => new Date());
  }

  async execute(value: unknown, paths: Readonly<{ runRoot: string; workspaceRoot: string }>): Promise<IsolatedAgentExecutionResult> {
    const request = parseNativeMicrovmAgentRequest(value);
    const roots = await validateRoots(paths.runRoot, paths.workspaceRoot);
    try {
      const startedAt = validNow(this.#now());
      const remainingSeconds = Math.floor((Date.parse(request.inferenceAuthorizationExpiresAt) - startedAt.getTime() - 30_000) / 1_000);
      // The request records the initial token expiry for audit only. The host
      // may already have rotated the stable SecretRef while materializing a
      // large source tree, so the relay resolves the current value on demand.
      if (remainingSeconds < 60) invalid("DLRT lifetime");
      const before = await scanRepository(roots.workspaceRoot);
      if (sourceDigest(before) !== request.sourceDigest) invalid("baseline source digest");
      const relay = await this.#relay.start(request);
      let completion: Awaited<SupervisedRun["completion"]>;
      try {
        const adapter = getRuntimeAdapter(request.agent);
        const profile = profileFrom(request, Math.min(request.budget.timeoutSeconds, remainingSeconds));
        const context: RunContext = Object.freeze({
          tenantId: request.tenantId,
          projectId: request.projectId,
          runId: request.runId,
          attemptId: request.attemptId,
          commitSha: request.baseCommitSha,
          specificationRevisionId: request.specRevisionId,
          testPlanRevisionId: request.testPlanRevisionId,
          runRoot: roots.runRoot,
          inferenceGatewayUrl: relay.gatewayUrl,
          runTokenSecretRef: relay.runTokenSecretRef,
        });
        const runtime = adapter.prepare(context, profile);
        const runtimeSpec = adapter.start(runtime, request.prompt, roots.workspaceRoot);
        const runHandle: RunHandle = Object.freeze({ runId: request.runId, attemptId: request.attemptId,
          agent: request.agent, executorHandle: `microvm-${request.attemptId}` });
        const supervisor = this.#supervisor ?? new AgentExecutionSupervisor({ secretResolver: relay.secretResolver });
        const supervised = await supervisor.start({ adapter, runHandle, installationProbe: adapter.probe(profile),
          runtimeSpec, workerRunRoot: roots.runRoot, workspaceRoot: roots.workspaceRoot });
        completion = await supervised.completion;
      } finally { await relay.close(); }
      if (completion.status !== "completed" || completion.result.status !== "completed") invalid("Agent completion");
      if (!Number.isSafeInteger(completion.result.usage.inputTokens) || completion.result.usage.inputTokens < 0
        || !Number.isSafeInteger(completion.result.usage.outputTokens) || completion.result.usage.outputTokens < 0
        || !Number.isFinite(completion.result.usage.costUsd) || completion.result.usage.costUsd < 0
        || completion.result.usage.costUsd > request.budget.maxUsd) invalid("Agent usage");
      const after = await scanRepository(roots.workspaceRoot);
      const changes = await buildChanges(before, after);
      const verifiedAfter = await scanRepository(roots.workspaceRoot);
      if (inventoryDigest(after) !== inventoryDigest(verifiedAfter)) invalid("post-execution mutation");
      const createdAt = validNow(this.#now()).toISOString();
      const core: GitHubCandidateArtifactCore = Object.freeze({
        schemaVersion: "deviludo.github-candidate.v1",
        artifactId: `candidate-${request.attemptId}`,
        tenantId: request.tenantId,
        projectId: request.projectId,
        runId: request.runId,
        attemptId: request.attemptId,
        specRevisionId: request.specRevisionId,
        expectedBaseCommitSha: request.baseCommitSha,
        candidateBranch: `deviludo/${request.projectId.slice(0, 8)}/${request.runId.slice(0, 8)}-${request.attemptId.slice(0, 8)}`,
        commitMessage: `agent: implement approved specification ${request.specRevisionId}`,
        sourceDigest: sourceDigest(after),
        changes,
        createdAt,
      });
      const artifact = await this.#signer.sign(core);
      validateSignedArtifact(artifact, core);
      return result(request, {
        status: "COMPLETED",
        executionReceiptId: `microvm-${request.attemptId}`,
        candidateArtifact: artifact,
        diagnosticId: null,
      });
    } catch (error) {
      return result(request, {
        status: "FAILED",
        executionReceiptId: `microvm-${request.attemptId}`,
        candidateArtifact: null,
        diagnosticId: diagnosticId(request, error),
      });
    }
  }
}

function profileFrom(request: NativeMicrovmAgentRequest, timeoutSeconds: number): AgentProfileRevision {
  return Object.freeze({
    profileRevisionId: request.profileRevisionId,
    profileId: request.profileRevisionId,
    revision: 1,
    agent: request.agent,
    installation: Object.freeze({ installationId: request.installationId, agent: request.agent,
      cliVersion: request.exactAgentVersion, imageDigest: request.imageDigest,
      adapterVersion: request.adapterVersion, workerPoolId: "development-isolated-microvm" }),
    providerRevisionId: request.providerRevisionId,
    models: request.modelRoles,
    credential: Object.freeze({ bindingId: `binding-${request.credentialVersionId}`,
      credentialVersionId: request.credentialVersionId }),
    budget: Object.freeze({ maxTurns: request.budget.maxTurns, maxCostUsd: request.budget.maxUsd }),
    timeoutSeconds,
    permissions: DEFAULT_RUNTIME_PERMISSIONS,
    allowedFallbackProfileRevisionIds: Object.freeze([]),
  });
}

async function scanRepository(root: string): Promise<readonly RepositoryEntry[]> {
  const entries: RepositoryEntry[] = [];
  let totalBytes = 0;
  const visit = async (directory: string, depth: number): Promise<void> => {
    if (depth > 64) invalid("repository depth");
    const names = await readdir(directory, { withFileTypes: true });
    names.sort((left, right) => Buffer.compare(Buffer.from(left.name), Buffer.from(right.name)));
    for (const child of names) {
      const absolutePath = join(directory, child.name);
      const path = relative(root, absolutePath).split(sep).join("/");
      validatePath(path);
      const metadata = await lstat(absolutePath);
      if (metadata.isSymbolicLink()) invalid("repository symlink");
      if (metadata.isDirectory()) { await visit(absolutePath, depth + 1); continue; }
      if (!metadata.isFile() || entries.length >= MAX_FILES) invalid("repository file");
      totalBytes += metadata.size;
      if (!Number.isSafeInteger(totalBytes) || totalBytes > MAX_TREE_BYTES) invalid("repository size");
      const hashed = await hashFile(absolutePath, metadata);
      entries.push(Object.freeze({ path, absolutePath,
        mode: metadata.mode & 0o111 ? "100755" : "100644",
        sizeBytes: metadata.size, ...hashed }));
    }
  };
  await visit(root, 0);
  entries.sort((left, right) => Buffer.compare(Buffer.from(left.path), Buffer.from(right.path)));
  if (!entries.some((entry) => entry.path === "project.godot" && entry.sizeBytes >= 16)) invalid("Godot project marker");
  return Object.freeze(entries);
}

async function hashFile(path: string, before: Awaited<ReturnType<typeof lstat>>): Promise<Readonly<{ contentDigest: string; blobSha: string }>> {
  const file = await open(path, constants.O_RDONLY | constants.O_NOFOLLOW);
  try {
    const opened = await file.stat(); assertIdentity(opened, before);
    const sha256 = createHash("sha256");
    const sha1 = createHash("sha1").update(`blob ${opened.size}\0`);
    const buffer = Buffer.allocUnsafe(1024 * 1024);
    let position = 0;
    while (position < opened.size) {
      const { bytesRead } = await file.read(buffer, 0, Math.min(buffer.byteLength, opened.size - position), position);
      if (bytesRead < 1) invalid("repository read");
      const chunk = buffer.subarray(0, bytesRead); sha256.update(chunk); sha1.update(chunk); position += bytesRead;
    }
    assertIdentity(await file.stat(), before);
    return Object.freeze({ contentDigest: sha256.digest("hex"), blobSha: sha1.digest("hex") });
  } finally { await file.close(); }
}

async function buildChanges(before: readonly RepositoryEntry[], after: readonly RepositoryEntry[]): Promise<readonly GitHubCandidateChange[]> {
  const previous = new Map(before.map((entry) => [entry.path, entry]));
  const current = new Map(after.map((entry) => [entry.path, entry]));
  const paths = [...new Set([...previous.keys(), ...current.keys()])].sort((left, right) => Buffer.compare(Buffer.from(left), Buffer.from(right)));
  const changes: GitHubCandidateChange[] = [];
  let totalBytes = 0;
  for (const path of paths) {
    const oldEntry = previous.get(path); const newEntry = current.get(path);
    if (!newEntry) { changes.push(Object.freeze({ operation: "DELETE", path })); continue; }
    if (oldEntry && oldEntry.contentDigest === newEntry.contentDigest && oldEntry.mode === newEntry.mode) continue;
    if (newEntry.sizeBytes > MAX_CHANGED_FILE_BYTES) invalid("changed file size");
    totalBytes += newEntry.sizeBytes;
    if (totalBytes > MAX_CHANGED_TOTAL_BYTES) invalid("changed content size");
    const content = await readChangedFile(newEntry);
    changes.push(Object.freeze({ operation: "UPSERT", path, mode: newEntry.mode,
      contentBase64: content.toString("base64"), contentDigest: contentSha256(content), sizeBytes: content.byteLength }));
  }
  if (changes.length < 1 || changes.length > MAX_CHANGED_FILES) invalid("changed file count");
  return Object.freeze(changes);
}

async function readChangedFile(entry: RepositoryEntry): Promise<Buffer> {
  const metadata = await lstat(entry.absolutePath);
  if (!metadata.isFile() || metadata.isSymbolicLink() || metadata.size !== entry.sizeBytes) invalid("changed file");
  const file = await open(entry.absolutePath, constants.O_RDONLY | constants.O_NOFOLLOW);
  try {
    const content = await file.readFile();
    if (content.byteLength !== entry.sizeBytes || contentSha256(content) !== entry.contentDigest) invalid("changed file drift");
    return content;
  } finally { await file.close(); }
}

function sourceDigest(entries: readonly RepositoryEntry[]): string {
  const hash = createHash("sha256");
  for (const entry of entries) hash.update(`${entry.mode} blob ${entry.blobSha}\t${entry.path}\0`, "utf8");
  return hash.digest("hex");
}

function inventoryDigest(entries: readonly RepositoryEntry[]): string {
  return sha256Canonical(entries.map(({ path, mode, sizeBytes, contentDigest, blobSha }) =>
    ({ path, mode, sizeBytes, contentDigest, blobSha })));
}

function validateSignedArtifact(artifact: SignedGitHubCandidateArtifact, core: GitHubCandidateArtifactCore): void {
  if (!artifact || !artifact.payload || !artifact.attestation) invalid("candidate attestation receipt");
  const { artifactDigest, ...payloadCore } = artifact.payload;
  if (artifact.attestation.algorithm !== "Ed25519" || !artifact.attestation.keyId
    || artifact.attestation.signature.length < 32 || artifactDigest !== sha256Canonical(core)
    || sha256Canonical(payloadCore) !== sha256Canonical(core)) invalid("candidate attestation receipt");
}

function result(request: NativeMicrovmAgentRequest, outcome: Pick<IsolatedAgentExecutionResult,
  "status" | "executionReceiptId" | "candidateArtifact" | "diagnosticId">): IsolatedAgentExecutionResult {
  return Object.freeze({ status: outcome.status, runId: request.runId, attemptId: request.attemptId,
    resolutionDigest: request.resolutionDigest, profileRevisionId: request.profileRevisionId,
    installationId: request.installationId, imageDigest: request.imageDigest, adapterVersion: request.adapterVersion,
    providerRevisionId: request.providerRevisionId, credentialVersionId: request.credentialVersionId,
    model: request.model, executionReceiptId: outcome.executionReceiptId,
    candidateArtifact: outcome.candidateArtifact, diagnosticId: outcome.diagnosticId }) as IsolatedAgentExecutionResult;
}

async function validateRoots(runRootValue: string, workspaceRootValue: string): Promise<Readonly<{ runRoot: string; workspaceRoot: string }>> {
  for (const value of [runRootValue, workspaceRootValue]) {
    if (!isAbsolute(value) || resolve(value) !== value || value.length > 4_096 || value.includes("\0")) invalid("runtime path");
  }
  const runRoot = await realpath(runRootValue); const workspaceRoot = await realpath(workspaceRootValue);
  const runMetadata = await lstat(runRoot); const workspaceMetadata = await lstat(workspaceRoot);
  if (!runMetadata.isDirectory() || runMetadata.isSymbolicLink() || !workspaceMetadata.isDirectory()
    || workspaceMetadata.isSymbolicLink() || !workspaceRoot.startsWith(`${runRoot}${sep}`)) invalid("runtime boundary");
  return Object.freeze({ runRoot, workspaceRoot });
}

function validatePath(value: string): void {
  const parts = value.split("/");
  if (!value || value.length > 500 || value.startsWith("/") || value.includes("\\") || /[\u0000-\u001f\u007f]/.test(value)
    || parts.some((part) => !part || part === "." || part === ".." || part === ".git")) invalid("repository path");
}
function assertIdentity(actual: Awaited<ReturnType<Awaited<ReturnType<typeof open>>["stat"]>>, expected: Awaited<ReturnType<typeof lstat>>): void {
  if (!actual.isFile() || actual.size !== expected.size || actual.mtimeMs !== expected.mtimeMs || actual.ctimeMs !== expected.ctimeMs) {
    invalid("repository mutation");
  }
}
function diagnosticId(request: NativeMicrovmAgentRequest, error: unknown): string {
  const kind = error instanceof Error ? error.name : typeof error;
  const detail = error instanceof Error ? error.message : String(error);
  return `diag-${createHash("sha256").update(`${request.runId}:${request.attemptId}:${kind}:${detail}`).digest("hex").slice(0, 48)}`;
}
function validNow(value: Date): Date { if (!(value instanceof Date) || !Number.isFinite(value.getTime())) invalid("clock"); return value; }
function invalid(label: string): never { throw new Error(`Native Agent microVM guest ${label} is invalid`); }
