import { createHash, randomUUID } from "node:crypto";
import { createReadStream } from "node:fs";
import { chmod, link, lstat, open, readFile, realpath, unlink } from "node:fs/promises";
import { request as httpsRequest, type RequestOptions } from "node:https";
import { dirname, isAbsolute, join, resolve, sep } from "node:path";
import type { SignedRunnerJob } from "./contracts";
import { sha256Canonical } from "./canonical";

const SHA256 = /^[a-f0-9]{64}$/;
const MAX_BROKER_RESPONSE_BYTES = 512 * 1024;
const MAX_TRANSFER_ERROR_BYTES = 64 * 1024;

export const REQUIRED_TESTKIT_ARTIFACT_ENV_NAMES = Object.freeze([
  "DEVILUDO_TESTKIT_ARTIFACT_BROKER_URL",
  "DEVILUDO_TESTKIT_ARTIFACT_TLS_KEY_FILE",
  "DEVILUDO_TESTKIT_ARTIFACT_TLS_CERT_FILE",
  "DEVILUDO_TESTKIT_ARTIFACT_CA_FILE",
  "DEVILUDO_TESTKIT_TRANSFER_CA_FILE",
  "DEVILUDO_TESTKIT_ALLOWED_TRANSFER_ORIGINS_JSON",
] as const);

export const OPTIONAL_TESTKIT_ARTIFACT_ENV_NAMES = Object.freeze([
  "DEVILUDO_TESTKIT_ARTIFACT_REQUEST_TIMEOUT_SECONDS",
  "DEVILUDO_TESTKIT_ARTIFACT_TRANSFER_TIMEOUT_SECONDS",
  "DEVILUDO_TESTKIT_MAX_INPUT_BYTES",
] as const);

export type TestKitArtifactKind =
  | "logs"
  | "junit"
  | "input-timeline"
  | "screenshot-manifest"
  | "video-manifest"
  | "production-export";

export interface TestKitArtifactBrokerTls {
  readonly key: Buffer;
  readonly certificate: Buffer;
  readonly ca: Buffer;
}

export interface TestKitArtifactBrokerHttpResponse {
  readonly statusCode: number;
  readonly payload: unknown;
}

export type TestKitArtifactBrokerHttp = (input: {
  readonly url: URL;
  readonly body: string;
  readonly tls: TestKitArtifactBrokerTls;
  readonly timeoutMs: number;
}) => Promise<TestKitArtifactBrokerHttpResponse>;

export interface TestKitArtifactTransferHttp {
  download(input: {
    readonly url: URL;
    readonly headers: Readonly<Record<string, string>>;
    readonly ca: Buffer;
    readonly destinationPath: string;
    readonly maxBytes: number;
    readonly timeoutMs: number;
  }): Promise<Readonly<{ statusCode: number; sizeBytes: number; artifactDigest: string }>>;
  upload(input: {
    readonly url: URL;
    readonly headers: Readonly<Record<string, string>>;
    readonly ca: Buffer;
    readonly sourcePath: string;
    readonly sizeBytes: number;
    readonly timeoutMs: number;
  }): Promise<Readonly<{ statusCode: number }>>;
}

type ArtifactGrant = Readonly<{
  jobDigest: string;
  operation: "DOWNLOAD_INPUT" | "DOWNLOAD_TEST_PLAN" | "UPLOAD_EVIDENCE";
  artifactKind: "source-artifact" | "test-plan" | TestKitArtifactKind;
  artifactDigest: string;
  objectKey: string;
  sizeBytes: number | null;
  method: "GET" | "PUT";
  url: URL;
  requiredHeaders: Readonly<Record<string, string>>;
  expiresAt: string;
  commitRequired: boolean;
}>;

export class MtlsTestKitArtifactClient {
  readonly #endpoint: URL;
  readonly #tls: TestKitArtifactBrokerTls;
  readonly #transferCa: Buffer;
  readonly #allowedTransferOrigins: ReadonlySet<string>;
  readonly #requestTimeoutMs: number;
  readonly #transferTimeoutMs: number;
  readonly #maxInputBytes: number;
  readonly #brokerHttp: TestKitArtifactBrokerHttp;
  readonly #transferHttp: TestKitArtifactTransferHttp;
  readonly #now: () => Date;

  constructor(options: {
    readonly endpoint: string | URL;
    readonly tls: TestKitArtifactBrokerTls;
    readonly transferCa: Buffer;
    readonly allowedTransferOrigins: readonly string[];
    readonly requestTimeoutMs?: number;
    readonly transferTimeoutMs?: number;
    readonly maxInputBytes?: number;
    readonly brokerHttp?: TestKitArtifactBrokerHttp;
    readonly transferHttp?: TestKitArtifactTransferHttp;
    readonly now?: () => Date;
  }) {
    this.#endpoint = strictBrokerOrigin(options.endpoint);
    validateTls(options.tls);
    if (!Buffer.isBuffer(options.transferCa) || options.transferCa.byteLength < 32 || options.transferCa.byteLength > 1024 * 1024) invalidConfig();
    this.#tls = Object.freeze({ ...options.tls });
    this.#transferCa = Buffer.from(options.transferCa);
    this.#allowedTransferOrigins = transferOrigins(options.allowedTransferOrigins);
    this.#requestTimeoutMs = integer(options.requestTimeoutMs ?? 30_000, 1_000, 600_000);
    this.#transferTimeoutMs = integer(options.transferTimeoutMs ?? 2 * 60 * 60_000, 1_000, 24 * 60 * 60_000);
    this.#maxInputBytes = integer(options.maxInputBytes ?? 16 * 1024 * 1024 * 1024, 1, 64 * 1024 * 1024 * 1024);
    this.#brokerHttp = options.brokerHttp ?? testKitArtifactBrokerHttpsJson;
    this.#transferHttp = options.transferHttp ?? directArtifactTransferHttps;
    this.#now = options.now ?? (() => new Date());
  }

  async downloadInput(job: SignedRunnerJob, destinationPath: string): Promise<Readonly<{ sizeBytes: number; artifactDigest: string }>> {
    if (job.payload.execution.kind !== "SOURCE_ARTIFACT") throw new Error("TestKit source download requires a source-artifact job");
    return this.#download(job, destinationPath, {
      operation: "DOWNLOAD_INPUT",
      artifactKind: "source-artifact",
      artifactDigest: job.payload.execution.artifactDigest,
      objectKey: job.payload.execution.objectKey,
      maxBytes: this.#maxInputBytes,
    });
  }

  async downloadTestPlan(job: SignedRunnerJob, destinationPath: string): Promise<Readonly<{ sizeBytes: number; artifactDigest: string }>> {
    return this.#download(job, destinationPath, {
      operation: "DOWNLOAD_TEST_PLAN",
      artifactKind: "test-plan",
      artifactDigest: job.payload.testPlanDigest,
      objectKey: expectedTestPlanObjectKey(job),
      maxBytes: 4 * 1024 * 1024,
    });
  }

  async #download(
    job: SignedRunnerJob,
    destinationPath: string,
    binding: Readonly<{
      operation: "DOWNLOAD_INPUT" | "DOWNLOAD_TEST_PLAN";
      artifactKind: "source-artifact" | "test-plan";
      artifactDigest: string;
      objectKey: string;
      maxBytes: number;
    }>,
  ): Promise<Readonly<{ sizeBytes: number; artifactDigest: string }>> {
    const destination = absolutePath(destinationPath, "download destination");
    const expectedDigest = binding.artifactDigest;
    const replay = await optionalFileDigest(destination, binding.maxBytes);
    if (replay) {
      if (replay.artifactDigest !== expectedDigest) throw new Error("TestKit download destination conflicts with the signed job");
      return replay;
    }
    const grant = await this.#grant(job, { kind: binding.operation });
    assertDownloadGrant(grant, job, binding, this.#now(), this.#allowedTransferOrigins);
    const parent = await verifiedParent(destination);
    const temporary = join(parent, `.${expectedDigest}.${randomUUID()}.download`);
    let temporaryExists = false;
    try {
      const resultPromise = this.#transferHttp.download({
        url: grant.url,
        headers: grant.requiredHeaders,
        ca: this.#transferCa,
        destinationPath: temporary,
        maxBytes: binding.maxBytes,
        timeoutMs: this.#transferTimeoutMs,
      });
      temporaryExists = true;
      const result = await resultPromise;
      if (result.statusCode !== 200 || result.artifactDigest !== expectedDigest
        || result.sizeBytes < 1 || result.sizeBytes > binding.maxBytes) {
        throw new Error("TestKit download failed content verification");
      }
      const materialized = await requiredFileDigest(temporary, binding.maxBytes);
      if (materialized.artifactDigest !== expectedDigest || materialized.artifactDigest !== result.artifactDigest
        || materialized.sizeBytes !== result.sizeBytes) {
        throw new Error("TestKit download failed file verification");
      }
      if (process.platform !== "win32") await chmod(temporary, 0o400);
      try { await link(temporary, destination); }
      catch (error) {
        if ((error as NodeJS.ErrnoException).code !== "EEXIST") throw error;
        const existing = await requiredFileDigest(destination, binding.maxBytes);
        if (existing.artifactDigest !== expectedDigest || existing.sizeBytes !== result.sizeBytes) {
          throw new Error("TestKit download destination conflicts with the signed job");
        }
      }
      return Object.freeze({ sizeBytes: result.sizeBytes, artifactDigest: result.artifactDigest });
    } finally {
      if (temporaryExists) await unlink(temporary).catch(() => undefined);
    }
  }

  async uploadEvidence(
    job: SignedRunnerJob,
    artifactKind: TestKitArtifactKind,
    sourcePath: string,
  ): Promise<Readonly<{ objectKey: string; artifactDigest: string; sizeBytes: number }>> {
    const source = absolutePath(sourcePath, "evidence source");
    const artifact = await requiredFileDigest(source, 8 * 1024 * 1024 * 1024);
    const grant = await this.#grant(job, {
      kind: "UPLOAD_EVIDENCE",
      artifactKind,
      artifactDigest: artifact.artifactDigest,
      sizeBytes: artifact.sizeBytes,
    });
    assertUploadGrant(grant, job, artifactKind, artifact, this.#now(), this.#allowedTransferOrigins);
    const uploaded = await this.#transferHttp.upload({
      url: grant.url,
      headers: grant.requiredHeaders,
      ca: this.#transferCa,
      sourcePath: source,
      sizeBytes: artifact.sizeBytes,
      timeoutMs: this.#transferTimeoutMs,
    });
    if (!((uploaded.statusCode >= 200 && uploaded.statusCode < 300) || uploaded.statusCode === 409 || uploaded.statusCode === 412)) {
      throw new Error("TestKit evidence upload was rejected");
    }
    const afterUpload = await requiredFileDigest(source, 8 * 1024 * 1024 * 1024);
    if (afterUpload.artifactDigest !== artifact.artifactDigest || afterUpload.sizeBytes !== artifact.sizeBytes) {
      throw new Error("TestKit evidence file changed during upload");
    }
    const receipt = await this.#post("/v1/runner-artifact-commits", {
      schemaVersion: "deviludo.runner-artifact-commit-request.v1",
      job,
      artifactKind,
      artifactDigest: artifact.artifactDigest,
      sizeBytes: artifact.sizeBytes,
    });
    return parseCommitReceipt(receipt, job, artifactKind, artifact, grant.objectKey);
  }

  async probe(): Promise<void> {
    // The evidence archive health route is intentionally restricted to the
    // Runner-ingress workload. A physical Runner proves readiness by obtaining
    // its first job-bound grant instead of using an unauthenticated probe.
  }

  async #grant(job: SignedRunnerJob, operation: Readonly<Record<string, unknown>>): Promise<ArtifactGrant> {
    const payload = await this.#post("/v1/runner-artifact-grants", {
      schemaVersion: "deviludo.runner-artifact-grant-request.v1",
      job,
      operation,
    });
    return parseGrant(payload);
  }

  async #post(path: string, body: Readonly<Record<string, unknown>>): Promise<unknown> {
    const url = new URL(this.#endpoint.href);
    url.pathname = path;
    const response = await this.#brokerHttp({
      url,
      body: JSON.stringify(body),
      tls: this.#tls,
      timeoutMs: this.#requestTimeoutMs,
    });
    if (response.statusCode !== 200) throw new Error(`TestKit artifact Broker rejected the request with status ${response.statusCode}`);
    return response.payload;
  }
}

export async function testKitArtifactClientFromEnv(
  env: Readonly<Record<string, string | undefined>> = process.env,
): Promise<MtlsTestKitArtifactClient> {
  const controlled = testKitArtifactProcessEnvironmentFromEnv(env);
  const [key, certificate, ca, transferCa] = await Promise.all([
    readRequiredFile(controlled, "DEVILUDO_TESTKIT_ARTIFACT_TLS_KEY_FILE"),
    readRequiredFile(controlled, "DEVILUDO_TESTKIT_ARTIFACT_TLS_CERT_FILE"),
    readRequiredFile(controlled, "DEVILUDO_TESTKIT_ARTIFACT_CA_FILE"),
    readRequiredFile(controlled, "DEVILUDO_TESTKIT_TRANSFER_CA_FILE"),
  ]);
  return new MtlsTestKitArtifactClient({
    endpoint: requiredEnv(controlled, "DEVILUDO_TESTKIT_ARTIFACT_BROKER_URL"),
    tls: { key, certificate, ca },
    transferCa,
    allowedTransferOrigins: parseOrigins(requiredEnv(controlled, "DEVILUDO_TESTKIT_ALLOWED_TRANSFER_ORIGINS_JSON")),
    requestTimeoutMs: seconds(controlled.DEVILUDO_TESTKIT_ARTIFACT_REQUEST_TIMEOUT_SECONDS, 30, 1, 600) * 1_000,
    transferTimeoutMs: seconds(controlled.DEVILUDO_TESTKIT_ARTIFACT_TRANSFER_TIMEOUT_SECONDS, 7_200, 1, 86_400) * 1_000,
    maxInputBytes: integerString(controlled.DEVILUDO_TESTKIT_MAX_INPUT_BYTES, 16 * 1024 * 1024 * 1024, 1, 64 * 1024 * 1024 * 1024),
  });
}

/** Returns the only host values that the locked TestKit child may inherit. */
export function testKitArtifactProcessEnvironmentFromEnv(
  env: Readonly<Record<string, string | undefined>> = process.env,
): Readonly<Record<string, string>> {
  const result: Record<string, string> = {
    DEVILUDO_TESTKIT_ARTIFACT_BROKER_URL: strictBrokerOrigin(
      requiredEnv(env, "DEVILUDO_TESTKIT_ARTIFACT_BROKER_URL"),
    ).origin,
    DEVILUDO_TESTKIT_ARTIFACT_TLS_KEY_FILE: absolutePath(
      requiredEnv(env, "DEVILUDO_TESTKIT_ARTIFACT_TLS_KEY_FILE"), "TLS key file",
    ),
    DEVILUDO_TESTKIT_ARTIFACT_TLS_CERT_FILE: absolutePath(
      requiredEnv(env, "DEVILUDO_TESTKIT_ARTIFACT_TLS_CERT_FILE"), "TLS certificate file",
    ),
    DEVILUDO_TESTKIT_ARTIFACT_CA_FILE: absolutePath(
      requiredEnv(env, "DEVILUDO_TESTKIT_ARTIFACT_CA_FILE"), "Broker CA file",
    ),
    DEVILUDO_TESTKIT_TRANSFER_CA_FILE: absolutePath(
      requiredEnv(env, "DEVILUDO_TESTKIT_TRANSFER_CA_FILE"), "transfer CA file",
    ),
    DEVILUDO_TESTKIT_ALLOWED_TRANSFER_ORIGINS_JSON: JSON.stringify([
      ...transferOrigins(parseOrigins(requiredEnv(env, "DEVILUDO_TESTKIT_ALLOWED_TRANSFER_ORIGINS_JSON"))),
    ]),
  };
  const requestSeconds = env.DEVILUDO_TESTKIT_ARTIFACT_REQUEST_TIMEOUT_SECONDS;
  if (requestSeconds !== undefined) result.DEVILUDO_TESTKIT_ARTIFACT_REQUEST_TIMEOUT_SECONDS = String(seconds(requestSeconds, 30, 1, 600));
  const transferSeconds = env.DEVILUDO_TESTKIT_ARTIFACT_TRANSFER_TIMEOUT_SECONDS;
  if (transferSeconds !== undefined) result.DEVILUDO_TESTKIT_ARTIFACT_TRANSFER_TIMEOUT_SECONDS = String(seconds(transferSeconds, 7_200, 1, 86_400));
  const maxInputBytes = env.DEVILUDO_TESTKIT_MAX_INPUT_BYTES;
  if (maxInputBytes !== undefined) {
    result.DEVILUDO_TESTKIT_MAX_INPUT_BYTES = String(integerString(
      maxInputBytes, 16 * 1024 * 1024 * 1024, 1, 64 * 1024 * 1024 * 1024,
    ));
  }
  return Object.freeze(result);
}

export function testKitArtifactBrokerHttpsJson(input: {
  readonly url: URL;
  readonly body: string;
  readonly tls: TestKitArtifactBrokerTls;
  readonly timeoutMs: number;
}): Promise<TestKitArtifactBrokerHttpResponse> {
  return new Promise((resolve, reject) => {
    const options: RequestOptions = {
      method: "POST",
      headers: {
        accept: "application/json",
        "content-type": "application/json",
        "content-length": String(Buffer.byteLength(input.body)),
      },
      key: input.tls.key,
      cert: input.tls.certificate,
      ca: input.tls.ca,
      rejectUnauthorized: true,
      minVersion: "TLSv1.3",
      servername: input.url.hostname,
    };
    const request = httpsRequest(input.url, options, (response) => {
      const chunks: Buffer[] = [];
      let bytes = 0;
      response.on("data", (chunk: Buffer | string) => {
        const value = Buffer.isBuffer(chunk) ? chunk : Buffer.from(chunk);
        bytes += value.byteLength;
        if (bytes > MAX_BROKER_RESPONSE_BYTES) {
          response.destroy(new Error("TestKit artifact Broker response exceeded the limit"));
          return;
        }
        chunks.push(value);
      });
      response.once("error", reject);
      response.once("end", () => {
        try {
          resolve({ statusCode: response.statusCode ?? 503, payload: JSON.parse(Buffer.concat(chunks).toString("utf8")) as unknown });
        } catch { reject(new Error("TestKit artifact Broker returned invalid JSON")); }
      });
    });
    request.setTimeout(input.timeoutMs, () => request.destroy(new Error("TestKit artifact Broker request timed out")));
    request.once("error", reject);
    request.end(input.body);
  });
}

export const directArtifactTransferHttps: TestKitArtifactTransferHttp = Object.freeze<TestKitArtifactTransferHttp>({
  async download(input) {
    strictTransferUrl(input.url);
    const file = await open(input.destinationPath, "wx", 0o600);
    try {
      return await new Promise((resolve, reject) => {
        const request = httpsRequest(input.url, transferOptions("GET", input.url, input.headers, input.ca), (response) => {
          const statusCode = response.statusCode ?? 503;
          if (statusCode !== 200) {
            response.resume();
            reject(new Error(`TestKit artifact download returned status ${statusCode}`));
            return;
          }
          const declared = Number(response.headers["content-length"]);
          if (!Number.isSafeInteger(declared) || declared < 1 || declared > input.maxBytes) {
            response.destroy(new Error("TestKit artifact download length is invalid"));
            return;
          }
          const hash = createHash("sha256");
          let sizeBytes = 0;
          const consume = async () => {
            for await (const chunk of response) {
              const value = Buffer.isBuffer(chunk) ? chunk : Buffer.from(chunk);
              sizeBytes += value.byteLength;
              if (sizeBytes > input.maxBytes || sizeBytes > declared) throw new Error("TestKit artifact download exceeded its bound");
              hash.update(value);
              await writeAll(file, value);
            }
            if (sizeBytes !== declared) throw new Error("TestKit artifact download was truncated");
            await file.sync();
            resolve(Object.freeze({ statusCode, sizeBytes, artifactDigest: hash.digest("hex") }));
          };
          void consume().catch(reject);
        });
        request.setTimeout(input.timeoutMs, () => request.destroy(new Error("TestKit artifact download timed out")));
        request.once("error", reject);
        request.end();
      });
    } finally {
      await file.close();
    }
  },
  async upload(input) {
    strictTransferUrl(input.url);
    return new Promise((resolve, reject) => {
      const request = httpsRequest(input.url, transferOptions("PUT", input.url, input.headers, input.ca), (response) => {
        let bytes = 0;
        response.on("data", (chunk: Buffer | string) => {
          bytes += Buffer.byteLength(chunk);
          if (bytes > MAX_TRANSFER_ERROR_BYTES) response.destroy(new Error("TestKit artifact upload response exceeded the limit"));
        });
        response.once("error", reject);
        response.once("end", () => resolve(Object.freeze({ statusCode: response.statusCode ?? 503 })));
      });
      request.setTimeout(input.timeoutMs, () => request.destroy(new Error("TestKit artifact upload timed out")));
      request.once("error", reject);
      const source = createReadStream(input.sourcePath, { start: 0, end: input.sizeBytes - 1 });
      source.once("error", (error) => request.destroy(error));
      source.pipe(request);
    });
  },
});

function parseGrant(value: unknown): ArtifactGrant {
  const body = record(value);
  exactKeys(body, [
    "schemaVersion", "jobDigest", "operation", "artifactKind", "artifactDigest", "objectKey", "sizeBytes",
    "method", "url", "requiredHeaders", "expiresAt", "commitRequired",
  ]);
  if (body.schemaVersion !== "deviludo.runner-artifact-grant.v1"
    || typeof body.jobDigest !== "string" || !SHA256.test(body.jobDigest)
    || (body.operation !== "DOWNLOAD_INPUT" && body.operation !== "DOWNLOAD_TEST_PLAN"
      && body.operation !== "UPLOAD_EVIDENCE")
    || typeof body.artifactKind !== "string" || typeof body.artifactDigest !== "string" || !SHA256.test(body.artifactDigest)
    || typeof body.objectKey !== "string" || body.objectKey.length > 1_024 || body.objectKey.includes("..")
    || (body.sizeBytes !== null && (!Number.isSafeInteger(body.sizeBytes) || (body.sizeBytes as number) < 1))
    || (body.method !== "GET" && body.method !== "PUT") || typeof body.url !== "string"
    || typeof body.expiresAt !== "string" || !Number.isFinite(Date.parse(body.expiresAt))
    || typeof body.commitRequired !== "boolean") invalidResponse();
  const requiredHeadersBody = record(body.requiredHeaders);
  const headerEntries = Object.entries(requiredHeadersBody);
  if (headerEntries.length > 16) invalidResponse();
  const requiredHeaders: Record<string, string> = {};
  let totalHeaderBytes = 0;
  for (const [name, header] of headerEntries) {
    if (!/^[a-z0-9][a-z0-9-]{0,63}$/.test(name) || typeof header !== "string" || !header
      || header.length > 2_048 || /\r|\n|\0/.test(header)) invalidResponse();
    totalHeaderBytes += Buffer.byteLength(name) + Buffer.byteLength(header);
    if (totalHeaderBytes > 8_192) invalidResponse();
    requiredHeaders[name] = header;
  }
  let url: URL;
  try { url = new URL(body.url); }
  catch { invalidResponse(); }
  strictTransferUrl(url);
  return Object.freeze({
    jobDigest: body.jobDigest,
    operation: body.operation,
    artifactKind: body.artifactKind as ArtifactGrant["artifactKind"],
    artifactDigest: body.artifactDigest,
    objectKey: body.objectKey,
    sizeBytes: body.sizeBytes as number | null,
    method: body.method,
    url,
    requiredHeaders: Object.freeze(requiredHeaders),
    expiresAt: body.expiresAt,
    commitRequired: body.commitRequired,
  });
}

function assertDownloadGrant(
  grant: ArtifactGrant,
  job: SignedRunnerJob,
  binding: Readonly<{
    operation: "DOWNLOAD_INPUT" | "DOWNLOAD_TEST_PLAN";
    artifactKind: "source-artifact" | "test-plan";
    artifactDigest: string;
    objectKey: string;
  }>,
  now: Date,
  origins: ReadonlySet<string>,
): void {
  if (grant.jobDigest !== sha256Canonical(job.payload)
    || grant.operation !== binding.operation || grant.artifactKind !== binding.artifactKind
    || grant.artifactDigest !== binding.artifactDigest || grant.objectKey !== binding.objectKey
    || grant.sizeBytes !== null || grant.method !== "GET" || grant.commitRequired
    || Object.keys(grant.requiredHeaders).length !== 0) invalidResponse();
  validateGrantTimeAndOrigin(grant, job, now, origins);
}

function expectedTestPlanObjectKey(job: SignedRunnerJob): string {
  const payload = job.payload;
  return `tenants/${payload.tenantId}/projects/${payload.projectId}/test-plans/${payload.testPlanDigest}.json`;
}

function assertUploadGrant(
  grant: ArtifactGrant,
  job: SignedRunnerJob,
  kind: TestKitArtifactKind,
  artifact: { artifactDigest: string; sizeBytes: number },
  now: Date,
  origins: ReadonlySet<string>,
): void {
  if (grant.jobDigest !== sha256Canonical(job.payload) || grant.operation !== "UPLOAD_EVIDENCE"
    || grant.artifactKind !== kind || grant.artifactDigest !== artifact.artifactDigest
    || grant.objectKey !== expectedArtifactObjectKey(job, kind, artifact.artifactDigest)
    || grant.sizeBytes !== artifact.sizeBytes || grant.method !== "PUT" || !grant.commitRequired
    || grant.requiredHeaders["content-length"] !== String(artifact.sizeBytes)
    || grant.requiredHeaders["if-none-match"] !== "*"
    || grant.requiredHeaders["content-type"] !== artifactContentType(kind)
    || grant.requiredHeaders["x-amz-meta-deviludo-sha256"] !== artifact.artifactDigest
    || grant.requiredHeaders["x-amz-checksum-sha256"] !== Buffer.from(artifact.artifactDigest, "hex").toString("base64")) invalidResponse();
  exactHeaderNames(grant.requiredHeaders, [
    "content-length", "content-type", "if-none-match", "x-amz-checksum-sha256", "x-amz-meta-deviludo-sha256",
  ]);
  validateGrantTimeAndOrigin(grant, job, now, origins);
}

function artifactContentType(kind: TestKitArtifactKind): string {
  switch (kind) {
    case "logs": return "text/plain";
    case "junit": return "application/xml";
    case "input-timeline": return "application/json";
    case "screenshot-manifest":
    case "video-manifest": return "application/vnd.deviludo.evidence-package";
    case "production-export": return "application/octet-stream";
  }
}

function expectedArtifactObjectKey(job: SignedRunnerJob, kind: TestKitArtifactKind, digest: string): string {
  const payload = job.payload;
  return `tenants/${payload.tenantId}/projects/${payload.projectId}/runner-artifacts/${payload.attemptId}/${payload.platform}/${kind}/${digest}`;
}

function exactHeaderNames(headers: Readonly<Record<string, string>>, expected: readonly string[]): void {
  const actual = Object.keys(headers).sort();
  const sorted = [...expected].sort();
  if (actual.length !== sorted.length || actual.some((name, index) => name !== sorted[index])) invalidResponse();
}

function validateGrantTimeAndOrigin(grant: ArtifactGrant, job: SignedRunnerJob, now: Date, origins: ReadonlySet<string>): void {
  const observed = now.getTime();
  const expiry = Date.parse(grant.expiresAt);
  if (!Number.isFinite(observed) || expiry <= observed || expiry > observed + 5 * 60_000
    || expiry > Date.parse(job.payload.leaseExpiresAt) || !origins.has(grant.url.origin)) invalidResponse();
}

function parseCommitReceipt(
  value: unknown,
  job: SignedRunnerJob,
  kind: TestKitArtifactKind,
  artifact: { artifactDigest: string; sizeBytes: number },
  objectKey: string,
): Readonly<{ objectKey: string; artifactDigest: string; sizeBytes: number }> {
  const body = record(value);
  exactKeys(body, [
    "schemaVersion", "jobDigest", "attemptId", "platform", "artifactKind", "artifactDigest", "objectKey", "sizeBytes", "verified",
  ]);
  if (body.schemaVersion !== "deviludo.runner-artifact-commit-receipt.v1"
    || body.jobDigest !== sha256Canonical(job.payload) || body.attemptId !== job.payload.attemptId
    || body.platform !== job.payload.platform || body.artifactKind !== kind
    || body.artifactDigest !== artifact.artifactDigest || body.objectKey !== objectKey
    || body.sizeBytes !== artifact.sizeBytes || body.verified !== true) invalidResponse();
  return Object.freeze({ objectKey, artifactDigest: artifact.artifactDigest, sizeBytes: artifact.sizeBytes });
}

async function requiredFileDigest(path: string, maximum: number): Promise<Readonly<{ sizeBytes: number; artifactDigest: string }>> {
  const metadata = await lstat(path);
  if (!metadata.isFile() || metadata.isSymbolicLink() || metadata.size < 1 || metadata.size > maximum) {
    throw new Error("TestKit artifact file is invalid");
  }
  const file = await open(path, "r");
  try {
    const opened = await file.stat();
    if (!opened.isFile() || opened.size !== metadata.size) throw new Error("TestKit artifact file changed during hashing");
    const hash = createHash("sha256");
    const buffer = Buffer.allocUnsafe(1024 * 1024);
    let position = 0;
    while (position < opened.size) {
      const { bytesRead } = await file.read(buffer, 0, Math.min(buffer.byteLength, opened.size - position), position);
      if (bytesRead < 1) throw new Error("TestKit artifact file changed during hashing");
      hash.update(buffer.subarray(0, bytesRead));
      position += bytesRead;
    }
    const after = await file.stat();
    if (after.size !== opened.size || after.mtimeMs !== opened.mtimeMs) throw new Error("TestKit artifact file changed during hashing");
    return Object.freeze({ sizeBytes: opened.size, artifactDigest: hash.digest("hex") });
  } finally { await file.close(); }
}

async function writeAll(file: Awaited<ReturnType<typeof open>>, value: Buffer): Promise<void> {
  let offset = 0;
  while (offset < value.byteLength) {
    const { bytesWritten } = await file.write(value, offset, value.byteLength - offset);
    if (bytesWritten < 1) throw new Error("TestKit artifact download could not be written");
    offset += bytesWritten;
  }
}

async function optionalFileDigest(path: string, maximum: number): Promise<Readonly<{ sizeBytes: number; artifactDigest: string }> | null> {
  try { return await requiredFileDigest(path, maximum); }
  catch (error) {
    if ((error as NodeJS.ErrnoException).code === "ENOENT") return null;
    throw error;
  }
}

async function verifiedParent(path: string): Promise<string> {
  const parent = dirname(path);
  const canonical = await realpath(parent);
  const traversal = resolve(canonical, "placeholder");
  if (!isAbsolute(canonical) || !traversal.startsWith(`${canonical}${sep}`)) throw new Error("TestKit artifact parent is invalid");
  const metadata = await lstat(canonical);
  if (!metadata.isDirectory() || metadata.isSymbolicLink()) throw new Error("TestKit artifact parent is invalid");
  return canonical;
}

function transferOptions(
  method: "GET" | "PUT",
  url: URL,
  headers: Readonly<Record<string, string>>,
  ca: Buffer,
): RequestOptions {
  return { method, headers, ca, rejectUnauthorized: true, minVersion: "TLSv1.3", servername: url.hostname };
}

function strictBrokerOrigin(value: string | URL): URL {
  const url = new URL(value);
  if (url.protocol !== "https:" || !url.hostname || url.username || url.password || url.search || url.hash
    || (url.pathname !== "/" && url.pathname !== "")) invalidConfig();
  return url;
}

function strictTransferUrl(url: URL): void {
  if (url.protocol !== "https:" || !url.hostname || url.username || url.password || url.hash) invalidResponse();
}

function transferOrigins(values: readonly string[]): ReadonlySet<string> {
  if (!Array.isArray(values) || values.length < 1 || values.length > 16 || new Set(values).size !== values.length) invalidConfig();
  const sorted = values.map((value) => {
    const url = strictBrokerOrigin(value);
    return url.origin;
  }).sort();
  if (JSON.stringify(sorted) !== JSON.stringify(values)) invalidConfig();
  return new Set(sorted);
}

function parseOrigins(value: string): readonly string[] {
  let parsed: unknown;
  try { parsed = JSON.parse(value) as unknown; }
  catch { invalidConfig(); }
  if (!Array.isArray(parsed) || parsed.some((item) => typeof item !== "string")) invalidConfig();
  return parsed as string[];
}

function validateTls(value: TestKitArtifactBrokerTls): void {
  if (!Buffer.isBuffer(value.key) || !Buffer.isBuffer(value.certificate) || !Buffer.isBuffer(value.ca)
    || value.key.byteLength < 32 || value.certificate.byteLength < 32 || value.ca.byteLength < 32) invalidConfig();
}

async function readRequiredFile(env: Readonly<Record<string, string | undefined>>, name: string): Promise<Buffer> {
  const path = absolutePath(requiredEnv(env, name), `${name} file`);
  const value = await readFile(path);
  if (value.byteLength < 32 || value.byteLength > 1024 * 1024) invalidConfig();
  return value;
}

function requiredEnv(env: Readonly<Record<string, string | undefined>>, name: string): string {
  const value = env[name]?.trim();
  if (!value) throw new Error(`${name} is required`);
  return value;
}

function absolutePath(value: string, label: string): string {
  if (!isAbsolute(value) || resolve(value) !== value || value.length > 4_096 || /\0/.test(value)) {
    throw new Error(`TestKit artifact ${label} path is invalid`);
  }
  return value;
}

function integerString(value: string | undefined, fallback: number, minimum: number, maximum: number): number {
  if (value === undefined) return fallback;
  const parsed = Number.parseInt(value, 10);
  if (String(parsed) !== value) invalidConfig();
  return integer(parsed, minimum, maximum);
}

function seconds(value: string | undefined, fallback: number, minimum: number, maximum: number): number {
  return integerString(value, fallback, minimum, maximum);
}

function integer(value: number, minimum: number, maximum: number): number {
  if (!Number.isSafeInteger(value) || value < minimum || value > maximum) invalidConfig();
  return value;
}

function record(value: unknown): Record<string, unknown> {
  if (!value || typeof value !== "object" || Array.isArray(value)) invalidResponse();
  return value as Record<string, unknown>;
}

function exactKeys(body: Record<string, unknown>, expected: readonly string[]): void {
  const actual = Object.keys(body).sort();
  const sorted = [...expected].sort();
  if (actual.length !== sorted.length || actual.some((key, index) => key !== sorted[index])) invalidResponse();
}

function invalidConfig(): never { throw new Error("TestKit artifact client configuration is invalid"); }
function invalidResponse(): never { throw new Error("TestKit artifact Broker response is invalid"); }
