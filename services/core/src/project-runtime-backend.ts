import { spawn } from "node:child_process";
import { isAbsolute } from "node:path";
import type {
  ProjectRuntimeControlRequest,
  ProjectRuntimeEnsureRequest,
  ProjectRuntimeProgressEvent,
  ProjectRuntimeStatus,
  ProjectRuntimeTurnRequest,
  ProjectRuntimeTurnResult,
} from "@/lib/product/project-runtime";

export interface ProjectRuntimeBackend {
  ensure(request: ProjectRuntimeEnsureRequest, signal?: AbortSignal): Promise<ProjectRuntimeStatus>;
  turn(
    request: ProjectRuntimeTurnRequest,
    signal?: AbortSignal,
    onEvent?: (event: ProjectRuntimeProgressEvent) => void,
  ): Promise<ProjectRuntimeTurnResult>;
  pause(request: ProjectRuntimeControlRequest, signal?: AbortSignal): Promise<ProjectRuntimeStatus>;
  resume(request: ProjectRuntimeControlRequest, signal?: AbortSignal): Promise<ProjectRuntimeStatus>;
  destroy(request: ProjectRuntimeControlRequest, signal?: AbortSignal): Promise<ProjectRuntimeStatus>;
  status(request: ProjectRuntimeControlRequest, signal?: AbortSignal): Promise<ProjectRuntimeStatus>;
  list(signal?: AbortSignal): Promise<readonly Readonly<Record<string, unknown>>[]>;
}

export class ProcessProjectRuntimeBackend implements ProjectRuntimeBackend {
  constructor(private readonly executable = process.env.DEVILUDO_SANDBOX_EXECUTOR ?? "") {}

  ensure(request: ProjectRuntimeEnsureRequest, signal?: AbortSignal) { return this.call<ProjectRuntimeStatus>("runtime-ensure", request, signal); }
  turn(request: ProjectRuntimeTurnRequest, signal?: AbortSignal, onEvent?: (event: ProjectRuntimeProgressEvent) => void) {
    return this.call<ProjectRuntimeTurnResult>("runtime-turn", request, signal, onEvent);
  }
  pause(request: ProjectRuntimeControlRequest, signal?: AbortSignal) { return this.call<ProjectRuntimeStatus>("runtime-pause", request, signal); }
  resume(request: ProjectRuntimeControlRequest, signal?: AbortSignal) { return this.call<ProjectRuntimeStatus>("runtime-resume", request, signal); }
  destroy(request: ProjectRuntimeControlRequest, signal?: AbortSignal) { return this.call<ProjectRuntimeStatus>("runtime-destroy", request, signal); }
  status(request: ProjectRuntimeControlRequest, signal?: AbortSignal) { return this.call<ProjectRuntimeStatus>("runtime-status", request, signal); }
  list(signal?: AbortSignal) { return this.call<readonly Readonly<Record<string, unknown>>[]>("runtime-list", undefined, signal); }

  private async call<T>(action: string, body: unknown, signal?: AbortSignal, onEvent?: (event: ProjectRuntimeProgressEvent) => void): Promise<T> {
    if (!this.executable || !isAbsolute(this.executable)) throw new Error("A trusted Project Runtime supervisor is required");
    const child = spawn(this.executable, [action], {
      shell: false,
      stdio: ["pipe", "pipe", "pipe"],
      signal,
      env: { ...process.env, PATH: "/usr/local/bin:/usr/bin:/bin" },
    });
    child.stdin.end(body === undefined ? undefined : JSON.stringify(body));
    const stdout: Buffer[] = [];
    const stderr: Buffer[] = [];
    let stderrBuffer = "";
    let bytes = 0;
    child.stdout.on("data", chunk => {
      bytes += chunk.length;
      if (bytes > 8 * 1024 * 1024) child.kill("SIGKILL");
      else stdout.push(Buffer.from(chunk));
    });
    child.stderr.on("data", chunk => {
      if (stderr.reduce((sum, item) => sum + item.length, 0) < 64 * 1024) stderr.push(Buffer.from(chunk));
      stderrBuffer += chunk.toString("utf8");
      const lines = stderrBuffer.split(/\r?\n/);
      stderrBuffer = lines.pop() ?? "";
      for (const line of lines) {
        const prefix = "DEVILUDO_RUNTIME_PROGRESS:";
        if (!line.startsWith(prefix)) continue;
        try {
          const event = JSON.parse(line.slice(prefix.length)) as { kind?: unknown; content?: unknown };
          if ((event.kind === "RUNTIME_OUTPUT" || event.kind === "ACTIVITY"
            || event.kind === "CONTENT_DELTA" || event.kind === "DEVELOPMENT_LOG")
            && typeof event.content === "string") {
            onEvent?.(Object.freeze({ kind: event.kind, content: event.content }));
          }
        } catch {
          // Malformed progress is ignored; the final signed result remains authoritative.
        }
      }
    });
    const code = await new Promise<number | null>((resolve, reject) => {
      child.once("error", reject);
      child.once("close", resolve);
    });
    if (bytes > 8 * 1024 * 1024) throw new Error("Project Runtime response exceeds its limit");
    if (code !== 0) throw new Error(Buffer.concat(stderr).toString("utf8").trim() || `Project Runtime supervisor exited ${String(code)}`);
    const result = JSON.parse(Buffer.concat(stdout).toString("utf8"));
    return result as T;
  }
}
