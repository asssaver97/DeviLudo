import path from "node:path";
import type { RuntimeFile, RuntimeSpec } from "../../../lib/agent/types";

const EXPECTED_EXECUTABLE = Object.freeze({
  "claude-code": "claude",
  "codex-cli": "codex",
} as const);

const FORBIDDEN_ARGUMENTS = new Set([
  "--yolo",
  "--dangerously-skip-permissions",
  "--dangerously-bypass-approvals-and-sandbox",
  "--full-auto",
  "--sandbox-danger-full-access",
]);

const RUNTIME_HOME_VARIABLES = Object.freeze(["CLAUDE_CONFIG_DIR", "CODEX_HOME"]);

export interface ValidatedPaths {
  readonly workerRunRoot: string;
  readonly workspaceRoot: string;
}

export function validateExecutionPaths(
  workerRunRoot: string,
  workspaceRoot: string,
  runtimeSpec: RuntimeSpec,
): ValidatedPaths {
  const runRoot = requireAbsoluteNormalized(workerRunRoot, "Worker run root");
  const workspace = requireAbsoluteNormalized(workspaceRoot, "Workspace root");
  const cwd = requireAbsoluteNormalized(runtimeSpec.cwd, "Runtime cwd");

  requireWithin(runRoot, workspace, "Workspace root");
  requireWithin(workspace, cwd, "Runtime cwd");

  for (const file of runtimeSpec.files) validateRuntimeFile(runRoot, file);
  for (const argument of runtimeSpec.args) {
    if (argument.includes("\0")) throw new Error("Runtime argument contains NUL");
    const flag = argument.toLowerCase().split("=", 1)[0] ?? argument.toLowerCase();
    if (FORBIDDEN_ARGUMENTS.has(flag) || flag.includes("dangerously-skip")) {
      throw new Error("Runtime argument bypasses the worker security policy");
    }
    if (path.isAbsolute(argument)) {
      const normalized = requireAbsoluteNormalized(argument, "Runtime argument path");
      requireWithin(runRoot, normalized, "Runtime argument path");
    }
  }
  for (const variable of RUNTIME_HOME_VARIABLES) {
    const value = runtimeSpec.env[variable];
    if (value === undefined) continue;
    const normalized = requireAbsoluteNormalized(value, `${variable} path`);
    requireWithin(runRoot, normalized, `${variable} path`);
  }

  return Object.freeze({ workerRunRoot: runRoot, workspaceRoot: workspace });
}

export function assertExecutableMatchesAdapter(
  agent: keyof typeof EXPECTED_EXECUTABLE,
  runtimeSpec: RuntimeSpec,
): void {
  if (runtimeSpec.executable !== EXPECTED_EXECUTABLE[agent]) {
    throw new Error("Runtime executable does not match the selected adapter");
  }
}

function validateRuntimeFile(runRoot: string, file: RuntimeFile): void {
  const relative = file.relativePath;
  if (
    !relative ||
    relative.includes("\0") ||
    relative.includes("\\") ||
    path.posix.isAbsolute(relative) ||
    path.posix.normalize(relative) !== relative ||
    relative === "." ||
    relative.split("/").includes("..")
  ) {
    throw new Error("Runtime file path escapes the run root");
  }
  const destination = path.resolve(runRoot, relative);
  requireWithin(runRoot, destination, "Runtime file path");
  if (file.mode !== 0o400 && file.mode !== 0o600) {
    throw new Error("Runtime file mode is not permitted");
  }
}

function requireAbsoluteNormalized(value: string, label: string): string {
  if (!path.isAbsolute(value) || value.includes("\0") || path.resolve(value) !== value) {
    throw new Error(`${label} must be an absolute normalized path`);
  }
  return value;
}

function requireWithin(root: string, candidate: string, label: string): void {
  const relative = path.relative(root, candidate);
  if (relative === ".." || relative.startsWith(`..${path.sep}`) || path.isAbsolute(relative)) {
    throw new Error(`${label} escapes its permitted root`);
  }
}
