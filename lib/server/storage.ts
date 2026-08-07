// Server-side storage utilities for uploading assets

import { PutObjectCommand, S3Client } from "@aws-sdk/client-s3";
import { createHash } from "node:crypto";

let _client: S3Client | null = null;
let _bucket: string | null = null;

function getStorageClient() {
  if (!_client) {
    const env = process.env;
    _bucket = env.DEVILUDO_ARTIFACT_BUCKET ?? "";
    if (!_bucket) throw new Error("DEVILUDO_ARTIFACT_BUCKET is required");

    _client = new S3Client({
      region: env.DEVILUDO_S3_REGION ?? "us-east-1",
      endpoint: env.DEVILUDO_S3_ENDPOINT,
      forcePathStyle: env.DEVILUDO_S3_PATH_STYLE === "1",
      credentials: env.DEVILUDO_S3_ACCESS_KEY_ID && env.DEVILUDO_S3_SECRET_ACCESS_KEY
        ? { accessKeyId: env.DEVILUDO_S3_ACCESS_KEY_ID, secretAccessKey: env.DEVILUDO_S3_SECRET_ACCESS_KEY }
        : undefined,
    });
  }
  return { client: _client, bucket: _bucket! };
}

export async function uploadObject(
  key: string,
  body: Buffer,
  contentType: string = "application/octet-stream"
): Promise<{ sha256: string; sizeBytes: number }> {
  const { client, bucket } = getStorageClient();

  const sha256 = `sha256:${createHash("sha256").update(body).digest("hex")}`;
  const sizeBytes = body.length;

  await client.send(new PutObjectCommand({
    Bucket: bucket,
    Key: key,
    Body: body,
    ContentType: contentType,
    Metadata: { sha256 },
  }));

  return { sha256, sizeBytes };
}
