import { execFile } from "node:child_process";
import { access } from "node:fs/promises";
import { isAbsolute } from "node:path";
import { promisify } from "node:util";
import type { JobProtocolV3 } from "@/services/core/src/contracts";

const executeFile = promisify(execFile);

export interface IsolationController {
  assertAgentAbsent(): Promise<void>;
  reimage(job: JobProtocolV3, stage: "before" | "after"): Promise<string>;
  cleanup(job: JobProtocolV3): Promise<string>;
}

export class TrustedIsolationController implements IsolationController {
  constructor(
    private readonly executable = process.env.DEVILUDO_E2E_ISOLATION_EXECUTOR ?? "",
    private readonly production = process.env.NODE_ENV === "production",
  ) {}

  async assertAgentAbsent(): Promise<void> {
    if (!this.production) return;
    const forbidden = (process.env.DEVILUDO_E2E_FORBIDDEN_AGENT_PATHS
      ?? "/usr/local/bin/claude:/usr/local/bin/codex:/opt/deviludo/agent")
      .split(":")
      .filter(Boolean);
    for (const path of forbidden) {
      try {
        await access(path);
        throw new Error(`Agent software is forbidden on E2E nodes: ${path}`);
      } catch (error) {
        if (error instanceof Error && error.message.startsWith("Agent software")) throw error;
      }
    }
  }

  async reimage(job: JobProtocolV3, stage: "before" | "after"): Promise<string> {
    return this.run("reimage", job, stage);
  }

  async cleanup(job: JobProtocolV3): Promise<string> {
    return this.run("cleanup", job, "after");
  }

  private async run(action: "reimage" | "cleanup", job: JobProtocolV3, stage: "before" | "after"): Promise<string> {
    if (!this.executable) {
      if (this.production) throw new Error("Trusted E2E isolation executor is required");
      return `development-${action}-${stage}:${job.jobId}:g${job.isolationGeneration}`;
    }
    if (!isAbsolute(this.executable)) throw new Error("E2E isolation executor path must be absolute");
    const { stdout } = await executeFile(this.executable, [
      action,
      "--stage", stage,
      "--job-id", job.jobId,
      "--tenant-id", job.tenantId,
      "--generation", String(job.isolationGeneration),
    ], {
      timeout: 10 * 60_000,
      maxBuffer: 64 * 1024,
      env: {
        PATH: "/usr/local/bin:/usr/bin:/bin",
        LANG: "C.UTF-8",
        NODE_ENV: process.env.NODE_ENV ?? "production",
      },
    });
    const proof = stdout.trim();
    if (proof.length < 16 || proof.length > 4096) throw new Error("Isolation executor returned an invalid proof");
    return proof;
  }
}
