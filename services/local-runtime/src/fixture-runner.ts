import { execFile } from "node:child_process";
import { createHash } from "node:crypto";
import { constants as fsConstants } from "node:fs";
import { access, chmod, cp, lstat, mkdir, open, readFile, rename, rm, writeFile } from "node:fs/promises";
import path from "node:path";
import { promisify } from "node:util";
import { LocalGitScmProxy } from "../../scm-proxy/src/local-git";
import type {
  LocalExternalApprovalEvidence,
  LocalExternalApprovalRequest,
  LocalMainGateEvidence,
  LocalMainGateRequest,
  LocalRuntimeCheck,
  LocalRuntimeBinding,
  LocalRuntimeEvidence,
  LocalRuntimeRequest,
  LocalSteamReinstallEvidence,
  LocalSteamReinstallRequest,
} from "./contracts";
import { defaultGodotExportTemplatesRoot, mountExportTemplates } from "./export-templates";
import { inspectExtractedMacosBuild, validateMacosBuildArchive } from "./macos-export";
import { cleanupLocalSmokeStorage } from "./smoke-cleanup";

const execFileAsync = promisify(execFile);
const IDENTIFIER = /^[A-Za-z0-9][A-Za-z0-9-]{2,63}$/;
const OUTPUT_LIMIT = 2 * 1024 * 1024;
const COMMAND_TIMEOUT_MS = 60_000;
const BUILD_ARTIFACT_FILE = "DeviLudoLocal.zip" as const;
const MAIN_BUILD_ARTIFACT_FILE = "DeviLudoMain.zip" as const;
const LOCAL_BETA_ARTIFACT_FILE = "DeviLudoLocalBeta.zip" as const;
const MAX_BUILD_ARTIFACT_BYTES = 512 * 1024 * 1024;

type CommandResult = {
  exitCode: number;
  stdout: string;
  stderr: string;
  durationMs: number;
};

export class LocalFixtureRunner {
  readonly #repositoryRoot: string;
  readonly #fixtureRoot: string;
  readonly #storageRoot: string;
  readonly #agentStorageRoot: string;
  readonly #godotBinary: string;
  readonly #gitBinary: string;
  readonly #exportTemplatesRoot: string;
  readonly #scmProxy: LocalGitScmProxy;
  readonly #agentScmProxy: LocalGitScmProxy;

  constructor(options: {
    repositoryRoot: string;
    fixtureRoot?: string;
    storageRoot?: string;
    agentStorageRoot?: string;
    godotBinary?: string;
    gitBinary?: string;
    exportTemplatesRoot?: string;
  }) {
    this.#repositoryRoot = path.resolve(options.repositoryRoot);
    this.#fixtureRoot = path.resolve(options.fixtureRoot ?? path.join(this.#repositoryRoot, "fixtures/godot-smoke"));
    this.#storageRoot = path.resolve(options.storageRoot ?? path.join(this.#repositoryRoot, ".deviludo/local-runtime"));
    this.#agentStorageRoot = path.resolve(options.agentStorageRoot ?? path.join(this.#repositoryRoot, ".deviludo/local-agent-runtime"));
    this.#godotBinary = path.resolve(options.godotBinary ?? "/Applications/Godot.app/Contents/MacOS/Godot");
    this.#gitBinary = path.resolve(options.gitBinary ?? "/usr/bin/git");
    this.#exportTemplatesRoot = path.resolve(options.exportTemplatesRoot ?? defaultGodotExportTemplatesRoot());
    this.#scmProxy = new LocalGitScmProxy({ storageRoot: this.#storageRoot, gitBinary: this.#gitBinary });
    this.#agentScmProxy = new LocalGitScmProxy({ storageRoot: this.#agentStorageRoot, gitBinary: this.#gitBinary });
  }

  get storageRoot() { return this.#storageRoot; }
  get agentStorageRoot() { return this.#agentStorageRoot; }
  get godotBinary() { return this.#godotBinary; }
  get exportTemplatesRoot() { return this.#exportTemplatesRoot; }

  async cleanupSmokeProjects(projectIds: readonly string[]) {
    return cleanupLocalSmokeStorage([this.#storageRoot, this.#agentStorageRoot], projectIds);
  }

  async godotVersion(): Promise<string> {
    const result = await this.#command(this.#godotBinary, ["--version"], this.#repositoryRoot, {
      NODE_ENV: "test",
      PATH: "/usr/local/bin:/usr/bin:/bin:/usr/sbin:/sbin",
      LANG: "C.UTF-8",
    });
    if (result.exitCode !== 0) throw new Error("Godot executable is unavailable");
    return result.stdout.trim();
  }

  evidenceDirectory(request: Pick<LocalRuntimeRequest, "projectId" | "runId">) {
    validateIdentifier(request.projectId, "projectId");
    validateIdentifier(request.runId, "runId");
    return path.join(this.#storageRoot, request.projectId, request.runId, "evidence");
  }

  artifactDirectory(request: Pick<LocalRuntimeRequest, "projectId" | "runId">) {
    validateIdentifier(request.projectId, "projectId");
    validateIdentifier(request.runId, "runId");
    return path.join(this.#storageRoot, request.projectId, request.runId, "artifacts");
  }

  mainEvidenceDirectory(request: Pick<LocalRuntimeRequest, "projectId" | "runId">) {
    validateIdentifier(request.projectId, "projectId");
    validateIdentifier(request.runId, "runId");
    return path.join(this.#storageRoot, request.projectId, request.runId, "main-gate", "evidence");
  }

  mainArtifactDirectory(request: Pick<LocalRuntimeRequest, "projectId" | "runId">) {
    validateIdentifier(request.projectId, "projectId");
    validateIdentifier(request.runId, "runId");
    return path.join(this.#storageRoot, request.projectId, request.runId, "main-gate", "artifacts");
  }

  steamReinstallEvidenceDirectory(request: Pick<LocalRuntimeRequest, "projectId" | "runId">) {
    validateIdentifier(request.projectId, "projectId");
    validateIdentifier(request.runId, "runId");
    return path.join(this.#storageRoot, request.projectId, request.runId, "steam-reinstall", "evidence");
  }

  steamBetaArtifactDirectory(request: Pick<LocalRuntimeRequest, "projectId" | "runId">) {
    validateIdentifier(request.projectId, "projectId");
    validateIdentifier(request.runId, "runId");
    return path.join(this.#storageRoot, request.projectId, request.runId, "steam-reinstall", "artifacts");
  }

  async readEvidence(request: Pick<LocalRuntimeRequest, "projectId" | "runId">) {
    const file = path.join(this.evidenceDirectory(request), "manifest.json");
    return JSON.parse(await readFile(file, "utf8")) as LocalRuntimeEvidence;
  }

  async readMainEvidence(request: Pick<LocalRuntimeRequest, "projectId" | "runId">) {
    const file = path.join(this.mainEvidenceDirectory(request), "manifest.json");
    return JSON.parse(await readFile(file, "utf8")) as LocalMainGateEvidence;
  }

  async readSteamReinstallEvidence(request: Pick<LocalRuntimeRequest, "projectId" | "runId">) {
    const file = path.join(this.steamReinstallEvidenceDirectory(request), "manifest.json");
    const evidence = JSON.parse(await readFile(file, "utf8")) as LocalSteamReinstallEvidence;
    const { evidenceId, bundleDigest, ...unsigned } = evidence;
    if (!/^EV-STEAM-[A-F0-9]{12}$/.test(evidenceId)
      || !/^[a-f0-9]{64}$/.test(bundleDigest)
      || sha256(JSON.stringify(unsigned)) !== bundleDigest
      || evidenceId !== `EV-STEAM-${bundleDigest.slice(0, 12).toUpperCase()}`) {
      throw new Error("Local Steam reinstall evidence digest is invalid");
    }
    return evidence;
  }

  externalApprovalEvidenceDirectory(
    request: Pick<LocalRuntimeRequest, "projectId" | "runId">,
    sequence: number,
  ) {
    validateIdentifier(request.projectId, "projectId");
    validateIdentifier(request.runId, "runId");
    if (!Number.isInteger(sequence) || sequence < 1 || sequence > 3) throw new Error("Local approval sequence is invalid");
    return path.join(this.#storageRoot, request.projectId, request.runId, "external-approvals", String(sequence), "evidence");
  }

  async readExternalApprovalEvidence(
    request: Pick<LocalRuntimeRequest, "projectId" | "runId">,
    sequence: number,
  ) {
    const file = path.join(this.externalApprovalEvidenceDirectory(request, sequence), "manifest.json");
    const evidence = JSON.parse(await readFile(file, "utf8")) as LocalExternalApprovalEvidence;
    const { evidenceId, bundleDigest, ...unsigned } = evidence;
    if (!/^EV-APPROVAL-[A-F0-9]{12}$/.test(evidenceId)
      || !/^[a-f0-9]{64}$/.test(bundleDigest)
      || sha256(JSON.stringify(unsigned)) !== bundleDigest
      || evidenceId !== `EV-APPROVAL-${bundleDigest.slice(0, 12).toUpperCase()}`) {
      throw new Error("Local external approval evidence digest is invalid");
    }
    return evidence;
  }

  async readBuildArtifact(
    request: Pick<LocalRuntimeRequest, "projectId" | "runId">,
    fileName: string,
  ): Promise<{ evidence: LocalRuntimeEvidence; bytes: Buffer }> {
    if (fileName !== BUILD_ARTIFACT_FILE) throw new Error("Local build artifact does not exist");
    const evidence = await this.readEvidence(request);
    const binding = evidence.buildArtifact;
    if (evidence.schemaVersion !== 4
      || evidence.releaseGate !== "LOCAL_VALIDATION_PASSED"
      || evidence.status !== "TESTS_PASSED"
      || !binding
      || binding.fileName !== fileName
      || binding.platform !== "macos"
      || binding.contentType !== "application/zip"
      || !/^[a-f0-9]{64}$/.test(binding.sha256)
      || !Number.isSafeInteger(binding.sizeBytes)
      || binding.sizeBytes < 1
      || binding.sizeBytes > MAX_BUILD_ARTIFACT_BYTES) {
      throw new Error("Local build artifact is not authorized by the evidence manifest");
    }
    const artifactPath = path.join(this.artifactDirectory(request), BUILD_ARTIFACT_FILE);
    const before = await lstat(artifactPath);
    if (!before.isFile() || before.isSymbolicLink() || before.size !== binding.sizeBytes) {
      throw new Error("Local build artifact metadata does not match its evidence manifest");
    }
    const file = await open(artifactPath, fsConstants.O_RDONLY | fsConstants.O_NOFOLLOW);
    try {
      const bytes = await file.readFile();
      const after = await file.stat();
      if (!after.isFile()
        || after.size !== before.size
        || after.mtimeMs !== before.mtimeMs
        || after.ctimeMs !== before.ctimeMs
        || bytes.byteLength !== binding.sizeBytes
        || sha256(bytes) !== binding.sha256) {
        throw new Error("Local build artifact bytes do not match their evidence manifest");
      }
      return { evidence, bytes };
    } finally {
      await file.close();
    }
  }

  async readMainBuildArtifact(
    request: Pick<LocalRuntimeRequest, "projectId" | "runId">,
    fileName: string,
  ): Promise<{ evidence: LocalMainGateEvidence; bytes: Buffer }> {
    if (fileName !== MAIN_BUILD_ARTIFACT_FILE) throw new Error("Local main build artifact does not exist");
    const evidence = await this.readMainEvidence(request);
    const binding = evidence.buildArtifact;
    if (evidence.schemaVersion !== 1
      || evidence.phase !== "MAIN_SHA_GATE"
      || evidence.releaseGate !== "MAIN_VALIDATION_PASSED"
      || evidence.status !== "TESTS_PASSED"
      || !binding
      || binding.fileName !== fileName
      || binding.platform !== "macos"
      || binding.contentType !== "application/zip"
      || !/^[a-f0-9]{64}$/.test(binding.sha256)
      || !Number.isSafeInteger(binding.sizeBytes)
      || binding.sizeBytes < 1
      || binding.sizeBytes > MAX_BUILD_ARTIFACT_BYTES) {
      throw new Error("Local main build artifact is not authorized by the evidence manifest");
    }
    const artifactPath = path.join(this.mainArtifactDirectory(request), MAIN_BUILD_ARTIFACT_FILE);
    const before = await lstat(artifactPath);
    if (!before.isFile() || before.isSymbolicLink() || before.size !== binding.sizeBytes) {
      throw new Error("Local main build artifact metadata does not match its evidence manifest");
    }
    const file = await open(artifactPath, fsConstants.O_RDONLY | fsConstants.O_NOFOLLOW);
    try {
      const bytes = await file.readFile();
      const after = await file.stat();
      if (!after.isFile()
        || after.size !== before.size
        || after.mtimeMs !== before.mtimeMs
        || after.ctimeMs !== before.ctimeMs
        || bytes.byteLength !== binding.sizeBytes
        || sha256(bytes) !== binding.sha256) {
        throw new Error("Local main build artifact bytes do not match their evidence manifest");
      }
      return { evidence, bytes };
    } finally {
      await file.close();
    }
  }

  async readSteamBetaArtifact(
    request: Pick<LocalRuntimeRequest, "projectId" | "runId">,
    fileName: string,
  ): Promise<{ evidence: LocalSteamReinstallEvidence; bytes: Buffer }> {
    if (fileName !== LOCAL_BETA_ARTIFACT_FILE) throw new Error("Local Beta artifact does not exist");
    const evidence = await this.readSteamReinstallEvidence(request);
    const binding = evidence.betaArtifact;
    if (evidence.schemaVersion !== 1
      || evidence.phase !== "LOCAL_STEAM_REINSTALL"
      || evidence.localOnly !== true
      || evidence.releaseGate !== "LOCAL_STEAM_REINSTALL_PASSED"
      || evidence.status !== "TESTS_PASSED"
      || !binding
      || binding.fileName !== fileName
      || binding.platform !== "macos"
      || binding.contentType !== "application/zip"
      || !/^[a-f0-9]{64}$/.test(binding.sha256)
      || !Number.isSafeInteger(binding.sizeBytes)
      || binding.sizeBytes < 1
      || binding.sizeBytes > MAX_BUILD_ARTIFACT_BYTES) {
      throw new Error("Local Beta artifact is not authorized by its reinstall evidence");
    }
    const artifactPath = path.join(this.steamBetaArtifactDirectory(request), LOCAL_BETA_ARTIFACT_FILE);
    const before = await lstat(artifactPath);
    if (!before.isFile() || before.isSymbolicLink() || before.size !== binding.sizeBytes) {
      throw new Error("Local Beta artifact metadata does not match its reinstall evidence");
    }
    const file = await open(artifactPath, fsConstants.O_RDONLY | fsConstants.O_NOFOLLOW);
    try {
      const bytes = await file.readFile();
      const after = await file.stat();
      if (!after.isFile()
        || after.size !== before.size
        || after.mtimeMs !== before.mtimeMs
        || after.ctimeMs !== before.ctimeMs
        || bytes.byteLength !== binding.sizeBytes
        || sha256(bytes) !== binding.sha256) {
        throw new Error("Local Beta artifact bytes do not match their reinstall evidence");
      }
      return { evidence, bytes };
    } finally {
      await file.close();
    }
  }

  async run(request: LocalRuntimeRequest): Promise<LocalRuntimeEvidence> {
    validateRequest(request);
    validateSourceAuthority(request);
    try {
      const existing = await this.readEvidence(request);
      assertEvidenceBinding(existing, request);
      if (existing.releaseGate !== "WAITING_EXPORT_TEMPLATES") {
        if (existing.releaseGate === "LOCAL_VALIDATION_PASSED") {
          await this.readBuildArtifact(request, BUILD_ARTIFACT_FILE);
        }
        return existing;
      }
      // Dependency waits are not terminal and may be retried after the exact
      // matching export templates are installed.
    } catch (error) {
      if ((error as NodeJS.ErrnoException).code !== "ENOENT" && !(error instanceof StaleLocalEvidenceError)) throw error;
      // A missing or older-schema manifest cannot satisfy the current gate.
      // The partial-run archive below preserves it for local audit before a
      // fresh v4 evidence bundle is created.
    }

    await access(this.#godotBinary);
    await access(this.#gitBinary);
    await mkdir(this.#storageRoot, { recursive: true });

    const runRoot = path.join(this.#storageRoot, request.projectId, request.runId);
    const workspace = path.join(runRoot, "workspace");
    const evidence = path.join(runRoot, "evidence");
    const runtimeHome = path.join(runRoot, "home");
    const runtimeTemp = path.join(runRoot, "tmp");
    await archivePartialRun(runRoot, path.join(this.#storageRoot, ".scm", request.projectId, request.runId));
    await mkdir(evidence, { recursive: true });
    await mkdir(runtimeHome, { recursive: true });
    await mkdir(runtimeTemp, { recursive: true });
    await mkdir(workspace, { recursive: true });

    const candidate = request.sourceAuthority.kind === "FIXTURE"
      ? await this.#prepareFixtureCandidate(request, workspace)
      : await this.#materializeAgentCandidate(request, workspace);

    const environment: NodeJS.ProcessEnv = {
      NODE_ENV: "test",
      PATH: "/usr/local/bin:/usr/bin:/bin:/usr/sbin:/sbin",
      LANG: "C.UTF-8",
      HOME: runtimeHome,
      TMPDIR: runtimeTemp,
    };
    const log: string[] = [
      `[source-authority] kind=${request.sourceAuthority.kind} attempt=${request.sourceAuthority.attemptId}`,
      `[scm-proxy] base=${candidate.baseCommitSha} candidate=${candidate.commitSha} source=${candidate.sourceDigest}`,
    ];
    const candidateSha = candidate.commitSha;
    const sourceDigest = candidate.sourceDigest;
    const godotVersion = await this.godotVersion();
    const mountedTemplates = await mountExportTemplates({
      runtimeHome,
      templatesRoot: this.#exportTemplatesRoot,
      godotVersion,
    });

    const checks: LocalRuntimeCheck[] = [];
    const imported = await this.#checked(
      this.#godotBinary,
      ["--headless", "--path", workspace, "--editor", "--quit"],
      workspace,
      environment,
      log,
    );
    checks.push(check("import", imported, "Godot project imported and scripts parsed"));

    const booted = await this.#checked(
      this.#godotBinary,
      ["--headless", "--path", workspace, "--quit-after", "120"],
      workspace,
      environment,
      log,
    );
    if (!booted.stdout.includes("DEVILUDO_FIXTURE_BOOT:")) throw new Error("Godot boot marker is missing");
    checks.push(check("boot", booted, "Main scene started and exited cleanly"));

    const tested = await this.#checked(
      this.#godotBinary,
      ["--headless", "--path", workspace, "--script", "res://tests/e2e.gd"],
      workspace,
      environment,
      log,
    );
    const e2e = parseE2EResult(tested.stdout);
    checks.push({ name: "core-loop", status: "PASSED", durationMs: tested.durationMs, detail: `${e2e.checks.length} deterministic checks passed` });
    checks.push({ name: "save-load", status: "PASSED", durationMs: e2e.duration_ms, detail: "JSON save was written, read and restored exactly" });
    checks.push({ name: "performance", status: "PASSED", durationMs: e2e.duration_ms, detail: "Headless core loop stayed below the 250ms fixture budget" });

    const exportPath = path.join(runRoot, "artifacts", BUILD_ARTIFACT_FILE);
    await mkdir(path.dirname(exportPath), { recursive: true });
    const exported = await this.#command(
      this.#godotBinary,
      ["--headless", "--path", workspace, "--export-debug", "macOS", exportPath],
      workspace,
      environment,
    );
    log.push(formatCommand(this.#godotBinary, ["--headless", "--path", "<workspace>", "--export-debug", "macOS", "<artifact>"]), sanitize(exported, workspace, runtimeHome, runtimeTemp));
    const exportPassed = exported.exitCode === 0;
    const exportDiagnostics = `${exported.stdout}\n${exported.stderr}`;
    const exportTemplatesMissing = !exportPassed && /(export_templates|export templates?|导出模板)/i.test(exportDiagnostics);
    checks.push({
      name: "macos-export",
      status: exportPassed ? "PASSED" : exportTemplatesMissing ? "WAITING_DEPENDENCY" : "FAILED",
      durationMs: exported.durationMs,
      detail: exportPassed
        ? `Unsigned local macOS debug export created with pinned template ${mountedTemplates?.macosTemplateSha256 ?? "unverified"}`
        : exportTemplatesMissing
          ? "Pinned Godot macOS export templates are not installed"
          : "Godot macOS export failed for a reason other than missing templates",
    });

    const exportBoot = exportPassed
      ? await this.#launchMacosArtifact({
        exportPath,
        exportSmokeRoot: path.join(runRoot, "export-smoke"),
        runRoot,
        environment,
        runtimeHome,
        runtimeTemp,
        log,
      })
      : {
        passed: false,
        durationMs: 0,
        detail: exportTemplatesMissing
          ? "Production export startup is waiting for the pinned macOS export templates"
          : "Production export startup was not attempted because export failed",
      };
    checks.push({
      name: "macos-export-boot",
      status: exportBoot.passed ? "PASSED" : exportTemplatesMissing ? "WAITING_DEPENDENCY" : "FAILED",
      durationMs: exportBoot.durationMs,
      detail: exportBoot.detail,
    });

    const createdAt = new Date().toISOString();
    const junit = junitXml(e2e, tested.durationMs);
    const godotLog = `${log.join("\n\n")}\n`;
    const artifactDigests = {
      "junit.xml": sha256(junit),
      "godot.log": sha256(godotLog),
    };
    const status = exportPassed && exportBoot.passed
      ? "TESTS_PASSED" as const
      : exportTemplatesMissing
        ? "WAITING_DEPENDENCY" as const
        : "FAILED" as const;
    const releaseGate = exportPassed && exportBoot.passed
      ? "LOCAL_VALIDATION_PASSED" as const
      : exportTemplatesMissing
        ? "WAITING_EXPORT_TEMPLATES" as const
        : "TESTS_FAILED" as const;
    const exportedBytes = exportPassed && exportBoot.passed ? await readFile(exportPath) : null;
    const buildArtifact = exportedBytes ? {
      fileName: BUILD_ARTIFACT_FILE,
      platform: "macos" as const,
      contentType: "application/zip" as const,
      sha256: sha256(exportedBytes),
      sizeBytes: exportedBytes.byteLength,
    } : null;
    const unsigned = {
      schemaVersion: 4 as const,
      projectId: request.projectId,
      runId: request.runId,
      specRevisionId: request.specRevisionId,
      targetMatrix: Object.freeze([...request.targetMatrix]),
      platform: "macos" as const,
      status,
      releaseGate,
      candidateSha,
      sourceDigest,
      godotVersion,
      checks,
      artifacts: ["manifest.json", "junit.xml", "godot.log"] as LocalRuntimeEvidence["artifacts"],
      artifactDigests,
      buildArtifact,
      testPlan: "deviludo-local-testkit-1.0.0" as const,
      fixtureOnly: request.sourceAuthority.kind === "FIXTURE",
      sourceAuthority: request.sourceAuthority,
      createdAt,
    };
    const bundleDigest = sha256(JSON.stringify(unsigned));
    const manifest: LocalRuntimeEvidence = {
      ...unsigned,
      evidenceId: `EV-LOCAL-${bundleDigest.slice(0, 12).toUpperCase()}`,
      bundleDigest,
    };
    await writeFile(path.join(evidence, "junit.xml"), junit, "utf8");
    await writeFile(path.join(evidence, "godot.log"), godotLog, "utf8");
    await writeFile(path.join(evidence, "manifest.json"), `${JSON.stringify(manifest, null, 2)}\n`, "utf8");
    return manifest;
  }

  async #prepareFixtureCandidate(request: LocalRuntimeRequest, workspace: string) {
    await access(this.#fixtureRoot);
    const scmBinding = {
      projectId: request.projectId,
      runId: request.runId,
      attemptId: request.sourceAuthority.attemptId,
      specRevisionId: request.specRevisionId,
      workspaceRoot: workspace,
    };
    const base = await this.#scmProxy.prepare(scmBinding);
    await cp(this.#fixtureRoot, workspace, { recursive: true, force: false });
    return this.#scmProxy.finalize({
      ...scmBinding,
      expectedBaseCommitSha: base.baseCommitSha,
      candidateBranch: `deviludo/local/${sha256(`${request.projectId}:${request.runId}`).slice(0, 16)}`,
      commitMessage: `fixture: implement ${request.specRevisionId}`,
    });
  }

  async #materializeAgentCandidate(request: LocalRuntimeRequest, destinationRoot: string) {
    if (request.sourceAuthority.kind !== "AGENT_CANDIDATE") throw new Error("Agent candidate authority is required");
    const sourceWorkspace = this.#agentWorkspace(request.projectId, request.runId, request.sourceAuthority.attemptId);
    await access(sourceWorkspace);
    return this.#agentScmProxy.materializeCandidate({
      projectId: request.projectId,
      runId: request.runId,
      attemptId: request.sourceAuthority.attemptId,
      specRevisionId: request.specRevisionId,
      workspaceRoot: sourceWorkspace,
      expectedBranch: request.sourceAuthority.branch,
      expectedBaseCommitSha: request.sourceAuthority.baseCommitSha,
      expectedCandidateCommitSha: request.sourceAuthority.candidateSha,
      expectedSourceDigest: request.sourceAuthority.sourceDigest,
      destinationRoot,
    });
  }

  #agentWorkspace(projectId: string, runId: string, attemptId: string) {
    return path.join(this.#agentStorageRoot, projectId, runId, attemptId, "workspace");
  }

  async runMainGate(request: LocalMainGateRequest): Promise<LocalMainGateEvidence> {
    validateMainGateRequest(request);
    const candidate = await this.readBuildArtifact(request, BUILD_ARTIFACT_FILE);
    if (candidate.evidence.evidenceId !== request.candidateEvidenceId
      || candidate.evidence.bundleDigest !== request.candidateBundleDigest
      || candidate.evidence.candidateSha !== request.candidateSha
      || candidate.evidence.sourceDigest !== request.sourceDigest
      || candidate.evidence.specRevisionId !== request.specRevisionId
      || JSON.stringify(candidate.evidence.targetMatrix) !== JSON.stringify(request.targetMatrix)) {
      throw new Error("Accepted candidate evidence does not match the main gate request");
    }
    try {
      const existing = await this.readMainEvidence(request);
      assertMainEvidenceBinding(existing, request);
      if (existing.releaseGate !== "WAITING_EXPORT_TEMPLATES") {
        if (existing.releaseGate === "MAIN_VALIDATION_PASSED") {
          await this.readMainBuildArtifact(request, MAIN_BUILD_ARTIFACT_FILE);
        }
        return existing;
      }
    } catch (error) {
      if ((error as NodeJS.ErrnoException).code !== "ENOENT") throw error;
    }

    const runRoot = path.join(this.#storageRoot, request.projectId, request.runId);
    const workspace = path.join(runRoot, "workspace");
    const mainRoot = path.join(runRoot, "main-gate");
    const evidence = path.join(mainRoot, "evidence");
    const runtimeHome = path.join(mainRoot, "home");
    const runtimeTemp = path.join(mainRoot, "tmp");
    await access(workspace);
    await archiveDirectory(mainRoot);
    await mkdir(evidence, { recursive: true });
    await mkdir(runtimeHome, { recursive: true });
    await mkdir(runtimeTemp, { recursive: true });

    const sourceAuthority = candidate.evidence.sourceAuthority;
    const sourceWorkspace = sourceAuthority.kind === "FIXTURE"
      ? workspace
      : this.#agentWorkspace(request.projectId, request.runId, sourceAuthority.attemptId);
    const sourceProxy = sourceAuthority.kind === "FIXTURE" ? this.#scmProxy : this.#agentScmProxy;
    const merge = await sourceProxy.merge({
      projectId: request.projectId,
      runId: request.runId,
      attemptId: sourceAuthority.attemptId,
      specRevisionId: request.specRevisionId,
      workspaceRoot: sourceWorkspace,
      expectedCandidateCommitSha: request.candidateSha,
      expectedSourceDigest: request.sourceDigest,
    });
    const environment: NodeJS.ProcessEnv = {
      NODE_ENV: "test",
      PATH: "/usr/local/bin:/usr/bin:/bin:/usr/sbin:/sbin",
      LANG: "C.UTF-8",
      HOME: runtimeHome,
      TMPDIR: runtimeTemp,
    };
    const log = [
      `[scm-proxy] merged candidate=${merge.candidateCommitSha} main=${merge.mainCommitSha} source=${merge.sourceDigest}`,
      `[candidate-evidence] id=${request.candidateEvidenceId} bundle=${request.candidateBundleDigest}`,
    ];
    const godotVersion = await this.godotVersion();
    const mountedTemplates = await mountExportTemplates({
      runtimeHome,
      templatesRoot: this.#exportTemplatesRoot,
      godotVersion,
    });
    const checks: LocalRuntimeCheck[] = [];
    const imported = await this.#checked(
      this.#godotBinary, ["--headless", "--path", workspace, "--editor", "--quit"], workspace, environment, log,
    );
    checks.push(check("import", imported, "Merged main project imported and scripts parsed"));
    const booted = await this.#checked(
      this.#godotBinary, ["--headless", "--path", workspace, "--quit-after", "120"], workspace, environment, log,
    );
    if (!booted.stdout.includes("DEVILUDO_FIXTURE_BOOT:")) throw new Error("Merged main boot marker is missing");
    checks.push(check("boot", booted, "Merged main scene started and exited cleanly"));
    const tested = await this.#checked(
      this.#godotBinary, ["--headless", "--path", workspace, "--script", "res://tests/e2e.gd"], workspace, environment, log,
    );
    const e2e = parseE2EResult(tested.stdout);
    checks.push({ name: "core-loop", status: "PASSED", durationMs: tested.durationMs, detail: `${e2e.checks.length} merged-main deterministic checks passed` });
    checks.push({ name: "save-load", status: "PASSED", durationMs: e2e.duration_ms, detail: "Merged-main save was written, read and restored exactly" });
    checks.push({ name: "performance", status: "PASSED", durationMs: e2e.duration_ms, detail: "Merged-main core loop stayed below the 250ms fixture budget" });

    const exportPath = path.join(this.mainArtifactDirectory(request), MAIN_BUILD_ARTIFACT_FILE);
    await mkdir(path.dirname(exportPath), { recursive: true });
    const exported = await this.#command(
      this.#godotBinary,
      ["--headless", "--path", workspace, "--export-debug", "macOS", exportPath],
      workspace,
      environment,
    );
    log.push(formatCommand(this.#godotBinary, ["--headless", "--path", "<workspace>", "--export-debug", "macOS", "<main-artifact>"]), sanitize(exported, workspace, runtimeHome, runtimeTemp));
    const exportPassed = exported.exitCode === 0;
    const exportDiagnostics = `${exported.stdout}\n${exported.stderr}`;
    const exportTemplatesMissing = !exportPassed && /(export_templates|export templates?|导出模板)/i.test(exportDiagnostics);
    checks.push({
      name: "macos-export",
      status: exportPassed ? "PASSED" : exportTemplatesMissing ? "WAITING_DEPENDENCY" : "FAILED",
      durationMs: exported.durationMs,
      detail: exportPassed
        ? `Merged-main macOS debug export created with pinned template ${mountedTemplates?.macosTemplateSha256 ?? "unverified"}`
        : exportTemplatesMissing
          ? "Pinned Godot macOS export templates are not installed"
          : "Merged-main Godot macOS export failed",
    });
    const exportBoot = exportPassed
      ? await this.#launchMacosArtifact({
        exportPath,
        exportSmokeRoot: path.join(mainRoot, "export-smoke"),
        runRoot: mainRoot,
        environment,
        runtimeHome,
        runtimeTemp,
        log,
      })
      : {
        passed: false,
        durationMs: 0,
        detail: exportTemplatesMissing
          ? "Merged-main export startup is waiting for the pinned macOS export templates"
          : "Merged-main export startup was not attempted because export failed",
      };
    checks.push({
      name: "macos-export-boot",
      status: exportBoot.passed ? "PASSED" : exportTemplatesMissing ? "WAITING_DEPENDENCY" : "FAILED",
      durationMs: exportBoot.durationMs,
      detail: exportBoot.detail,
    });

    const status = exportPassed && exportBoot.passed
      ? "TESTS_PASSED" as const
      : exportTemplatesMissing ? "WAITING_DEPENDENCY" as const : "FAILED" as const;
    const releaseGate = exportPassed && exportBoot.passed
      ? "MAIN_VALIDATION_PASSED" as const
      : exportTemplatesMissing ? "WAITING_EXPORT_TEMPLATES" as const : "TESTS_FAILED" as const;
    const exportedBytes = exportPassed && exportBoot.passed ? await readFile(exportPath) : null;
    const buildArtifact = exportedBytes ? {
      fileName: MAIN_BUILD_ARTIFACT_FILE,
      platform: "macos" as const,
      contentType: "application/zip" as const,
      sha256: sha256(exportedBytes),
      sizeBytes: exportedBytes.byteLength,
    } : null;
    const createdAt = new Date().toISOString();
    const junit = junitXml(e2e, tested.durationMs);
    const godotLog = `${log.join("\n\n")}\n`;
    const artifactDigests = { "junit.xml": sha256(junit), "godot.log": sha256(godotLog) };
    const unsigned = {
      schemaVersion: 1 as const,
      phase: "MAIN_SHA_GATE" as const,
      projectId: request.projectId,
      runId: request.runId,
      specRevisionId: request.specRevisionId,
      targetMatrix: Object.freeze([...request.targetMatrix]),
      platform: "macos" as const,
      status,
      releaseGate,
      candidateEvidenceId: request.candidateEvidenceId,
      candidateBundleDigest: request.candidateBundleDigest,
      candidateSha: request.candidateSha,
      sourceDigest: request.sourceDigest,
      mainSha: merge.mainCommitSha,
      mainSourceDigest: merge.sourceDigest,
      mergeReceipt: {
        scmProxy: merge.scmProxy,
        branch: merge.branch,
        candidateCommitSha: merge.candidateCommitSha,
        mainCommitSha: merge.mainCommitSha,
        sourceDigest: merge.sourceDigest,
        mergedAt: merge.mergedAt,
      },
      godotVersion,
      checks,
      artifacts: ["manifest.json", "junit.xml", "godot.log"] as LocalMainGateEvidence["artifacts"],
      artifactDigests,
      buildArtifact,
      testPlan: "deviludo-local-testkit-1.0.0" as const,
      fixtureOnly: candidate.evidence.fixtureOnly,
      sourceAuthority,
      createdAt,
    };
    const bundleDigest = sha256(JSON.stringify(unsigned));
    const manifest: LocalMainGateEvidence = {
      ...unsigned,
      evidenceId: `EV-MAIN-${bundleDigest.slice(0, 12).toUpperCase()}`,
      bundleDigest,
    };
    await writeFile(path.join(evidence, "junit.xml"), junit, "utf8");
    await writeFile(path.join(evidence, "godot.log"), godotLog, "utf8");
    await writeFile(path.join(evidence, "manifest.json"), `${JSON.stringify(manifest, null, 2)}\n`, "utf8");
    return manifest;
  }

  async runSteamReinstall(request: LocalSteamReinstallRequest): Promise<LocalSteamReinstallEvidence> {
    validateSteamReinstallRequest(request);
    const main = await this.readMainBuildArtifact(request, MAIN_BUILD_ARTIFACT_FILE);
    if (main.evidence.evidenceId !== request.mainEvidenceId
      || main.evidence.bundleDigest !== request.mainBundleDigest
      || main.evidence.mainSha !== request.mainSha
      || main.evidence.mainSourceDigest !== request.mainSourceDigest
      || main.evidence.buildArtifact?.sha256 !== request.mainArtifactSha256
      || main.evidence.specRevisionId !== request.specRevisionId
      || JSON.stringify(main.evidence.targetMatrix) !== JSON.stringify(request.targetMatrix)) {
      throw new Error("Local Beta request does not match the passed main evidence");
    }
    try {
      const existing = await this.readSteamReinstallEvidence(request);
      assertSteamReinstallEvidenceBinding(existing, request);
      if (existing.releaseGate === "LOCAL_STEAM_REINSTALL_PASSED") {
        await this.readSteamBetaArtifact(request, LOCAL_BETA_ARTIFACT_FILE);
      }
      return existing;
    } catch (error) {
      if ((error as NodeJS.ErrnoException).code !== "ENOENT") throw error;
    }

    const runRoot = path.join(this.#storageRoot, request.projectId, request.runId);
    const steamRoot = path.join(runRoot, "steam-reinstall");
    const evidenceRoot = path.join(steamRoot, "evidence");
    const artifactRoot = path.join(steamRoot, "artifacts");
    const runtimeHome = path.join(steamRoot, "home");
    const runtimeTemp = path.join(steamRoot, "tmp");
    await archiveDirectory(steamRoot);
    await mkdir(evidenceRoot, { recursive: true });
    await mkdir(artifactRoot, { recursive: true });
    await mkdir(runtimeHome, { recursive: true });
    await mkdir(runtimeTemp, { recursive: true });

    const environment: NodeJS.ProcessEnv = {
      NODE_ENV: "test",
      PATH: "/usr/local/bin:/usr/bin:/bin:/usr/sbin:/sbin",
      LANG: "C.UTF-8",
      HOME: runtimeHome,
      TMPDIR: runtimeTemp,
    };
    const betaPath = path.join(artifactRoot, LOCAL_BETA_ARTIFACT_FILE);
    const packageStarted = performance.now();
    await writeFile(betaPath, main.bytes, { mode: 0o600 });
    const copied = await readFile(betaPath);
    const packagePassed = copied.byteLength === main.bytes.byteLength
      && sha256(copied) === request.mainArtifactSha256;
    if (packagePassed) await chmod(betaPath, 0o400);
    const checks: LocalSteamReinstallEvidence["checks"] = [{
      name: "beta-package-integrity",
      status: packagePassed ? "PASSED" : "FAILED",
      durationMs: Math.round(performance.now() - packageStarted),
      detail: packagePassed
        ? "Immutable local Beta package exactly matches the main-gate artifact digest"
        : "Local Beta package digest did not match the main-gate artifact",
    }];
    const log = [
      "[local-only] No Steam endpoint or credential was used.",
      `[main] evidence=${request.mainEvidenceId} sha=${request.mainSha} artifact=${request.mainArtifactSha256}`,
      `[mfa] approval=${request.mfaApprovalId}`,
      `[beta] branch=local-password-beta bytes=${copied.byteLength} digest=${sha256(copied)}`,
    ];
    const reinstall = packagePassed
      ? await this.#launchMacosArtifact({
        exportPath: betaPath,
        exportSmokeRoot: path.join(steamRoot, "clean-install"),
        runRoot: steamRoot,
        environment,
        runtimeHome,
        runtimeTemp,
        log,
      })
      : { passed: false, durationMs: 0, detail: "Clean reinstall was not attempted because the Beta package failed integrity verification" };
    checks.push({
      name: "clean-reinstall-boot",
      status: reinstall.passed ? "PASSED" : "FAILED",
      durationMs: reinstall.durationMs,
      detail: reinstall.passed
        ? "Cleanly extracted local Beta app started from an isolated install root and exited cleanly"
        : reinstall.detail,
    });

    const passed = packagePassed && reinstall.passed;
    if (!passed) await rm(betaPath, { force: true });
    const createdAt = new Date().toISOString();
    const reinstallLog = `${log.join("\n\n")}\n`;
    const betaArtifact = passed ? {
      fileName: LOCAL_BETA_ARTIFACT_FILE,
      platform: "macos" as const,
      contentType: "application/zip" as const,
      sha256: request.mainArtifactSha256,
      sizeBytes: main.bytes.byteLength,
    } : null;
    const buildId = `BUILD-LOCAL-${sha256(JSON.stringify(request)).slice(0, 12).toUpperCase()}`;
    const unsigned = {
      schemaVersion: 1 as const,
      phase: "LOCAL_STEAM_REINSTALL" as const,
      localOnly: true as const,
      projectId: request.projectId,
      runId: request.runId,
      specRevisionId: request.specRevisionId,
      targetMatrix: Object.freeze(["macos"] as const),
      platform: "macos" as const,
      status: passed ? "TESTS_PASSED" as const : "FAILED" as const,
      releaseGate: passed ? "LOCAL_STEAM_REINSTALL_PASSED" as const : "TESTS_FAILED" as const,
      branch: "local-password-beta" as const,
      buildId,
      mainEvidenceId: request.mainEvidenceId,
      mainBundleDigest: request.mainBundleDigest,
      mainSha: request.mainSha,
      mainSourceDigest: request.mainSourceDigest,
      mainArtifactSha256: request.mainArtifactSha256,
      mfaApprovalId: request.mfaApprovalId,
      checks,
      artifacts: ["manifest.json", "reinstall.log"] as LocalSteamReinstallEvidence["artifacts"],
      artifactDigests: { "reinstall.log": sha256(reinstallLog) },
      betaArtifact,
      createdAt,
    };
    const bundleDigest = sha256(JSON.stringify(unsigned));
    const manifest: LocalSteamReinstallEvidence = {
      ...unsigned,
      evidenceId: `EV-STEAM-${bundleDigest.slice(0, 12).toUpperCase()}`,
      bundleDigest,
    };
    await writeFile(path.join(evidenceRoot, "reinstall.log"), reinstallLog, "utf8");
    await writeFile(path.join(evidenceRoot, "manifest.json"), `${JSON.stringify(manifest, null, 2)}\n`, "utf8");
    return manifest;
  }

  async recordExternalApproval(request: LocalExternalApprovalRequest): Promise<LocalExternalApprovalEvidence> {
    validateExternalApprovalRequest(request);
    const reinstall = await this.readSteamReinstallEvidence(request);
    if (reinstall.releaseGate !== "LOCAL_STEAM_REINSTALL_PASSED"
      || reinstall.status !== "TESTS_PASSED"
      || reinstall.evidenceId !== request.steamReinstallEvidenceId
      || reinstall.bundleDigest !== request.steamReinstallBundleDigest
      || reinstall.mainSha !== request.mainSha
      || reinstall.buildId !== request.steamBuildId
      || reinstall.specRevisionId !== request.specRevisionId
      || JSON.stringify(reinstall.targetMatrix) !== JSON.stringify(request.targetMatrix)) {
      throw new Error("Local external approval does not match the passed Beta reinstall evidence");
    }
    if (request.sequence > 1) {
      const previous = await this.readExternalApprovalEvidence(request, request.sequence - 1);
      if (previous.evidenceId !== request.previousApprovalEvidenceId
        || previous.sequence !== request.sequence - 1
        || previous.mainSha !== request.mainSha
        || previous.steamBuildId !== request.steamBuildId
        || previous.steamReinstallEvidenceId !== request.steamReinstallEvidenceId) {
        throw new Error("Local external approval chain does not match its prior evidence");
      }
    }
    try {
      const existing = await this.readExternalApprovalEvidence(request, request.sequence);
      assertExternalApprovalEvidenceBinding(existing, request);
      return existing;
    } catch (error) {
      if ((error as NodeJS.ErrnoException).code !== "ENOENT") throw error;
    }

    const approvalRoot = path.dirname(this.externalApprovalEvidenceDirectory(request, request.sequence));
    await archiveDirectory(approvalRoot);
    const evidenceRoot = this.externalApprovalEvidenceDirectory(request, request.sequence);
    await mkdir(evidenceRoot, { recursive: true });
    const observedState = {
      VALVE_REVIEW: "LOCAL_VALVE_REVIEW_CONFIRMED",
      FIRST_RELEASE: "LOCAL_FIRST_RELEASE_CONFIRMED",
      DEFAULT_BRANCH_CONFIRMATION: "LOCAL_DEFAULT_BRANCH_CONFIRMED",
    }[request.gate] as LocalExternalApprovalEvidence["observedState"];
    const approvalId = `APPROVAL-LOCAL-${sha256(JSON.stringify(request)).slice(0, 12).toUpperCase()}`;
    const unsigned = {
      schemaVersion: 1 as const,
      phase: "LOCAL_EXTERNAL_APPROVAL" as const,
      localOnly: true as const,
      projectId: request.projectId,
      runId: request.runId,
      specRevisionId: request.specRevisionId,
      targetMatrix: Object.freeze(["macos"] as const),
      mainSha: request.mainSha,
      steamBuildId: request.steamBuildId,
      steamReinstallEvidenceId: request.steamReinstallEvidenceId,
      steamReinstallBundleDigest: request.steamReinstallBundleDigest,
      gate: request.gate,
      sequence: request.sequence,
      previousApprovalEvidenceId: request.previousApprovalEvidenceId,
      approvalId,
      observedState,
      status: "APPROVED" as const,
      checks: Object.freeze([{
        name: "authority-binding" as const,
        status: "PASSED" as const,
        durationMs: 0,
        detail: "Local-only confirmation is bound to the exact main SHA, BuildID, reinstall evidence and prior approval",
      }] as const),
      createdAt: new Date().toISOString(),
    };
    const bundleDigest = sha256(JSON.stringify(unsigned));
    const manifest: LocalExternalApprovalEvidence = {
      ...unsigned,
      evidenceId: `EV-APPROVAL-${bundleDigest.slice(0, 12).toUpperCase()}`,
      bundleDigest,
    };
    await writeFile(path.join(evidenceRoot, "manifest.json"), `${JSON.stringify(manifest, null, 2)}\n`, { encoding: "utf8", mode: 0o400 });
    return manifest;
  }

  async #launchMacosArtifact(options: {
    exportPath: string;
    exportSmokeRoot: string;
    runRoot: string;
    environment: NodeJS.ProcessEnv;
    runtimeHome: string;
    runtimeTemp: string;
    log: string[];
  }): Promise<{ passed: boolean; durationMs: number; detail: string }> {
    const started = performance.now();
    let passed = false;
    let detail = "Exported macOS game startup failed";
    try {
      if (process.platform !== "darwin") throw new Error("macOS exported builds can only be launched on a macOS runner");
      const archiveInfo = await lstat(options.exportPath);
      if (!archiveInfo.isFile() || archiveInfo.isSymbolicLink() || archiveInfo.size < 1 || archiveInfo.size > MAX_BUILD_ARTIFACT_BYTES) {
        throw new Error("macOS build artifact size or type is invalid");
      }
      const archiveEntries = await this.#command(
        "/usr/bin/unzip", ["-Z1", options.exportPath], options.runRoot, options.environment,
      );
      options.log.push("$ unzip -Z1 <artifact>", sanitize(archiveEntries, options.runRoot, options.runtimeHome, options.runtimeTemp));
      if (archiveEntries.exitCode !== 0) throw new Error("macOS build archive listing failed");
      const archiveMetadata = await this.#command(
        "/usr/bin/unzip", ["-Z", "-l", options.exportPath], options.runRoot, options.environment,
      );
      options.log.push("$ unzip -Z -l <artifact>", sanitize(archiveMetadata, options.runRoot, options.runtimeHome, options.runtimeTemp));
      if (archiveMetadata.exitCode !== 0) throw new Error("macOS build archive metadata inspection failed");
      validateMacosBuildArchive(
        archiveEntries.stdout.split(/\r?\n/).filter(Boolean),
        archiveMetadata.stdout,
      );
      await mkdir(options.exportSmokeRoot, { mode: 0o700 });
      const extracted = await this.#command(
        "/usr/bin/unzip", ["-q", options.exportPath, "-d", options.exportSmokeRoot], options.runRoot, options.environment,
      );
      options.log.push("$ unzip -q <artifact> -d <export-smoke>", sanitize(extracted, options.runRoot, options.runtimeHome, options.runtimeTemp));
      if (extracted.exitCode !== 0) throw new Error("macOS build archive extraction failed");
      const exportedExecutable = await inspectExtractedMacosBuild(options.exportSmokeRoot);
      const launched = await this.#command(
        exportedExecutable, ["--headless", "--quit-after", "120"], options.exportSmokeRoot, options.environment,
      );
      options.log.push("$ <exported-app> --headless --quit-after 120", sanitize(launched, options.runRoot, options.runtimeHome, options.runtimeTemp));
      if (launched.exitCode !== 0) throw new Error(`Exported macOS game exited with code ${launched.exitCode}`);
      if (!launched.stdout.includes("DEVILUDO_FIXTURE_BOOT:")) throw new Error("Exported macOS game boot marker is missing");
      passed = true;
      detail = "Manifest-bound macOS app payload started from the exported ZIP and exited cleanly";
    } catch (error) {
      detail = error instanceof Error ? error.message : detail;
      options.log.push(`[macos-export-boot] FAILED ${detail}`);
    } finally {
      await rm(options.exportSmokeRoot, { recursive: true, force: true });
    }
    return { passed, durationMs: Math.round(performance.now() - started), detail };
  }

  async #checked(
    executable: string,
    args: string[],
    cwd: string,
    environment: NodeJS.ProcessEnv,
    log: string[],
  ) {
    const result = await this.#command(executable, args, cwd, environment);
    log.push(formatCommand(executable, args.map((arg) => arg === cwd ? "<workspace>" : arg)), sanitize(
      result,
      cwd,
      environment.HOME ?? "",
      environment.TMPDIR ?? "",
    ));
    if (result.exitCode !== 0) throw new Error(`${path.basename(executable)} exited with code ${result.exitCode}`);
    return result;
  }

  async #command(executable: string, args: string[], cwd: string, environment: NodeJS.ProcessEnv): Promise<CommandResult> {
    const started = performance.now();
    try {
      const result = await execFileAsync(executable, args, {
        cwd,
        env: environment,
        encoding: "utf8",
        maxBuffer: OUTPUT_LIMIT,
        timeout: COMMAND_TIMEOUT_MS,
        windowsHide: true,
      });
      return { exitCode: 0, stdout: result.stdout, stderr: result.stderr, durationMs: Math.round(performance.now() - started) };
    } catch (error) {
      const failure = error as Error & { code?: number | string; stdout?: string; stderr?: string };
      return {
        exitCode: typeof failure.code === "number" ? failure.code : 1,
        stdout: failure.stdout ?? "",
        stderr: failure.stderr ?? failure.message,
        durationMs: Math.round(performance.now() - started),
      };
    }
  }
}

function validateRequest(request: LocalRuntimeBinding) {
  validateIdentifier(request.projectId, "projectId");
  validateIdentifier(request.runId, "runId");
  validateIdentifier(request.specRevisionId, "specRevisionId");
  if (!Array.isArray(request.targetMatrix) || request.targetMatrix.length < 1 || request.targetMatrix.length > 3
    || new Set(request.targetMatrix).size !== request.targetMatrix.length
    || request.targetMatrix.some((platform) => platform !== "linux" && platform !== "windows" && platform !== "macos")) {
    throw new Error("targetMatrix is invalid");
  }
}

function validateSourceAuthority(request: LocalRuntimeRequest) {
  const authority = request.sourceAuthority;
  if (authority.kind === "FIXTURE") {
    if (authority.fixtureId !== "godot-smoke-v1" || authority.attemptId !== "fixture-attempt-1") {
      throw new Error("fixture source authority is invalid");
    }
    return;
  }
  validateIdentifier(authority.attemptId, "sourceAuthority.attemptId");
  if (!/^deviludo\/[a-z0-9][a-z0-9._-]*(?:\/[a-z0-9][a-z0-9._-]*)*$/i.test(authority.branch)
    || authority.branch.includes("..") || authority.branch.endsWith(".lock")
    || !/^[a-f0-9]{40}$/.test(authority.baseCommitSha)
    || !/^[a-f0-9]{40}$/.test(authority.candidateSha)
    || authority.baseCommitSha === authority.candidateSha
    || !/^[a-f0-9]{64}$/.test(authority.sourceDigest)) {
    throw new Error("Agent candidate source authority is invalid");
  }
}

function validateMainGateRequest(request: LocalMainGateRequest) {
  validateRequest(request);
  if (request.targetMatrix.length !== 1 || request.targetMatrix[0] !== "macos"
    || !/^EV-LOCAL-[A-F0-9]{12}$/.test(request.candidateEvidenceId)
    || !/^[a-f0-9]{64}$/.test(request.candidateBundleDigest)
    || !/^[a-f0-9]{40}$/.test(request.candidateSha)
    || !/^[a-f0-9]{64}$/.test(request.sourceDigest)) {
    throw new Error("Main gate candidate evidence binding is invalid");
  }
}

function validateSteamReinstallRequest(request: LocalSteamReinstallRequest) {
  validateRequest(request);
  if (request.targetMatrix.length !== 1 || request.targetMatrix[0] !== "macos"
    || !/^EV-MAIN-[A-F0-9]{12}$/.test(request.mainEvidenceId)
    || !/^[a-f0-9]{64}$/.test(request.mainBundleDigest)
    || !/^[a-f0-9]{40}$/.test(request.mainSha)
    || !/^[a-f0-9]{64}$/.test(request.mainSourceDigest)
    || !/^[a-f0-9]{64}$/.test(request.mainArtifactSha256)
    || !/^MFA-LOCAL-[0-9]{4,}$/.test(request.mfaApprovalId)) {
    throw new Error("Local Steam reinstall binding is invalid");
  }
}

function validateExternalApprovalRequest(request: LocalExternalApprovalRequest) {
  validateRequest(request);
  const expectedGate = (["VALVE_REVIEW", "FIRST_RELEASE", "DEFAULT_BRANCH_CONFIRMATION"] as const)[request.sequence - 1];
  if (request.targetMatrix.length !== 1 || request.targetMatrix[0] !== "macos"
    || !/^[a-f0-9]{40}$/.test(request.mainSha)
    || !/^BUILD-LOCAL-[A-F0-9]{12}$/.test(request.steamBuildId)
    || !/^EV-STEAM-[A-F0-9]{12}$/.test(request.steamReinstallEvidenceId)
    || !/^[a-f0-9]{64}$/.test(request.steamReinstallBundleDigest)
    || !Number.isInteger(request.sequence) || request.sequence < 1 || request.sequence > 3
    || request.gate !== expectedGate
    || (request.sequence === 1 ? request.previousApprovalEvidenceId !== null
      : !/^EV-APPROVAL-[A-F0-9]{12}$/.test(request.previousApprovalEvidenceId ?? ""))) {
    throw new Error("Local external approval binding is invalid");
  }
}

function assertEvidenceBinding(evidence: LocalRuntimeEvidence, request: LocalRuntimeRequest) {
  if (evidence.schemaVersion !== 4 || !evidence.sourceAuthority) throw new StaleLocalEvidenceError();
  if (evidence.projectId !== request.projectId
    || evidence.runId !== request.runId
    || evidence.specRevisionId !== request.specRevisionId
    || JSON.stringify(evidence.sourceAuthority) !== JSON.stringify(request.sourceAuthority)
    || evidence.fixtureOnly !== (request.sourceAuthority.kind === "FIXTURE")
    || JSON.stringify(evidence.targetMatrix) !== JSON.stringify(request.targetMatrix)) {
    throw new Error("Stored local evidence does not match the immutable run lock");
  }
}

function assertMainEvidenceBinding(evidence: LocalMainGateEvidence, request: LocalMainGateRequest) {
  if (evidence.schemaVersion !== 1
    || evidence.phase !== "MAIN_SHA_GATE"
    || evidence.projectId !== request.projectId
    || evidence.runId !== request.runId
    || evidence.specRevisionId !== request.specRevisionId
    || JSON.stringify(evidence.targetMatrix) !== JSON.stringify(request.targetMatrix)
    || evidence.candidateEvidenceId !== request.candidateEvidenceId
    || evidence.candidateBundleDigest !== request.candidateBundleDigest
    || evidence.candidateSha !== request.candidateSha
    || evidence.sourceDigest !== request.sourceDigest
    || evidence.mainSha !== request.candidateSha
    || evidence.mainSourceDigest !== request.sourceDigest) {
    throw new Error("Stored main gate evidence does not match the accepted candidate binding");
  }
}

function assertSteamReinstallEvidenceBinding(
  evidence: LocalSteamReinstallEvidence,
  request: LocalSteamReinstallRequest,
) {
  if (evidence.schemaVersion !== 1
    || evidence.phase !== "LOCAL_STEAM_REINSTALL"
    || evidence.localOnly !== true
    || evidence.projectId !== request.projectId
    || evidence.runId !== request.runId
    || evidence.specRevisionId !== request.specRevisionId
    || JSON.stringify(evidence.targetMatrix) !== JSON.stringify(request.targetMatrix)
    || evidence.mainEvidenceId !== request.mainEvidenceId
    || evidence.mainBundleDigest !== request.mainBundleDigest
    || evidence.mainSha !== request.mainSha
    || evidence.mainSourceDigest !== request.mainSourceDigest
    || evidence.mainArtifactSha256 !== request.mainArtifactSha256
    || evidence.mfaApprovalId !== request.mfaApprovalId) {
    throw new Error("Stored local Steam reinstall evidence does not match its immutable request");
  }
}

function assertExternalApprovalEvidenceBinding(
  evidence: LocalExternalApprovalEvidence,
  request: LocalExternalApprovalRequest,
) {
  if (evidence.schemaVersion !== 1
    || evidence.phase !== "LOCAL_EXTERNAL_APPROVAL"
    || evidence.localOnly !== true
    || evidence.projectId !== request.projectId
    || evidence.runId !== request.runId
    || evidence.specRevisionId !== request.specRevisionId
    || JSON.stringify(evidence.targetMatrix) !== JSON.stringify(request.targetMatrix)
    || evidence.mainSha !== request.mainSha
    || evidence.steamBuildId !== request.steamBuildId
    || evidence.steamReinstallEvidenceId !== request.steamReinstallEvidenceId
    || evidence.steamReinstallBundleDigest !== request.steamReinstallBundleDigest
    || evidence.gate !== request.gate
    || evidence.sequence !== request.sequence
    || evidence.previousApprovalEvidenceId !== request.previousApprovalEvidenceId
    || evidence.status !== "APPROVED"
    || evidence.checks.length !== 1
    || evidence.checks[0]?.name !== "authority-binding"
    || evidence.checks[0]?.status !== "PASSED") {
    throw new Error("Stored local external approval evidence does not match its immutable request");
  }
}

class StaleLocalEvidenceError extends Error {}

function validateIdentifier(value: string, name: string) {
  if (!IDENTIFIER.test(value)) throw new Error(`${name} is invalid`);
}

async function archivePartialRun(runRoot: string, scmRunRoot: string) {
  const suffix = `.partial-${Date.now()}`;
  try {
    await access(runRoot);
    await rename(runRoot, `${runRoot}${suffix}`);
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code !== "ENOENT") throw error;
  }
  try {
    await access(scmRunRoot);
    await rename(scmRunRoot, `${scmRunRoot}${suffix}`);
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code !== "ENOENT") throw error;
  }
}

async function archiveDirectory(directory: string) {
  try {
    await access(directory);
    await rename(directory, `${directory}.partial-${Date.now()}`);
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code !== "ENOENT") throw error;
  }
}

function sha256(value: string | Buffer) { return createHash("sha256").update(value).digest("hex"); }

function check(name: LocalRuntimeCheck["name"], result: CommandResult, detail: string): LocalRuntimeCheck {
  return { name, status: "PASSED", durationMs: result.durationMs, detail };
}

function parseE2EResult(stdout: string) {
  const marker = stdout.split(/\r?\n/).find((line) => line.startsWith("DEVILUDO_E2E_RESULT:"));
  if (!marker) throw new Error("Godot E2E result marker is missing");
  const parsed = JSON.parse(marker.slice("DEVILUDO_E2E_RESULT:".length)) as {
    checks: string[];
    failures: string[];
    duration_ms: number;
  };
  if (!Array.isArray(parsed.checks) || parsed.checks.length < 8 || parsed.failures.length) {
    throw new Error("Godot E2E checks failed");
  }
  return parsed;
}

function formatCommand(executable: string, args: string[]) {
  return `$ ${path.basename(executable)} ${args.join(" ")}`;
}

function sanitize(result: CommandResult, workspace: string, runtimeHome: string, runtimeTemp: string) {
  return `${result.stdout}${result.stderr}`
    .replaceAll(workspace, "<workspace>")
    .replaceAll(runtimeHome, "<runtime-home>")
    .replaceAll(runtimeTemp, "<runtime-tmp>")
    .slice(0, OUTPUT_LIMIT);
}

function junitXml(result: { checks: string[]; duration_ms: number }, processDurationMs: number) {
  const cases = result.checks.map((name) => `  <testcase classname="DeviLudo.LocalGodot" name="${escapeXml(name)}" time="${(result.duration_ms / 1000 / result.checks.length).toFixed(6)}"/>`).join("\n");
  return `<?xml version="1.0" encoding="UTF-8"?>\n<testsuite name="deviludo-local-godot-e2e" tests="${result.checks.length}" failures="0" time="${(processDurationMs / 1000).toFixed(3)}">\n${cases}\n</testsuite>\n`;
}

function escapeXml(value: string) {
  return value.replaceAll("&", "&amp;").replaceAll('"', "&quot;").replaceAll("<", "&lt;").replaceAll(">", "&gt;");
}
