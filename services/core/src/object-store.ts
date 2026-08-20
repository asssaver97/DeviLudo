import {
  DeleteObjectsCommand,
  DeleteObjectCommand,
  GetObjectCommand,
  HeadObjectCommand,
  ListObjectsV2Command,
  PutObjectCommand,
  S3Client,
} from "@aws-sdk/client-s3";
import { getSignedUrl } from "@aws-sdk/s3-request-presigner";
import type { JobProtocolV4, ObjectReference } from "./contracts";
import type { ArtifactRecord } from "@/lib/product/contracts";
import { createHash } from "node:crypto";
import { parseProjectDocumentContent, projectDocumentMarkdown } from "@/lib/product/project-document";
import { parseResponseLanguage } from "@/lib/product/response-language";

export class CoreObjectStore {
  private readonly client: S3Client;
  private readonly publicClient: S3Client;
  private readonly bucket: string;

  constructor(env: NodeJS.ProcessEnv = process.env) {
    this.bucket = env.DEVILUDO_ARTIFACT_BUCKET ?? "";
    if (!this.bucket) throw new Error("DEVILUDO_ARTIFACT_BUCKET is required");
    const clientOptions = {
      region: env.DEVILUDO_S3_REGION ?? "us-east-1",
      endpoint: env.DEVILUDO_S3_ENDPOINT,
      forcePathStyle: env.DEVILUDO_S3_PATH_STYLE === "1",
      credentials: env.DEVILUDO_S3_ACCESS_KEY_ID && env.DEVILUDO_S3_SECRET_ACCESS_KEY
        ? { accessKeyId: env.DEVILUDO_S3_ACCESS_KEY_ID, secretAccessKey: env.DEVILUDO_S3_SECRET_ACCESS_KEY }
        : undefined,
    };
    this.client = new S3Client(clientOptions);
    this.publicClient = new S3Client({ ...clientOptions, endpoint: env.DEVILUDO_S3_PUBLIC_ENDPOINT ?? env.DEVILUDO_S3_ENDPOINT });
  }

  async authorizeInputs(job: JobProtocolV4) {
    return Promise.all(job.inputObjects.map(async object => Object.freeze({
      object,
      url: await getSignedUrl(this.publicClient, new GetObjectCommand({ Bucket: object.bucket, Key: object.key }), { expiresIn: 120 }),
      expiresAt: new Date(Date.now() + 120_000).toISOString(),
    })));
  }

  async authorizeArtifactDownload(artifact: ArtifactRecord) {
    const prefix = `workspaces/${artifact.workspaceId}/projects/${artifact.projectId}/`;
    if (artifact.object.bucket !== this.bucket
      || !artifact.object.key.startsWith(prefix)
      || !/^sha256:[0-9a-f]{64}$/.test(artifact.object.sha256)
      || !Number.isSafeInteger(artifact.object.sizeBytes) || artifact.object.sizeBytes < 1) {
      throw new Error("Artifact download boundary is invalid");
    }
    const rawFilename = artifact.object.key.split("/").at(-1) ?? "artifact.bin";
    const filename = /^[A-Za-z0-9._-]{1,180}$/.test(rawFilename) ? rawFilename : `artifact-${artifact.id}.bin`;
    const url = await getSignedUrl(this.publicClient, new GetObjectCommand({
      Bucket: artifact.object.bucket,
      Key: artifact.object.key,
      ResponseContentDisposition: `attachment; filename="${filename}"`,
    }), { expiresIn: 120 });
    return Object.freeze({ url, filename, expiresAt: new Date(Date.now() + 120_000).toISOString() });
  }

  async putSpecification(input: Readonly<{
    workspaceId: string;
    projectId: string;
    workflowId: string;
    specification: Readonly<Record<string, unknown>>;
  }>) {
    const content = Buffer.from(JSON.stringify(input.specification));
    const sha256 = `sha256:${createHash("sha256").update(content).digest("hex")}`;
    const key = `workspaces/${input.workspaceId}/projects/${input.projectId}/workflows/${input.workflowId}/specification.json`;
    await this.client.send(new PutObjectCommand({ Bucket: this.bucket, Key: key, Body: content, ContentType: "application/json", Metadata: { sha256 } }));
    return Object.freeze({ bucket: this.bucket, key, sha256, sizeBytes: content.length });
  }

  /**
   * Store a user-supplied game asset. Assets live under the project prefix so
   * they are removed with `deleteProjectObjects`, and the digest is computed
   * here rather than trusted from the client.
   */
  async putProjectAsset(input: Readonly<{
    workspaceId: string;
    projectId: string;
    assetKey: string;
    extension: string;
    contentType: string;
    content: Buffer;
  }>) {
    if (!isSafeAssetKey(input.assetKey)) throw new Error("Asset key is invalid");
    if (!/^(?:png|jpg|webp)$/.test(input.extension)) throw new Error("Asset extension is invalid");
    const sha256 = `sha256:${createHash("sha256").update(input.content).digest("hex")}`;
    const key = `workspaces/${input.workspaceId}/projects/${input.projectId}`
      + `/assets/${input.assetKey}-${sha256.slice(7, 23)}.${input.extension}`;
    await this.client.send(new PutObjectCommand({
      Bucket: this.bucket,
      Key: key,
      Body: input.content,
      ContentType: input.contentType,
      Metadata: { sha256 },
    }));
    return Object.freeze({ bucket: this.bucket, key, sha256, sizeBytes: input.content.length });
  }

  async deleteProjectObjects(workspaceId: string, projectId: string): Promise<void> {
    const prefix = `workspaces/${workspaceId}/projects/${projectId}/`;
    let continuationToken: string | undefined;
    do {
      const listed = await this.client.send(new ListObjectsV2Command({
        Bucket: this.bucket,
        Prefix: prefix,
        ContinuationToken: continuationToken,
      }));
      const objects = (listed.Contents ?? [])
        .flatMap(object => object.Key?.startsWith(prefix) ? [{ Key: object.Key }] : []);
      if (objects.length) {
        const deleted = await this.client.send(new DeleteObjectsCommand({
          Bucket: this.bucket,
          Delete: { Objects: objects, Quiet: true },
        }));
        if (deleted.Errors?.length) {
          throw new Error(`Project object cleanup failed (${deleted.Errors[0]?.Code ?? "UNKNOWN"})`);
        }
      }
      continuationToken = listed.IsTruncated ? listed.NextContinuationToken : undefined;
      if (listed.IsTruncated && !continuationToken) throw new Error("Project object cleanup pagination is invalid");
    } while (continuationToken);
  }

  async deleteQueuedObject(input: Readonly<{ workspaceId: string; bucket: string; key: string }>): Promise<void> {
    const prefix = `workspaces/${input.workspaceId}/`;
    if (input.bucket !== this.bucket || !input.key.startsWith(prefix)
      || input.key.includes("\0") || input.key.split("/").includes("..")) {
      throw new Error("Queued object cleanup boundary is invalid");
    }
    await this.client.send(new DeleteObjectCommand({ Bucket: input.bucket, Key: input.key }));
  }

  async authorizeOutput(job: JobProtocolV4, input: Readonly<{
    kind: string;
    sha256: string;
    sizeBytes: number;
    targetPlatform: string | null;
  }>) {
    if (!isValidOutputAuthorizationInput(input, job.outputContract.maxBytes)) {
      throw new Error("Output authorization contract is invalid");
    }
    if (!job.outputContract.kinds.includes(input.kind)) throw new Error("Output kind is not allowed by the leased job");
    const extension = input.kind === "BUILD" || input.kind === "SIGNED_BUILD"
      ? ".tar.gz"
      : input.kind === "E2E_REPORT" ? ".zip" : ".json";
    const platform = input.targetPlatform ? `-${input.targetPlatform}` : "";
    const filename = `${input.kind.toLowerCase().replaceAll("_", "-")}${platform}-${input.sha256.slice(7, 23)}${extension}`;
    const key = `workspaces/${job.workspaceId}/projects/${job.projectId}/jobs/${job.jobId}/${filename}`;
    const url = await getSignedUrl(this.publicClient, new PutObjectCommand({
      Bucket: this.bucket,
      Key: key,
      ContentLength: input.sizeBytes,
      Metadata: { sha256: input.sha256 },
    }), { expiresIn: 120 });
    return Object.freeze({
      uploadUrl: url,
      expiresAt: new Date(Date.now() + 120_000).toISOString(),
      object: Object.freeze({ kind: input.kind, ...(input.targetPlatform ? { targetPlatform: input.targetPlatform } : {}), bucket: this.bucket, key, sha256: input.sha256, sizeBytes: input.sizeBytes }),
      requiredHeaders: outputUploadRequiredHeaders(input.sizeBytes),
    });
  }

  async verifyOutputs(job: JobProtocolV4, objects: readonly JobProtocolV4["inputObjects"][number][]): Promise<void> {
    if (objects.length < 1) throw new Error("Executor did not produce an output object");
    let total = 0;
    for (const object of objects) {
      if (object.bucket !== this.bucket
        || !object.key.startsWith(`workspaces/${job.workspaceId}/projects/${job.projectId}/jobs/${job.jobId}/`)) {
        throw new Error("Executor output escaped the leased object boundary");
      }
      const head = await this.client.send(new HeadObjectCommand({ Bucket: object.bucket, Key: object.key }));
      if (head.ContentLength !== object.sizeBytes || head.Metadata?.sha256 !== object.sha256) {
        throw new Error("Executor output object digest or size does not match storage metadata");
      }
      total += object.sizeBytes;
    }
    if (total > job.outputContract.maxBytes) throw new Error("Executor outputs exceed the leased output budget");
  }

  async readProjectDocument(
    job: JobProtocolV4,
    objects: readonly JobProtocolV4["inputObjects"][number][],
  ) {
    const parsed = await this.readJsonOutput(objects, "PROJECT_DOCUMENT", 131_072, "Project document");
    if (parsed.schemaVersion !== "deviludo.project-document.v1") {
      throw new Error("Project document output schema is invalid");
    }
    const content = parseProjectDocumentContent(parsed.content);
    const projectName = typeof job.payload.projectName === "string" ? job.payload.projectName : "游戏项目";
    return Object.freeze({
      content,
      markdown: projectDocumentMarkdown(projectName, content, parseResponseLanguage(job.payload.responseLanguage)),
    });
  }

  /**
   * Read the generated project's agent.json back from the verified output
   * object. The executor receipt contains object metadata only; without this
   * read the assetManifest never reaches complete_job and no image work can be
   * planned even though the Agent wrote it successfully.
   */
  async readAgentCompletion(
    objects: readonly JobProtocolV4["inputObjects"][number][],
  ): Promise<Readonly<{ assetManifest: unknown }>> {
    const parsed = await this.readJsonOutput(objects, "SPECIFICATION", 2 * 1024 * 1024, "Agent manifest");
    if (!("assetManifest" in parsed) || Object.hasOwn(parsed, "testManifest")) {
      throw new Error("Agent output must contain an asset manifest and leave test planning to E2E");
    }
    return Object.freeze({ assetManifest: parsed.assetManifest });
  }

  async readProjectE2eContractHint(object: ObjectReference | null): Promise<Readonly<Record<string, unknown>> | null> {
    if (!object) return null;
    if (object.kind !== "SPECIFICATION" || object.bucket !== this.bucket
      || !object.key.startsWith("workspaces/") || object.sizeBytes > 2 * 1024 * 1024) {
      throw new Error("Project E2E contract hint object is invalid");
    }
    const parsed = await this.readJsonOutput([object], "SPECIFICATION", 2 * 1024 * 1024, "Agent manifest");
    const hint = parsed.testManifest;
    return hint && typeof hint === "object" && !Array.isArray(hint)
      ? Object.freeze(hint as Record<string, unknown>)
      : null;
  }

  async readProjectE2eRegressionTrace(object: ObjectReference | null): Promise<Readonly<Record<string, unknown>> | null> {
    if (!object) return null;
    if (object.kind !== "E2E_REGRESSION" || object.bucket !== this.bucket
      || !object.key.startsWith("workspaces/") || object.sizeBytes > 2 * 1024 * 1024) {
      throw new Error("Project E2E regression trace object is invalid");
    }
    const parsed = await this.readJsonOutput([object], "E2E_REGRESSION", 2 * 1024 * 1024, "E2E regression trace");
    if (parsed.schema !== "deviludo.e2e-regression"
      || !Array.isArray(parsed.actions) || !Array.isArray(parsed.successAssertions)) {
      throw new Error("Project E2E regression trace schema is invalid");
    }
    return Object.freeze(parsed);
  }

  private async readJsonOutput(
    objects: readonly JobProtocolV4["inputObjects"][number][],
    kind: string,
    maximumBytes: number,
    label: string,
  ): Promise<Record<string, unknown>> {
    const matches = objects.filter(object => object.kind === kind);
    if (matches.length !== 1) throw new Error(`Executor must produce exactly one ${label.toLowerCase()}`);
    const object = matches[0];
    if (object.sizeBytes > maximumBytes) throw new Error(`${label} output is too large`);
    const result = await this.client.send(new GetObjectCommand({ Bucket: object.bucket, Key: object.key }));
    if (!result.Body) throw new Error(`${label} output body is missing`);
    const bytes = Buffer.from(await result.Body.transformToByteArray());
    if (bytes.length !== object.sizeBytes
      || `sha256:${createHash("sha256").update(bytes).digest("hex")}` !== object.sha256) {
      throw new Error(`${label} output digest or size is invalid`);
    }
    let parsed: unknown;
    try {
      parsed = JSON.parse(bytes.toString("utf8"));
    } catch {
      throw new Error(`${label} output is not valid JSON`);
    }
    if (!parsed || typeof parsed !== "object" || Array.isArray(parsed)) {
      throw new Error(`${label} output schema is invalid`);
    }
    return parsed as Record<string, unknown>;
  }

}

function isSafeAssetKey(value: string): boolean {
  return /^[A-Za-z0-9][A-Za-z0-9._/-]{0,199}$/.test(value)
    && !/(^|\/)\.{1,2}(\/|$)|\/\//.test(value)
    && !value.endsWith("/");
}

export function isValidOutputAuthorizationInput(
  input: Readonly<{ kind: string; sha256: string; sizeBytes: number }>,
  maxBytes: number,
): boolean {
  return /^[A-Z][A-Z0-9_]{1,63}$/.test(input.kind)
    && /^sha256:[0-9a-f]{64}$/.test(input.sha256)
    && Number.isSafeInteger(input.sizeBytes)
    && input.sizeBytes >= 1
    && input.sizeBytes <= maxBytes;
}

export function outputUploadRequiredHeaders(sizeBytes: number): Readonly<Record<string, string>> {
  // The AWS presigner hoists x-amz-meta-sha256 into the signed query string.
  // Repeating it as an unsigned HTTP header makes MinIO reject the request.
  return Object.freeze({ "content-length": String(sizeBytes) });
}
