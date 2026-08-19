import { readFile } from "node:fs/promises";
import { request as httpRequest } from "node:http";
import { request as httpsRequest, type RequestOptions } from "node:https";
import type { JobCompletion, JobProtocolV4 } from "@/services/core/src/contracts";
import type { E2eNodeConfig } from "./config";
import type { E2eInfrastructureFailure } from "@/lib/runtime/e2e-failure";

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

  async claim(): Promise<JobProtocolV4 | null> {
    const response = await this.call<{ job: JobProtocolV4 | null }>("/v1/e2e/jobs/claim", {
      nodeId: this.config.nodeId,
      poolKind: this.config.poolKind,
    });
    return response.job;
  }

  async heartbeat(job: JobProtocolV4): Promise<boolean> {
    const response = await this.call<{ accepted: boolean }>(`/v1/e2e/jobs/${job.jobId}/heartbeat`, identity(job, this.config.nodeId));
    return response.accepted;
  }

  async complete(job: JobProtocolV4, completion: JobCompletion): Promise<boolean> {
    const response = await this.call<{ accepted: boolean }>(`/v1/e2e/jobs/${job.jobId}/complete`, {
      ...identity(job, this.config.nodeId),
      ...completion,
    });
    return response.accepted;
  }

  async fail(job: JobProtocolV4, failure: E2eInfrastructureFailure): Promise<boolean> {
    const response = await this.call<{ accepted: boolean }>(`/v1/e2e/jobs/${job.jobId}/fail`, {
      ...identity(job, this.config.nodeId),
      ...failure,
    });
    return response.accepted;
  }

  async authorizeObjects(job: JobProtocolV4): Promise<readonly Readonly<{ object: JobProtocolV4["inputObjects"][number]; url: string; expiresAt: string }>[]> {
    const response = await this.call<{ inputs: readonly Readonly<{ object: JobProtocolV4["inputObjects"][number]; url: string; expiresAt: string }>[] }>(
      `/v1/e2e/jobs/${job.jobId}/objects`, { ...identity(job, this.config.nodeId) },
    );
    return response.inputs;
  }

  async uploadOutput(job: JobProtocolV4, input: Readonly<{ kind: string; sha256: string; sizeBytes: number }>) {
    return this.call<{
      uploadUrl: string;
      expiresAt: string;
      object: JobProtocolV4["inputObjects"][number];
      requiredHeaders: Readonly<Record<string, string>>;
    }>(`/v1/e2e/jobs/${job.jobId}/outputs`, { ...identity(job, this.config.nodeId), ...input });
  }

  async verifyPlayerPolicy(job: JobProtocolV4): Promise<void> {
    await this.call(`/v1/e2e/jobs/${job.jobId}/player-policy/verify`, identity(job, this.config.nodeId));
  }

  async decidePlayerPolicy(job: JobProtocolV4, request: Readonly<Record<string, unknown>>) {
    return this.call<Readonly<{
      decision: Readonly<Record<string, unknown>>;
      policy: Readonly<{ configurationDigest: string; settingsRevision: number; model: string }>;
      cached: boolean;
    }>>(`/v1/e2e/jobs/${job.jobId}/player-policy`, { ...identity(job, this.config.nodeId), request });
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
        ...(this.config.developmentToken ? { "x-deviludo-node-id": this.config.nodeId } : {}),
      },
      cert: this.tls.cert,
      key: this.tls.key,
      ca: this.tls.ca,
      minVersion: "TLSv1.3",
      rejectUnauthorized: url.protocol === "https:",
      // A decision may consume six separately bounded Provider calls while
      // recovering transport, structured output, and lost image attachments.
      // Do not abandon the HTTP request while Core still owns its idempotency
      // lock, otherwise the guest retry queues behind work that is still alive.
      timeout: path.includes("/player-policy") ? 480_000 : 10_000,
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

function identity(job: JobProtocolV4, nodeId: string) {
  return Object.freeze({ workspaceId: job.workspaceId, leaseToken: job.lease.token, nodeId });
}

async function optionalFile(path: string | null): Promise<Buffer | undefined> {
  return path ? await readFile(path) : undefined;
}
