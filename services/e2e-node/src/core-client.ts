import { readFile } from "node:fs/promises";
import { request as httpRequest } from "node:http";
import { request as httpsRequest, type RequestOptions } from "node:https";
import type { JobCompletion, JobProtocolV3 } from "@/services/core/src/contracts";
import type { E2eNodeConfig } from "./config";

export type SigningGrant = Readonly<{
  grantId: string;
  wrappedToken: string;
  expiresAt: string;
  operationId: string;
}>;

export class CoreE2eClient {
  private constructor(
    private readonly config: E2eNodeConfig,
    private readonly tls: Readonly<{ cert?: Buffer; key?: Buffer; ca?: Buffer }>,
  ) {}

  static async create(config: E2eNodeConfig): Promise<CoreE2eClient> {
    const [cert, key, ca] = await Promise.all([
      optionalFile(config.certificateFile),
      optionalFile(config.keyFile),
      optionalFile(config.caFile),
    ]);
    return new CoreE2eClient(config, Object.freeze({ cert, key, ca }));
  }

  async claim(): Promise<JobProtocolV3 | null> {
    const response = await this.call<{ job: JobProtocolV3 | null }>("/v1/e2e/jobs/claim", {
      nodeId: this.config.nodeId,
      poolKind: this.config.poolKind,
    });
    return response.job;
  }

  async heartbeat(job: JobProtocolV3): Promise<boolean> {
    const response = await this.call<{ accepted: boolean }>(`/v1/e2e/jobs/${job.jobId}/heartbeat`, identity(job));
    return response.accepted;
  }

  async complete(job: JobProtocolV3, completion: JobCompletion): Promise<boolean> {
    const response = await this.call<{ accepted: boolean }>(`/v1/e2e/jobs/${job.jobId}/complete`, {
      ...identity(job),
      ...completion,
    });
    return response.accepted;
  }

  async fail(job: JobProtocolV3, reason: string): Promise<boolean> {
    const response = await this.call<{ accepted: boolean }>(`/v1/e2e/jobs/${job.jobId}/fail`, {
      ...identity(job),
      reason,
    });
    return response.accepted;
  }

  async issueSigningGrant(job: JobProtocolV3, beforeReimageProof: string): Promise<SigningGrant> {
    return await this.call<SigningGrant>(`/v1/e2e/jobs/${job.jobId}/signing-grant`, {
      ...identity(job),
      beforeReimageProof,
    });
  }

  private async call<T>(path: string, body: Readonly<Record<string, unknown>>): Promise<T> {
    const data = Buffer.from(JSON.stringify(body));
    const url = new URL(path, this.config.coreUrl);
    const options: RequestOptions = {
      protocol: url.protocol,
      hostname: url.hostname,
      port: url.port || undefined,
      path: `${url.pathname}${url.search}`,
      method: "POST",
      headers: {
        accept: "application/json",
        "content-type": "application/json",
        "content-length": String(data.length),
        ...(this.config.developmentToken ? { "x-deviludo-node-auth": this.config.developmentToken } : {}),
      },
      cert: this.tls.cert,
      key: this.tls.key,
      ca: this.tls.ca,
      minVersion: "TLSv1.3",
      rejectUnauthorized: url.protocol === "https:",
      timeout: 10_000,
    };
    return await new Promise<T>((resolve, reject) => {
      const requester = url.protocol === "https:" ? httpsRequest : httpRequest;
      const request = requester(options, response => {
        const chunks: Buffer[] = [];
        let bytes = 0;
        response.on("data", (chunk: Buffer) => {
          bytes += chunk.length;
          if (bytes <= 1_048_576) chunks.push(chunk);
        });
        response.once("end", () => {
          if (bytes > 1_048_576) return reject(new Error("Core response exceeded the size limit"));
          const text = Buffer.concat(chunks).toString("utf8");
          if (!response.statusCode || response.statusCode < 200 || response.statusCode >= 300) {
            return reject(new Error(`Core returned ${response.statusCode ?? 0}: ${text.slice(0, 1_000)}`));
          }
          try {
            resolve(JSON.parse(text) as T);
          } catch {
            reject(new Error("Core returned invalid JSON"));
          }
        });
      });
      request.once("timeout", () => request.destroy(new Error("Core request timed out")));
      request.once("error", reject);
      request.end(data);
    });
  }
}

function identity(job: JobProtocolV3) {
  return Object.freeze({ workspaceId: job.workspaceId, leaseToken: job.lease.token });
}

async function optionalFile(path: string | null): Promise<Buffer | undefined> {
  return path ? await readFile(path) : undefined;
}
