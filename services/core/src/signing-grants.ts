import { readFile } from "node:fs/promises";
import type { JobProtocolV4 } from "./contracts";

export type SigningGrant = Readonly<{
  grantId: string;
  wrappedToken: string;
  expiresAt: string;
}>;

export interface SigningGrantBroker {
  issue(job: JobProtocolV4): Promise<SigningGrant>;
}

export class HttpSigningGrantBroker implements SigningGrantBroker {
  async issue(job: JobProtocolV4): Promise<SigningGrant> {
    if (job.jobKind !== "ARTIFACT_SIGN" || !job.targetOperatingSystem || !job.poolKind.startsWith("E2E_")) {
      throw new Error("Signing grants are only available to platform-matched signing jobs");
    }
    const rawUrl = process.env.DEVILUDO_SIGNING_GRANT_BROKER_URL ?? "";
    if (!rawUrl) {
      if (process.env.NODE_ENV === "production") throw new Error("Signing grant broker is required");
      return Object.freeze({
        grantId: `development-${job.jobId}`,
        wrappedToken: `development-wrapped-${job.jobId}`,
        expiresAt: new Date(Date.now() + 60_000).toISOString(),
      });
    }
    const url = new URL("/v1/signing-grants", rawUrl);
    if (url.protocol !== "https:") throw new Error("Signing grant broker must use TLS");
    const tokenFile = process.env.DEVILUDO_SIGNING_GRANT_BROKER_TOKEN_FILE ?? "";
    if (!tokenFile.startsWith("/")) throw new Error("Signing grant broker token must be file-mounted");
    const token = (await readFile(tokenFile, "utf8")).trim();
    if (token.length < 24 || token.length > 4096) throw new Error("Signing grant broker token is invalid");
    const response = await fetch(url, {
      method: "POST",
      headers: {
        authorization: `Bearer ${token}`,
        "content-type": "application/json",
        "idempotency-key": `${job.jobId}:signing-grant:g${job.isolationGeneration}`,
      },
      body: JSON.stringify({
        workspaceId: job.workspaceId,
        projectId: job.projectId,
        jobId: job.jobId,
        poolKind: job.poolKind,
        operatingSystem: job.targetOperatingSystem,
        ttlSeconds: 300,
      }),
      signal: AbortSignal.timeout(5_000),
    });
    if (!response.ok) throw new Error(`Signing grant broker returned ${response.status}`);
    const value = await response.json() as Partial<SigningGrant>;
    if (typeof value.grantId !== "string"
      || typeof value.wrappedToken !== "string"
      || typeof value.expiresAt !== "string"
      || Date.parse(value.expiresAt) <= Date.now()
      || Date.parse(value.expiresAt) > Date.now() + 5 * 60_000) {
      throw new Error("Signing grant broker returned an invalid short-lived grant");
    }
    return Object.freeze(value as SigningGrant);
  }
}
