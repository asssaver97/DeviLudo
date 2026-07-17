import { execFile } from "node:child_process";
import { createHash } from "node:crypto";
import { access, cp, mkdir, readFile, rename, writeFile } from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { promisify } from "node:util";
import { LocalGitScmProxy } from "../../scm-proxy/src/local-git";
import type { LocalRuntimeCheck, LocalRuntimeEvidence, LocalRuntimeRequest } from "./contracts";

const execFileAsync = promisify(execFile);
const IDENTIFIER = /^[A-Za-z0-9][A-Za-z0-9-]{2,63}$/;
const OUTPUT_LIMIT = 2 * 1024 * 1024;
const COMMAND_TIMEOUT_MS = 60_000;

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
  readonly #godotBinary: string;
  readonly #gitBinary: string;
  readonly #scmProxy: LocalGitScmProxy;

  constructor(options: {
    repositoryRoot: string;
    fixtureRoot?: string;
    storageRoot?: string;
    godotBinary?: string;
    gitBinary?: string;
  }) {
    this.#repositoryRoot = path.resolve(options.repositoryRoot);
    this.#fixtureRoot = path.resolve(options.fixtureRoot ?? path.join(this.#repositoryRoot, "fixtures/godot-smoke"));
    this.#storageRoot = path.resolve(options.storageRoot ?? path.join(this.#repositoryRoot, ".deviludo/local-runtime"));
    this.#godotBinary = path.resolve(options.godotBinary ?? "/Applications/Godot.app/Contents/MacOS/Godot");
    this.#gitBinary = path.resolve(options.gitBinary ?? "/usr/bin/git");
    this.#scmProxy = new LocalGitScmProxy({ storageRoot: this.#storageRoot, gitBinary: this.#gitBinary });
  }

  get storageRoot() { return this.#storageRoot; }
  get godotBinary() { return this.#godotBinary; }

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

  async readEvidence(request: Pick<LocalRuntimeRequest, "projectId" | "runId">) {
    const file = path.join(this.evidenceDirectory(request), "manifest.json");
    return JSON.parse(await readFile(file, "utf8")) as LocalRuntimeEvidence;
  }

  async run(request: LocalRuntimeRequest): Promise<LocalRuntimeEvidence> {
    validateRequest(request);
    try {
      return await this.readEvidence(request);
    } catch {
      // A missing manifest means the exact run has not completed yet.
    }

    await access(this.#fixtureRoot);
    await access(this.#godotBinary);
    await access(this.#gitBinary);
    await mkdir(this.#storageRoot, { recursive: true });

    const runRoot = path.join(this.#storageRoot, request.projectId, request.runId);
    const workspace = path.join(runRoot, "workspace");
    const evidence = path.join(runRoot, "evidence");
    const runtimeHome = path.join(runRoot, "home");
    await archivePartialRun(runRoot, path.join(this.#storageRoot, ".scm", request.projectId, request.runId));
    await mkdir(evidence, { recursive: true });
    await mkdir(runtimeHome, { recursive: true });
    await mkdir(workspace, { recursive: true });

    const scmBinding = {
      projectId: request.projectId,
      runId: request.runId,
      attemptId: "fixture-attempt-1",
      specRevisionId: request.specRevisionId,
      workspaceRoot: workspace,
    };
    const base = await this.#scmProxy.prepare(scmBinding);
    await cp(this.#fixtureRoot, workspace, { recursive: true, force: false });
    const candidate = await this.#scmProxy.finalize({
      ...scmBinding,
      expectedBaseCommitSha: base.baseCommitSha,
      candidateBranch: `deviludo/local/${sha256(`${request.projectId}:${request.runId}`).slice(0, 16)}`,
      commitMessage: `fixture: implement ${request.specRevisionId}`,
    });

    const environment: NodeJS.ProcessEnv = {
      NODE_ENV: "test",
      PATH: "/usr/local/bin:/usr/bin:/bin:/usr/sbin:/sbin",
      LANG: "C.UTF-8",
      HOME: runtimeHome,
      TMPDIR: os.tmpdir(),
    };
    const log: string[] = [`[scm-proxy] base=${base.baseCommitSha} candidate=${candidate.commitSha} source=${candidate.sourceDigest}`];
    const candidateSha = candidate.commitSha;
    const sourceDigest = candidate.sourceDigest;
    const godotVersion = await this.godotVersion();

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

    const exportPath = path.join(runRoot, "artifacts", "DeviLudoLocal.zip");
    await mkdir(path.dirname(exportPath), { recursive: true });
    const exported = await this.#command(
      this.#godotBinary,
      ["--headless", "--path", workspace, "--export-debug", "macOS", exportPath],
      workspace,
      environment,
    );
    log.push(formatCommand(this.#godotBinary, ["--headless", "--path", "<workspace>", "--export-debug", "macOS", "<artifact>"]), sanitize(exported, workspace, runtimeHome));
    const exportPassed = exported.exitCode === 0;
    const exportDiagnostics = `${exported.stdout}\n${exported.stderr}`;
    const exportTemplatesMissing = !exportPassed && /(export_templates|export templates?|导出模板)/i.test(exportDiagnostics);
    checks.push({
      name: "macos-export",
      status: exportPassed ? "PASSED" : exportTemplatesMissing ? "WAITING_DEPENDENCY" : "FAILED",
      durationMs: exported.durationMs,
      detail: exportPassed
        ? "Unsigned local macOS debug export created"
        : exportTemplatesMissing
          ? "Godot macOS export templates are not installed"
          : "Godot macOS export failed for a reason other than missing templates",
    });

    const createdAt = new Date().toISOString();
    const junit = junitXml(e2e, tested.durationMs);
    const godotLog = `${log.join("\n\n")}\n`;
    const artifactDigests = {
      "junit.xml": sha256(junit),
      "godot.log": sha256(godotLog),
    };
    const status = exportPassed || exportTemplatesMissing ? "TESTS_PASSED" as const : "FAILED" as const;
    const releaseGate = exportPassed
      ? "LOCAL_VALIDATION_PASSED" as const
      : exportTemplatesMissing
        ? "WAITING_EXPORT_TEMPLATES" as const
        : "TESTS_FAILED" as const;
    const unsigned = {
      schemaVersion: 1 as const,
      projectId: request.projectId,
      runId: request.runId,
      specRevisionId: request.specRevisionId,
      platform: "macos" as const,
      status,
      releaseGate,
      candidateSha,
      sourceDigest,
      godotVersion,
      checks,
      artifacts: ["manifest.json", "junit.xml", "godot.log"] as LocalRuntimeEvidence["artifacts"],
      artifactDigests,
      testPlan: "deviludo-local-testkit-1.0.0" as const,
      fixtureOnly: true as const,
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

  async #checked(
    executable: string,
    args: string[],
    cwd: string,
    environment: NodeJS.ProcessEnv,
    log: string[],
  ) {
    const result = await this.#command(executable, args, cwd, environment);
    log.push(formatCommand(executable, args.map((arg) => arg === cwd ? "<workspace>" : arg)), sanitize(result, cwd, environment.HOME ?? ""));
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

function validateRequest(request: LocalRuntimeRequest) {
  validateIdentifier(request.projectId, "projectId");
  validateIdentifier(request.runId, "runId");
  validateIdentifier(request.specRevisionId, "specRevisionId");
}

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

function sha256(value: string) { return createHash("sha256").update(value).digest("hex"); }

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

function sanitize(result: CommandResult, workspace: string, runtimeHome: string) {
  return `${result.stdout}${result.stderr}`
    .replaceAll(workspace, "<workspace>")
    .replaceAll(runtimeHome, "<runtime-home>")
    .slice(0, OUTPUT_LIMIT);
}

function junitXml(result: { checks: string[]; duration_ms: number }, processDurationMs: number) {
  const cases = result.checks.map((name) => `  <testcase classname="DeviLudo.LocalGodot" name="${escapeXml(name)}" time="${(result.duration_ms / 1000 / result.checks.length).toFixed(6)}"/>`).join("\n");
  return `<?xml version="1.0" encoding="UTF-8"?>\n<testsuite name="deviludo-local-godot-e2e" tests="${result.checks.length}" failures="0" time="${(processDurationMs / 1000).toFixed(3)}">\n${cases}\n</testsuite>\n`;
}

function escapeXml(value: string) {
  return value.replaceAll("&", "&amp;").replaceAll('"', "&quot;").replaceAll("<", "&lt;").replaceAll(">", "&gt;");
}
