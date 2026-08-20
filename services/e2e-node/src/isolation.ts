import { execFile } from "node:child_process";
import { createHash, sign } from "node:crypto";
import { access, readFile } from "node:fs/promises";
import { isAbsolute } from "node:path";
import { promisify } from "node:util";
import type { JobProtocolV4 } from "@/services/core/src/contracts";
import { e2eExecutableInvocation, e2eToolPath } from "./tool-path";

const executeFile = promisify(execFile);

export interface IsolationController {
  assertAgentAbsent(): Promise<void>;
  reap(): Promise<void>;
  reimage(job: JobProtocolV4, stage: "before" | "after"): Promise<string>;
  cleanup(job: JobProtocolV4): Promise<string>;
}

export class TrustedIsolationController implements IsolationController {
  constructor(
    private readonly executable = process.env.DEVILUDO_E2E_ISOLATION_EXECUTOR ?? "",
  ) {}

  async assertAgentAbsent(): Promise<void> {
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

  async reimage(job: JobProtocolV4, stage: "before" | "after"): Promise<string> {
    return this.run("reimage", job, stage);
  }

  async cleanup(job: JobProtocolV4): Promise<string> {
    return this.run("cleanup", job, "after");
  }

  async reap(): Promise<void> {
    const invocation = this.invocation(["reap"]);
    const { stdout } = await executeFile(invocation.executable, invocation.arguments, {
      timeout: 10 * 60_000,
      maxBuffer: 64 * 1024,
      env: this.environment(),
    });
    if (!/^reap:\d+\s*$/.test(stdout)) throw new Error("Isolation executor returned an invalid recovery result");
  }

  private async run(action: "reimage" | "cleanup", job: JobProtocolV4, stage: "before" | "after"): Promise<string> {
    const invocation = this.invocation([
      action,
      "--stage", stage,
      "--job-id", job.jobId,
      "--workspace-id", job.workspaceId,
      "--generation", String(job.isolationGeneration),
      "--runtime-image", job.runtimeImage,
    ]);
    const { stdout } = await executeFile(invocation.executable, invocation.arguments, {
      timeout: 10 * 60_000,
      maxBuffer: 64 * 1024,
      env: this.environment(),
    });
    const rawProof = stdout.trim();
    if (rawProof.length < 16 || rawProof.length > 4096) throw new Error("Isolation executor returned an invalid proof");
    const payload = Object.freeze({
      schemaVersion: "deviludo.isolation-proof.v1",
      action, stage, jobId: job.jobId, workspaceId: job.workspaceId,
      isolationGeneration: job.isolationGeneration,
      fencingToken: job.lease.fencingToken,
      evidenceSha256: `sha256:${createHash("sha256").update(rawProof).digest("hex")}`,
    });
    const keyFile = process.env.DEVILUDO_E2E_IDENTITY_KEY_FILE ?? "";
    if (!isAbsolute(keyFile)) throw new Error("E2E receipt identity key is required for isolation proofs");
    const signature = sign(null, Buffer.from(JSON.stringify(payload)), await readFile(keyFile, "utf8")).toString("base64url");
    return `${Buffer.from(JSON.stringify(payload)).toString("base64url")}.${signature}`;
  }

  private invocation(arguments_: string[]) {
    if (!this.executable) throw new Error("Trusted E2E isolation executor is required");
    if (!isAbsolute(this.executable)) throw new Error("E2E isolation executor path must be absolute");
    return e2eExecutableInvocation(this.executable, arguments_);
  }

  private environment(): NodeJS.ProcessEnv {
    return {
      PATH: e2eToolPath(),
      LANG: "C.UTF-8",
      NODE_ENV: process.env.NODE_ENV ?? "production",
      ...(process.env.HOME ? { HOME: process.env.HOME } : {}),
      ...(process.env.DEVILUDO_E2E_IDENTITY_KEY_FILE
        ? { DEVILUDO_E2E_IDENTITY_KEY_FILE: process.env.DEVILUDO_E2E_IDENTITY_KEY_FILE }
        : {}),
      ...(process.env.DEVILUDO_E2E_JOB_ROOT ? { DEVILUDO_E2E_JOB_ROOT: process.env.DEVILUDO_E2E_JOB_ROOT } : {}),
      ...(process.env.DEVILUDO_GOLDEN_VM_FILE ? { DEVILUDO_GOLDEN_VM_FILE: process.env.DEVILUDO_GOLDEN_VM_FILE } : {}),
      ...(process.env.DEVILUDO_GOLDEN_VM_NAME ? { DEVILUDO_GOLDEN_VM_NAME: process.env.DEVILUDO_GOLDEN_VM_NAME } : {}),
      ...(process.env.DEVILUDO_COSIGN_IDENTITY_REGEXP ? { DEVILUDO_COSIGN_IDENTITY_REGEXP: process.env.DEVILUDO_COSIGN_IDENTITY_REGEXP } : {}),
      ...(process.env.DEVILUDO_COSIGN_ISSUER ? { DEVILUDO_COSIGN_ISSUER: process.env.DEVILUDO_COSIGN_ISSUER } : {}),
    };
  }
}
