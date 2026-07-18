import { createHash, randomUUID } from "node:crypto";
import { chmod, lstat, mkdir, open, readFile, readdir } from "node:fs/promises";
import { isAbsolute, join, relative, resolve, sep } from "node:path";
import { canonicalJson } from "../../runner-control/src/canonical";
import type { SignedRunnerJob } from "../../runner-control/src/contracts";
import type { TestKitArtifactKind } from "../../runner-control/src/testkit-artifact-client";
import type { PhysicalRunnerExecutionOutput } from "../../runner-control/src/physical-runner";
import { parseGodotTestKitRunRequest, parseGodotTestPlan, type GodotTestKitRunRequest } from "./contracts";
import { createEvidencePackage, type EvidencePackageEntry } from "./evidence-package";
import { ExecFileGodotPlatformDriver, type GodotDriverResult, type GodotPlatformDriver } from "./godot-driver";
import { extractSourceBundle } from "./source-bundle";

const SHA256 = /^[a-f0-9]{64}$/;
const MAX_STATE_BYTES = 1024 * 1024;

export interface GodotTestKitArtifactPort {
  downloadInput(job: SignedRunnerJob, destinationPath: string): Promise<Readonly<{ sizeBytes: number; artifactDigest: string }>>;
  downloadTestPlan(job: SignedRunnerJob, destinationPath: string): Promise<Readonly<{ sizeBytes: number; artifactDigest: string }>>;
  uploadEvidence(job: SignedRunnerJob, kind: TestKitArtifactKind, sourcePath: string): Promise<Readonly<{
    objectKey: string;
    artifactDigest: string;
    sizeBytes: number;
  }>>;
}

type PreparedArtifact = Readonly<{
  kind: TestKitArtifactKind;
  path: string;
  artifactDigest: string;
  sizeBytes: number;
}>;

interface PreparedState {
  readonly schemaVersion: "deviludo.godot-testkit-prepared.v1";
  readonly jobDigest: string;
  readonly testKitDigest: string;
  readonly godotBinaryDigest: string;
  readonly status: "PASSED" | "FAILED";
  readonly createdAt: string;
  readonly artifacts: readonly PreparedArtifact[];
}

export class GodotTestKitController {
  readonly #artifacts: GodotTestKitArtifactPort;
  readonly #driver: GodotPlatformDriver;
  readonly #now: () => Date;

  constructor(options: {
    readonly artifacts: GodotTestKitArtifactPort;
    readonly driver?: GodotPlatformDriver;
    readonly now?: () => Date;
  }) {
    this.#artifacts = options.artifacts;
    this.#driver = options.driver ?? new ExecFileGodotPlatformDriver();
    this.#now = options.now ?? (() => new Date());
  }

  async run(value: unknown, runRootPath: string): Promise<PhysicalRunnerExecutionOutput> {
    const request = parseGodotTestKitRunRequest(value);
    const runRoot = await privateDirectory(runRootPath);
    const statePath = join(runRoot, "prepared-evidence.json");
    let state = await readOptionalState(statePath, runRoot, request);
    if (!state) {
      state = await this.#prepare(request, runRoot);
      await writeImmutableJson(statePath, state);
    }
    await verifyPreparedState(state, runRoot, request);
    const receipts = await Promise.all(state.artifacts.map(async (artifact) => ({
      kind: artifact.kind,
      receipt: await this.#artifacts.uploadEvidence(request.signedJob, artifact.kind, artifact.path),
    })));
    for (const { kind, receipt } of receipts) {
      const expected = state.artifacts.find((artifact) => artifact.kind === kind)!;
      if (receipt.artifactDigest !== expected.artifactDigest || receipt.sizeBytes !== expected.sizeBytes) {
        throw new Error("Godot TestKit artifact receipt drifted from prepared evidence");
      }
    }
    const digestFor = (kind: TestKitArtifactKind) => receipts.find((item) => item.kind === kind)!.receipt.artifactDigest;
    return Object.freeze({
      exportDigest: digestFor("production-export"),
      logsDigest: digestFor("logs"),
      junitDigest: digestFor("junit"),
      inputTimelineDigest: digestFor("input-timeline"),
      screenshotManifestDigest: digestFor("screenshot-manifest"),
      videoManifestDigest: digestFor("video-manifest"),
      status: state.status,
      createdAt: state.createdAt,
    });
  }

  async #prepare(request: GodotTestKitRunRequest, runRoot: string): Promise<PreparedState> {
    const inputRoot = join(runRoot, "inputs");
    await ensureDirectory(inputRoot);
    const sourcePath = join(inputRoot, "source.tar.zst");
    const planPath = join(inputRoot, "test-plan.json");
    await Promise.all([
      this.#artifacts.downloadInput(request.signedJob, sourcePath),
      this.#artifacts.downloadTestPlan(request.signedJob, planPath),
    ]);
    const plan = parseGodotTestPlan(await readFile(planPath), request);
    requireExecutionLease(request, plan, this.#now());
    const executionRoot = join(runRoot, `execution-${randomUUID()}`);
    await mkdir(executionRoot, { recursive: false, mode: 0o700 });
    const workspace = join(executionRoot, "workspace");
    await extractSourceBundle(sourcePath, workspace);
    const driver = await this.#driver.run({ request, plan, workspace, runRoot: executionRoot, planPath });
    const createdAt = nowIso(this.#now);
    const prepared = await prepareEvidence(executionRoot, request, driver);
    return deepFreeze({
      schemaVersion: "deviludo.godot-testkit-prepared.v1",
      jobDigest: request.jobDigest,
      testKitDigest: request.testKitDigest,
      godotBinaryDigest: request.godot.binaryDigest,
      status: prepared.status,
      createdAt,
      artifacts: prepared.artifacts,
    });
  }
}

async function prepareEvidence(
  root: string,
  request: GodotTestKitRunRequest,
  driver: GodotDriverResult,
): Promise<Readonly<{ status: "PASSED" | "FAILED"; artifacts: readonly PreparedArtifact[] }>> {
  const evidenceRoot = join(root, "evidence");
  await mkdir(evidenceRoot, { recursive: false, mode: 0o700 });
  const harness = driver.harness;
  const requiredCommands = ["import", "boot", "platform-suite", "production-export", "production-boot"] as const;
  const commandChecks = requiredCommands.map((id) => driver.commands.find((command) => command.id === id)
    ?? Object.freeze({ id, status: "FAILED" as const, durationMs: 0, code: "NOT_EXECUTED" }));
  const harnessPassed = !!harness && harness.status === "PASSED";
  const commandsPassed = commandChecks.every((check) => check.status === "PASSED");
  const exportedFiles = await collectRegularFiles(driver.exportRoot);
  const status = commandsPassed && harnessPassed && exportedFiles.length > 0 ? "PASSED" as const : "FAILED" as const;
  const logPath = join(evidenceRoot, "godot.log");
  const junitPath = join(evidenceRoot, "junit.xml");
  const timelinePath = join(evidenceRoot, "input-timeline.json");
  const screenshotsPath = join(evidenceRoot, "screenshots.tar");
  const videoPath = join(evidenceRoot, "video.tar");
  const exportPath = join(evidenceRoot, "production-export.tar");
  await writeImmutable(logPath, sanitizeLog(driver.logs, root));
  await writeImmutable(junitPath, junit(commandChecks, harness, status));
  await writeImmutable(timelinePath, canonicalJson({
    schemaVersion: "deviludo.input-timeline.v1",
    jobDigest: request.jobDigest,
    platform: request.signedJob.payload.platform,
    events: harness?.inputTimeline ?? [],
  }));

  const screenshotManifest = canonicalBuffer({
    schemaVersion: "deviludo.screenshot-evidence.v1",
    jobDigest: request.jobDigest,
    platform: request.signedJob.payload.platform,
    screenshots: harness?.screenshots ?? [],
  });
  const screenshotEntries: EvidencePackageEntry[] = [{ name: "manifest.json", body: screenshotManifest }];
  if (harness) {
    const harnessRoot = join(root, "harness-output");
    for (const screenshot of [...harness.screenshots].sort((left, right) => left.name.localeCompare(right.name))) {
      screenshotEntries.push({
        name: `screenshots/${screenshot.name}.png`,
        sourcePath: boundedChild(harnessRoot, screenshot.file),
        expectedDigest: screenshot.sha256,
      });
    }
  }
  await createEvidencePackage(screenshotsPath, screenshotEntries);

  const videoEvidence = harness
    ? await fileDigest(boundedChild(join(root, "harness-output"), harness.videoFile))
    : null;
  const videoManifest = canonicalBuffer({
    schemaVersion: "deviludo.video-evidence.v1",
    jobDigest: request.jobDigest,
    platform: request.signedJob.payload.platform,
    file: harness && videoEvidence ? {
      path: harness.videoFile,
      sha256: videoEvidence.artifactDigest,
      sizeBytes: videoEvidence.sizeBytes,
    } : null,
  });
  const videoEntries: EvidencePackageEntry[] = [{ name: "manifest.json", body: videoManifest }];
  if (harness && videoEvidence) videoEntries.push({
    name: "video.avi",
    sourcePath: boundedChild(join(root, "harness-output"), harness.videoFile),
    expectedDigest: videoEvidence.artifactDigest,
  });
  await createEvidencePackage(videoPath, videoEntries);

  const exportManifest = canonicalBuffer({
    schemaVersion: "deviludo.production-export-evidence.v1",
    jobDigest: request.jobDigest,
    platform: request.signedJob.payload.platform,
    files: exportedFiles.map((file, index) => ({ index, path: file.relativePath, sha256: file.digest, sizeBytes: file.sizeBytes })),
  });
  const exportEntries: EvidencePackageEntry[] = [{ name: "manifest.json", body: exportManifest }];
  exportedFiles.forEach((file, index) => exportEntries.push({
    name: `files/${String(index).padStart(6, "0")}.bin`,
    sourcePath: file.absolutePath,
    expectedDigest: file.digest,
  }));
  exportEntries.sort((left, right) => left.name < right.name ? -1 : left.name > right.name ? 1 : 0);
  await createEvidencePackage(exportPath, exportEntries);

  const paths: readonly [TestKitArtifactKind, string][] = [
    ["input-timeline", timelinePath],
    ["junit", junitPath],
    ["logs", logPath],
    ["production-export", exportPath],
    ["screenshot-manifest", screenshotsPath],
    ["video-manifest", videoPath],
  ];
  const artifacts = await Promise.all(paths.map(async ([kind, path]) => ({ kind, path, ...await fileDigest(path) })));
  artifacts.sort((left, right) => left.kind.localeCompare(right.kind));
  return Object.freeze({ status, artifacts: Object.freeze(artifacts.map((artifact) => Object.freeze(artifact))) });
}

async function readOptionalState(path: string, root: string, request: GodotTestKitRunRequest): Promise<PreparedState | null> {
  try {
    const metadata = await lstat(path);
    if (!metadata.isFile() || metadata.isSymbolicLink() || metadata.size < 2 || metadata.size > MAX_STATE_BYTES) invalid("prepared state file");
    const parsed = JSON.parse(await readFile(path, "utf8")) as unknown;
    const state = parsePreparedState(parsed);
    await verifyPreparedState(state, root, request);
    return state;
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code === "ENOENT") return null;
    throw error;
  }
}

function parsePreparedState(value: unknown): PreparedState {
  const body = record(value);
  exactKeys(body, ["schemaVersion", "jobDigest", "testKitDigest", "godotBinaryDigest", "status", "createdAt", "artifacts"]);
  if (body.schemaVersion !== "deviludo.godot-testkit-prepared.v1"
    || typeof body.jobDigest !== "string" || !SHA256.test(body.jobDigest)
    || typeof body.testKitDigest !== "string" || !SHA256.test(body.testKitDigest)
    || typeof body.godotBinaryDigest !== "string" || !SHA256.test(body.godotBinaryDigest)
    || (body.status !== "PASSED" && body.status !== "FAILED")
    || typeof body.createdAt !== "string" || !Number.isFinite(Date.parse(body.createdAt))
    || !Array.isArray(body.artifacts) || body.artifacts.length !== 6) invalid("prepared state");
  const artifacts = body.artifacts.map((item) => {
    const artifact = record(item);
    exactKeys(artifact, ["kind", "path", "artifactDigest", "sizeBytes"]);
    if (!isArtifactKind(artifact.kind) || typeof artifact.path !== "string" || !isAbsolute(artifact.path)
      || typeof artifact.artifactDigest !== "string" || !SHA256.test(artifact.artifactDigest)
      || !Number.isSafeInteger(artifact.sizeBytes) || (artifact.sizeBytes as number) < 1) invalid("prepared artifact");
    return { kind: artifact.kind, path: artifact.path, artifactDigest: artifact.artifactDigest, sizeBytes: artifact.sizeBytes as number };
  });
  const kinds = artifacts.map((artifact) => artifact.kind);
  if (new Set(kinds).size !== 6 || JSON.stringify([...kinds].sort()) !== JSON.stringify(kinds)) invalid("prepared artifact kinds");
  return deepFreeze({
    schemaVersion: "deviludo.godot-testkit-prepared.v1",
    jobDigest: body.jobDigest,
    testKitDigest: body.testKitDigest,
    godotBinaryDigest: body.godotBinaryDigest,
    status: body.status,
    createdAt: body.createdAt,
    artifacts,
  });
}

async function verifyPreparedState(state: PreparedState, root: string, request: GodotTestKitRunRequest): Promise<void> {
  if (state.jobDigest !== request.jobDigest || state.testKitDigest !== request.testKitDigest
    || state.godotBinaryDigest !== request.godot.binaryDigest) invalid("prepared state binding");
  for (const artifact of state.artifacts) {
    if (!artifact.path.startsWith(`${root}${sep}`)) invalid("prepared artifact boundary");
    const observed = await fileDigest(artifact.path);
    if (observed.artifactDigest !== artifact.artifactDigest || observed.sizeBytes !== artifact.sizeBytes) invalid("prepared artifact content");
  }
}

async function collectRegularFiles(root: string): Promise<readonly Readonly<{
  relativePath: string;
  absolutePath: string;
  digest: string;
  sizeBytes: number;
}>[]> {
  const result: Array<{ relativePath: string; absolutePath: string; digest: string; sizeBytes: number }> = [];
  let directories = 0;
  let totalBytes = 0;
  const visit = async (current: string, depth: number): Promise<void> => {
    if (depth > 32 || directories > 100_000) invalid("export directory tree");
    for (const entry of await readdir(current, { withFileTypes: true })) {
      const absolutePath = join(current, entry.name);
      const metadata = await lstat(absolutePath);
      if (metadata.isSymbolicLink()) invalid("export symlink");
      if (metadata.isDirectory()) {
        directories += 1;
        if (directories > 100_000) invalid("export directory tree");
        await visit(absolutePath, depth + 1);
        continue;
      }
      if (!metadata.isFile() || metadata.size < 1 || metadata.size > 8 * 1024 * 1024 * 1024 || result.length >= 100_000) invalid("export file");
      totalBytes += metadata.size;
      if (!Number.isSafeInteger(totalBytes) || totalBytes > 64 * 1024 * 1024 * 1024) invalid("export total size");
      const observed = await fileDigest(absolutePath);
      result.push({
        relativePath: relative(root, absolutePath).split(sep).join("/"),
        absolutePath,
        digest: observed.artifactDigest,
        sizeBytes: observed.sizeBytes,
      });
    }
  };
  await visit(root, 0);
  result.sort((left, right) => left.relativePath.localeCompare(right.relativePath));
  return Object.freeze(result.map((item) => Object.freeze(item)));
}

function requireExecutionLease(
  request: GodotTestKitRunRequest,
  plan: import("./contracts").GodotTestPlan,
  now: Date,
): void {
  const maximumExecutionSeconds = plan.timeouts.importSeconds
    + (plan.timeouts.bootSeconds * 2)
    + plan.timeouts.suiteSeconds
    + plan.timeouts.exportSeconds;
  const leaseExpiresAt = Date.parse(request.signedJob.payload.leaseExpiresAt);
  if (!Number.isFinite(now.getTime()) || !Number.isFinite(leaseExpiresAt)
    || leaseExpiresAt - now.getTime() < (maximumExecutionSeconds + 300) * 1_000) {
    invalid("execution lease window");
  }
}

async function fileDigest(path: string): Promise<Readonly<{ artifactDigest: string; sizeBytes: number }>> {
  const metadata = await lstat(path);
  if (!metadata.isFile() || metadata.isSymbolicLink() || metadata.size < 1 || metadata.size > 8 * 1024 * 1024 * 1024) invalid("evidence file");
  const file = await open(path, "r");
  try {
    const hash = createHash("sha256");
    const buffer = Buffer.allocUnsafe(1024 * 1024);
    let position = 0;
    while (position < metadata.size) {
      const { bytesRead } = await file.read(buffer, 0, Math.min(buffer.byteLength, metadata.size - position), position);
      if (bytesRead < 1) invalid("evidence file read");
      hash.update(buffer.subarray(0, bytesRead));
      position += bytesRead;
    }
    const after = await file.stat();
    if (after.size !== metadata.size || after.mtimeMs !== metadata.mtimeMs) invalid("evidence file mutation");
    return Object.freeze({ artifactDigest: hash.digest("hex"), sizeBytes: metadata.size });
  } finally { await file.close(); }
}

async function writeImmutable(path: string, value: string): Promise<void> {
  const encoded = value.endsWith("\n") ? value : `${value}\n`;
  const file = await open(path, "wx", 0o400);
  try { await file.writeFile(encoded, "utf8"); await file.sync(); }
  finally { await file.close(); }
}

async function writeImmutableJson(path: string, value: unknown): Promise<void> {
  await writeImmutable(path, canonicalJson(value));
}

function canonicalBuffer(value: unknown): Buffer {
  return Buffer.from(canonicalJson(value), "utf8");
}

function junit(
  commands: readonly Readonly<{ id: string; status: "PASSED" | "FAILED"; durationMs: number; code: string }>[],
  harness: GodotDriverResult["harness"],
  status: "PASSED" | "FAILED",
): string {
  const tests = [
    ...commands.map((check) => ({ name: check.id, status: check.status, durationMs: check.durationMs, code: check.code })),
    ...(harness?.checks.map((check) => ({ name: check.id, status: check.status, durationMs: check.durationMs, code: check.code })) ?? []),
  ];
  const failures = tests.filter((check) => check.status === "FAILED").length + (status === "FAILED" && tests.length === 0 ? 1 : 0);
  const cases = tests.map((check) => `  <testcase classname="DeviLudo.PhysicalGodot" name="${xml(check.name)}" time="${(check.durationMs / 1_000).toFixed(3)}">${check.status === "FAILED" ? `<failure message="${xml(check.code)}"/>` : ""}</testcase>`).join("\n");
  return `<?xml version="1.0" encoding="UTF-8"?>\n<testsuite name="deviludo-physical-godot" tests="${tests.length}" failures="${failures}">\n${cases}\n</testsuite>\n`;
}

function sanitizeLog(value: string, root: string): string {
  const bounded = Buffer.from(value).subarray(0, 64 * 1024 * 1024).toString("utf8");
  const cleaned = bounded.replaceAll(root, "<run-root>").replace(/[\0]/g, "");
  return cleaned.trim() ? `${cleaned.trim()}\n` : "Godot TestKit produced no process output.\n";
}

function boundedChild(root: string, relativePath: string): string {
  const target = resolve(root, ...relativePath.split("/"));
  if (!target.startsWith(`${root}${sep}`)) invalid("artifact path");
  return target;
}

async function privateDirectory(value: string): Promise<string> {
  const path = absolutePath(value, "run root");
  const metadata = await lstat(path);
  if (!metadata.isDirectory() || metadata.isSymbolicLink()) invalid("run root");
  if (process.platform !== "win32") await chmod(path, 0o700);
  return path;
}

async function ensureDirectory(path: string): Promise<void> {
  await mkdir(path, { recursive: true, mode: 0o700 });
  const metadata = await lstat(path);
  if (!metadata.isDirectory() || metadata.isSymbolicLink()) invalid("input directory");
}

function absolutePath(value: string, label: string): string {
  if (!isAbsolute(value) || resolve(value) !== value || value.length > 4_096 || /\0/.test(value)) invalid(label);
  return value;
}

function isArtifactKind(value: unknown): value is TestKitArtifactKind {
  return value === "logs" || value === "junit" || value === "input-timeline"
    || value === "screenshot-manifest" || value === "video-manifest" || value === "production-export";
}

function record(value: unknown): Record<string, unknown> {
  if (!value || typeof value !== "object" || Array.isArray(value)) invalid("object");
  return value as Record<string, unknown>;
}

function exactKeys(value: Record<string, unknown>, expected: readonly string[]): void {
  const actual = Object.keys(value).sort();
  const sorted = [...expected].sort();
  if (actual.length !== sorted.length || actual.some((key, index) => key !== sorted[index])) invalid("fields");
}

function nowIso(now: () => Date): string {
  const date = now();
  if (!Number.isFinite(date.getTime())) invalid("clock");
  return date.toISOString();
}

function xml(value: string): string {
  return value.replaceAll("&", "&amp;").replaceAll("<", "&lt;").replaceAll(">", "&gt;").replaceAll('"', "&quot;");
}

function deepFreeze<T>(value: T): T {
  if (value && typeof value === "object" && !Object.isFrozen(value)) {
    Object.freeze(value);
    for (const child of Object.values(value as Record<string, unknown>)) deepFreeze(child);
  }
  return value;
}

function invalid(label: string): never {
  throw new Error(`Godot TestKit ${label} is invalid`);
}
