import { createHash } from "node:crypto";
import { chmod, lstat, mkdir, mkdtemp, realpath, rm, writeFile } from "node:fs/promises";
import { isAbsolute, join, resolve, sep } from "node:path";
import { canonicalJson } from "../../runner-control/src/canonical";
import { parseRunnerExecutionLock, runnerExecutionLockDigest, type RunnerExecutionLock } from "../../runner-control/src/execution-lock";
import { parseFrozenGodotTestPlan } from "../../godot-testkit/src/contracts";
import { createSourceBundle } from "../../godot-testkit/src/source-bundle-builder";
import { parseSourceExecutionPreparationRequest, type SourceExecutionPreparationRequest } from "./contracts";

const SHA256 = /^[a-f0-9]{64}$/;
const UUID = /^[a-f0-9]{8}-[a-f0-9]{4}-[1-5][a-f0-9]{3}-[89ab][a-f0-9]{3}-[a-f0-9]{12}$/i;

export interface AuthoritativeSourceSnapshotPort {
  materialize(input: {
    readonly tenantId: string;
    readonly projectId: string;
    readonly runId: string;
    readonly mode: SourceExecutionPreparationRequest["mode"];
    readonly commitSha: string;
    readonly destinationPath: string;
  }): Promise<Readonly<{ sourceDigest: string }>>;
}

export interface FrozenTestPlanPort {
  read(input: {
    readonly tenantId: string;
    readonly projectId: string;
    readonly specRevisionId: string;
    readonly testPlanDigest: string;
  }): Promise<Buffer>;
}

export interface PreparedInputObjectPort {
  publishFile(input: {
    readonly tenantId: string;
    readonly projectId: string;
    readonly runId: string;
    readonly lockKey: string;
    readonly artifactKind: "source-bundle" | "test-plan";
    readonly objectKey: string;
    readonly artifactDigest: string;
    readonly sizeBytes: number;
    readonly contentType: "application/zstd" | "application/json";
    readonly path: string;
  }): Promise<Readonly<{ objectKey: string; artifactDigest: string; sizeBytes: number }>>;
}

export interface RunnerExecutionLockPort {
  persist(input: {
    readonly tenantId: string;
    readonly projectId: string;
    readonly runId: string;
    readonly lockKey: string;
    readonly payload: RunnerExecutionLock;
    readonly payloadDigest: string;
  }): Promise<Readonly<{ executionLockId: string; payloadDigest: string; created: boolean }>>;
}

export interface SourceExecutionPreparationResult {
  readonly executionLockId: string;
  readonly executionLockDigest: string;
  readonly sourceDigest: string;
  readonly sourceArtifactDigest: string;
  readonly sourceObjectKey: string;
  readonly testPlanDigest: string;
  readonly testPlanObjectKey: string;
  readonly created: boolean;
}

/** Freezes and publishes every source-mode Runner input before an attempt may be queued. */
export class SourceExecutionPreparer {
  readonly #sources: AuthoritativeSourceSnapshotPort;
  readonly #plans: FrozenTestPlanPort;
  readonly #objects: PreparedInputObjectPort;
  readonly #locks: RunnerExecutionLockPort;
  readonly #workRoot: string;
  readonly #now: () => Date;

  constructor(options: {
    readonly sources: AuthoritativeSourceSnapshotPort;
    readonly plans: FrozenTestPlanPort;
    readonly objects: PreparedInputObjectPort;
    readonly locks: RunnerExecutionLockPort;
    readonly workRoot: string;
    readonly now?: () => Date;
  }) {
    this.#sources = options.sources;
    this.#plans = options.plans;
    this.#objects = options.objects;
    this.#locks = options.locks;
    this.#workRoot = absolute(options.workRoot, "work root");
    this.#now = options.now ?? (() => new Date());
  }

  async prepare(value: unknown): Promise<SourceExecutionPreparationResult> {
    const request = parseSourceExecutionPreparationRequest(value);
    const root = await privateRoot(this.#workRoot);
    const temporary = await mkdtemp(join(root, "prepare-"));
    if (!temporary.startsWith(`${root}${sep}`)) invalid("temporary boundary");
    try {
      if (process.platform !== "win32") await chmod(temporary, 0o700);
      const snapshotPath = join(temporary, "snapshot");
      const source = await this.#sources.materialize({
        tenantId: request.tenantId,
        projectId: request.projectId,
        runId: request.runId,
        mode: request.mode,
        commitSha: request.commitSha,
        destinationPath: snapshotPath,
      });
      if (!source || !SHA256.test(source.sourceDigest)) invalid("source receipt");
      const planBytes = await this.#plans.read({
        tenantId: request.tenantId,
        projectId: request.projectId,
        specRevisionId: request.specRevisionId,
        testPlanDigest: request.testPlanDigest,
      });
      parseFrozenGodotTestPlan(planBytes, {
        testPlanDigest: request.testPlanDigest,
        targetMatrix: request.targetMatrix,
        requiredGodotVersion: request.toolchain.requiredGodotVersion,
      });

      const sourceBundlePath = join(temporary, "source.tar.zst");
      const bundle = await createSourceBundle(snapshotPath, sourceBundlePath);
      const planPath = join(temporary, "test-plan.json");
      await writeFile(planPath, planBytes, { flag: "wx", mode: 0o400 });
      const sourceObjectKey = `tenants/${request.tenantId}/projects/${request.projectId}/sources/${bundle.artifactDigest}.tar.zst`;
      const testPlanObjectKey = `tenants/${request.tenantId}/projects/${request.projectId}/test-plans/${request.testPlanDigest}.json`;
      const [sourceReceipt, planReceipt] = await Promise.all([
        this.#objects.publishFile({
          tenantId: request.tenantId,
          projectId: request.projectId,
          runId: request.runId,
          lockKey: request.lockKey,
          artifactKind: "source-bundle",
          objectKey: sourceObjectKey,
          artifactDigest: bundle.artifactDigest,
          sizeBytes: bundle.sizeBytes,
          contentType: "application/zstd",
          path: sourceBundlePath,
        }),
        this.#objects.publishFile({
          tenantId: request.tenantId,
          projectId: request.projectId,
          runId: request.runId,
          lockKey: request.lockKey,
          artifactKind: "test-plan",
          objectKey: testPlanObjectKey,
          artifactDigest: request.testPlanDigest,
          sizeBytes: planBytes.byteLength,
          contentType: "application/json",
          path: planPath,
        }),
      ]);
      exactObjectReceipt(sourceReceipt, sourceObjectKey, bundle.artifactDigest, bundle.sizeBytes);
      exactObjectReceipt(planReceipt, testPlanObjectKey, request.testPlanDigest, planBytes.byteLength);
      const preparedAt = validNow(this.#now()).toISOString();
      const lock = parseRunnerExecutionLock({
        schemaVersion: "deviludo.runner-execution-lock.v1",
        tenantId: request.tenantId,
        projectId: request.projectId,
        runId: request.runId,
        mode: request.mode,
        commitSha: request.commitSha,
        sourceDigest: source.sourceDigest,
        steamBuildId: null,
        specRevisionId: request.specRevisionId,
        specDigest: request.specDigest,
        testPlanDigest: request.testPlanDigest,
        targetMatrix: request.targetMatrix,
        requiredGodotVersion: request.toolchain.requiredGodotVersion,
        godotTestKitDigest: request.toolchain.godotTestKitDigest,
        exportTemplates: request.toolchain.exportTemplates,
        buildManifestDigest: request.toolchain.buildManifestDigest,
        sbomDigest: request.toolchain.sbomDigest,
        vulnerabilityScanDigest: request.toolchain.vulnerabilityScanDigest,
        assetLicenseLedgerDigest: request.toolchain.assetLicenseLedgerDigest,
        execution: { kind: "SOURCE_ARTIFACT", objectKey: sourceObjectKey, artifactDigest: bundle.artifactDigest },
        preparedAt,
      });
      const executionLockDigest = runnerExecutionLockDigest(lock);
      const persisted = await this.#locks.persist({
        tenantId: request.tenantId,
        projectId: request.projectId,
        runId: request.runId,
        lockKey: request.lockKey,
        payload: lock,
        payloadDigest: executionLockDigest,
      });
      if (!UUID.test(persisted.executionLockId) || persisted.payloadDigest !== executionLockDigest
        || typeof persisted.created !== "boolean") invalid("execution lock receipt");
      return Object.freeze({
        executionLockId: persisted.executionLockId,
        executionLockDigest,
        sourceDigest: source.sourceDigest,
        sourceArtifactDigest: bundle.artifactDigest,
        sourceObjectKey,
        testPlanDigest: request.testPlanDigest,
        testPlanObjectKey,
        created: persisted.created,
      });
    } finally {
      await rm(temporary, { recursive: true, force: true });
    }
  }
}

/** Small immutable filesystem adapters can use this helper to enforce canonical test-plan bytes. */
export async function writeCanonicalFrozenPlan(path: string, value: unknown): Promise<Readonly<{ digest: string; bytes: Buffer }>> {
  const bytes = Buffer.from(canonicalJson(value), "utf8");
  if (bytes.byteLength < 2 || bytes.byteLength > 4 * 1024 * 1024) invalid("test plan bytes");
  const digest = createHash("sha256").update(bytes).digest("hex");
  await writeFile(path, bytes, { flag: "wx", mode: 0o400 });
  return Object.freeze({ digest, bytes });
}

function exactObjectReceipt(
  receipt: Readonly<{ objectKey: string; artifactDigest: string; sizeBytes: number }>,
  objectKey: string,
  artifactDigest: string,
  sizeBytes: number,
): void {
  if (!receipt || receipt.objectKey !== objectKey || receipt.artifactDigest !== artifactDigest
    || receipt.sizeBytes !== sizeBytes) invalid("object receipt");
}

async function privateRoot(value: string): Promise<string> {
  await mkdir(value, { recursive: true, mode: 0o700 });
  const path = await realpath(value);
  const metadata = await lstat(path);
  if (!metadata.isDirectory() || metadata.isSymbolicLink()) invalid("work root");
  if (process.platform !== "win32") await chmod(path, 0o700);
  return path;
}

function validNow(value: Date): Date {
  if (!(value instanceof Date) || !Number.isFinite(value.getTime())) invalid("clock");
  return value;
}

function absolute(value: string, label: string): string {
  if (!isAbsolute(value) || resolve(value) !== value || value.length > 4_096 || /\0/.test(value)) invalid(label);
  return value;
}

function invalid(label: string): never {
  throw new Error(`Artifact preparation ${label} is invalid`);
}
