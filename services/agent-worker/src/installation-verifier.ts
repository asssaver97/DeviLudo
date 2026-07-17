import { execFile } from "node:child_process";
import type { ProbePlan } from "../../../lib/agent/types";
import type { InstallationProbeResult, InstallationVerifier } from "./contracts";

const EXACT_VERSION = /^\d+\.\d+\.\d+(?:-[0-9A-Za-z.-]+)?$/;
const VERSION_OUTPUT_LIMIT = 64 * 1024;
const VERSION_TIMEOUT_MS = 10_000;

export type VersionCommandRunner = (
  executable: ProbePlan["executable"],
  argv: readonly string[],
  options: { readonly env: NodeJS.ProcessEnv; readonly timeout: number; readonly maxBuffer: number },
) => Promise<{ readonly stdout: string; readonly stderr: string }>;

export class CliInstallationVerifier implements InstallationVerifier {
  readonly #run: VersionCommandRunner;
  readonly #hostEnvironment: Readonly<Record<string, string | undefined>>;
  readonly #observedImageDigest: string | undefined;

  constructor(options: {
    readonly run?: VersionCommandRunner;
    readonly hostEnvironment?: Readonly<Record<string, string | undefined>>;
    /** Supplied by immutable workload metadata, never by the task payload. */
    readonly observedImageDigest?: string;
  } = {}) {
    this.#run = options.run ?? runVersionCommand;
    this.#hostEnvironment = options.hostEnvironment ?? process.env;
    this.#observedImageDigest = options.observedImageDigest ?? process.env.DEVILUDO_WORKER_IMAGE_DIGEST;
  }

  async verify(plan: ProbePlan): Promise<InstallationProbeResult> {
    validateProbePlan(plan);
    if (!this.#observedImageDigest || !/^sha256:[a-f0-9]{64}$/.test(this.#observedImageDigest)) {
      throw new Error("Worker image identity is unavailable");
    }
    if (this.#observedImageDigest !== plan.imageDigest) {
      throw new Error("Worker image digest does not match the locked installation");
    }
    const observedVersion = await this.inspect(plan.executable);
    if (observedVersion !== plan.expectedVersion) {
      throw new Error(`Installed Agent CLI version mismatch: expected ${plan.expectedVersion}, observed ${observedVersion}`);
    }
    return Object.freeze({
      agent: plan.agent,
      executable: plan.executable,
      expectedVersion: plan.expectedVersion,
      observedVersion,
      imageDigest: this.#observedImageDigest,
    });
  }

  async inspect(executable: ProbePlan["executable"]): Promise<string> {
    if (executable !== "claude" && executable !== "codex") throw new Error("Unsupported Agent CLI executable");
    let output: { readonly stdout: string; readonly stderr: string };
    try {
      output = await this.#run(executable, ["--version"], {
        env: minimalEnvironment(this.#hostEnvironment),
        timeout: VERSION_TIMEOUT_MS,
        maxBuffer: VERSION_OUTPUT_LIMIT,
      });
    } catch {
      throw new Error("Installed Agent CLI version could not be verified");
    }
    const combined = `${output.stdout}\n${output.stderr}`.slice(0, VERSION_OUTPUT_LIMIT);
    const observedVersion = extractVersion(combined);
    if (!observedVersion) throw new Error("Installed Agent CLI returned no exact version");
    return observedVersion;
  }
}

export function validateProbePlan(plan: ProbePlan): void {
  const executable = plan.agent === "claude-code" ? "claude" : "codex";
  if (plan.executable !== executable || plan.argv.length !== 1 || plan.argv[0] !== "--version") {
    throw new Error("Installation probe must use the selected Agent's fixed --version command");
  }
  if (!EXACT_VERSION.test(plan.expectedVersion) || /latest|stable|default/i.test(plan.expectedVersion)) {
    throw new Error("Installation probe requires an exact pinned CLI version");
  }
  if (!/^sha256:[a-f0-9]{64}$/.test(plan.imageDigest)) {
    throw new Error("Installation probe requires an exact lowercase image digest");
  }
}

function extractVersion(value: string): string | null {
  return value.match(/(?:^|[^0-9A-Za-z.-])(\d+\.\d+\.\d+(?:-[0-9A-Za-z.-]+)?)(?=$|[^0-9A-Za-z.-])/)?.[1] ?? null;
}

function minimalEnvironment(host: Readonly<Record<string, string | undefined>>): NodeJS.ProcessEnv {
  const environment: NodeJS.ProcessEnv = { NODE_ENV: "production" };
  for (const key of ["PATH", "LANG", "LC_ALL", "TZ"] as const) {
    const value = host[key];
    if (value !== undefined && !value.includes("\0")) environment[key] = value;
  }
  return environment;
}

function runVersionCommand(
  executable: ProbePlan["executable"],
  argv: readonly string[],
  options: { readonly env: NodeJS.ProcessEnv; readonly timeout: number; readonly maxBuffer: number },
) {
  return new Promise<{ stdout: string; stderr: string }>((resolve, reject) => {
    execFile(executable, [...argv], {
      env: options.env,
      encoding: "utf8",
      maxBuffer: options.maxBuffer,
      timeout: options.timeout,
      windowsHide: true,
    }, (error, stdout, stderr) => {
      if (error) reject(error);
      else resolve({ stdout, stderr });
    });
  });
}
