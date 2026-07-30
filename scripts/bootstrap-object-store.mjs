import { CreateBucketCommand, HeadBucketCommand, S3Client } from "@aws-sdk/client-s3";

const bucket = process.env.DEVILUDO_ARTIFACT_BUCKET ?? "";
if (!/^[a-z0-9][a-z0-9.-]{1,61}[a-z0-9]$/.test(bucket)) throw new Error("Artifact bucket name is invalid");
const client = new S3Client({
  region: process.env.DEVILUDO_S3_REGION ?? "us-east-1", endpoint: process.env.DEVILUDO_S3_ENDPOINT,
  forcePathStyle: process.env.DEVILUDO_S3_PATH_STYLE === "1",
});
try { await client.send(new HeadBucketCommand({ Bucket: bucket })); }
catch (error) {
  if (process.env.DEVILUDO_S3_CREATE_BUCKET !== "1") throw new Error("Artifact bucket is unavailable and automatic creation is disabled", { cause: error });
  await client.send(new CreateBucketCommand({ Bucket: bucket }));
  await client.send(new HeadBucketCommand({ Bucket: bucket }));
}
console.log(JSON.stringify({ initialized: true, bucket }));
