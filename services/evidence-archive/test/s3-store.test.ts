import assert from "node:assert/strict";
import { createHash } from "node:crypto";
import { test } from "node:test";
import { S3ImmutableObjectStore, type S3HttpRequest, type S3HttpResponse } from "../src/s3-store";

const ca = Buffer.from("-----BEGIN CERTIFICATE-----\ntrusted-test-ca-material\n-----END CERTIFICATE-----\n");
const body = Buffer.from("{\"bundle\":true}\n");
const digest = createHash("sha256").update(body).digest("hex");
const objectKey = "tenants/one/projects/two/evidence/bundle.json";

function response(statusCode: number, headers: S3HttpResponse["headers"] = {}, responseBody = Buffer.alloc(0)): S3HttpResponse {
  return Object.freeze({ statusCode, headers, body: responseBody });
}

function store(http: (url: URL, input: S3HttpRequest) => Promise<S3HttpResponse>) {
  return new S3ImmutableObjectStore({
    endpoint: "https://s3.internal:9000",
    bucket: "deviludo-evidence",
    region: "us-east-1",
    accessKeyId: "DEVILUDOACCESS01",
    secretAccessKey: Buffer.from("super-secret-test-key-material"),
    ca,
    now: () => new Date("2030-01-02T03:04:05.000Z"),
    http,
  });
}

test("S3 backend signs an exact conditional PUT and never follows an alternate destination", async () => {
  let observed: { url: URL; input: S3HttpRequest } | undefined;
  const backend = store(async (url, input) => {
    observed = { url, input };
    return response(200);
  });
  assert.equal((await backend.putImmutable({ objectKey, contentType: "application/json", contentDigest: digest, body })).created, true);
  assert.equal(observed!.url.href, `https://s3.internal:9000/deviludo-evidence/${objectKey}`);
  assert.equal(observed!.input.method, "PUT");
  assert.equal(observed!.input.headers["if-none-match"], "*");
  assert.equal(observed!.input.headers["x-amz-content-sha256"], digest);
  assert.match(observed!.input.headers.authorization!, /^AWS4-HMAC-SHA256 Credential=DEVILUDOACCESS01\/20300102\/us-east-1\/s3\/aws4_request/);
  assert.equal(observed!.input.headers.authorization!.includes("super-secret"), false);
});

test("S3 backend accepts an existing object only after an authenticated metadata match", async () => {
  const calls: Array<{ url: URL; input: S3HttpRequest }> = [];
  const backend = store(async (url, input) => {
    calls.push({ url, input });
    return input.method === "PUT"
      ? response(412)
      : response(200, { "x-amz-meta-deviludo-sha256": digest, "content-length": String(body.byteLength) }, body);
  });
  assert.equal((await backend.putImmutable({ objectKey, contentType: "application/json", contentDigest: digest, body })).created, false);
  assert.deepEqual(calls.map((call) => call.input.method), ["PUT", "GET"]);

  const conflict = store(async (_url, input) => input.method === "PUT"
    ? response(412)
    : response(200, { "x-amz-meta-deviludo-sha256": "0".repeat(64), "content-length": String(body.byteLength) }, body));
  await assert.rejects(conflict.putImmutable({ objectKey, contentType: "application/json", contentDigest: digest, body }), /conflicts/);
});

test("S3 readiness signs a bucket HEAD and rejects unsafe endpoints or credentials", async () => {
  let path = "";
  const backend = store(async (url, input) => {
    path = url.pathname;
    assert.equal(input.method, "HEAD");
    assert.match(input.headers.authorization!, /^AWS4-HMAC-SHA256/);
    return response(200);
  });
  await backend.probe();
  assert.equal(path, "/deviludo-evidence");
  for (const endpoint of ["http://s3.internal", "https://user@s3.internal", "https://s3.internal/prefix", "https://s3.internal?secret=x"]) {
    assert.throws(() => new S3ImmutableObjectStore({
      endpoint,
      bucket: "deviludo-evidence",
      region: "us-east-1",
      accessKeyId: "DEVILUDOACCESS01",
      secretAccessKey: Buffer.from("super-secret-test-key-material"),
      ca,
    }), /configuration/);
  }
});

test("S3 Runner grants are short-lived, checksum-bound and contain no secret key", async () => {
  const backend = store(async () => response(500));
  const expiresAt = "2030-01-02T03:09:05.000Z";
  const download = await backend.createDownloadGrant({ objectKey, artifactDigest: digest, expiresAt });
  const downloadUrl = new URL(download.url);
  assert.equal(download.method, "GET");
  assert.equal(downloadUrl.searchParams.get("X-Amz-Expires"), "300");
  assert.equal(downloadUrl.searchParams.get("X-Amz-Algorithm"), "AWS4-HMAC-SHA256");
  assert.equal(download.url.includes("super-secret-test-key-material"), false);

  const upload = await backend.createUploadGrant({
    objectKey,
    artifactDigest: digest,
    sizeBytes: body.byteLength,
    contentType: "application/json",
    expiresAt,
  });
  assert.equal(upload.method, "PUT");
  assert.equal(upload.requiredHeaders["if-none-match"], "*");
  assert.equal(upload.requiredHeaders["content-length"], String(body.byteLength));
  assert.equal(upload.requiredHeaders["x-amz-checksum-sha256"], Buffer.from(digest, "hex").toString("base64"));
  assert.match(new URL(upload.url).searchParams.get("X-Amz-SignedHeaders") ?? "", /x-amz-checksum-sha256/);
});

test("S3 Runner commit verifies server checksum, metadata and exact size", async () => {
  const checksum = Buffer.from(digest, "hex").toString("base64");
  let observed: S3HttpRequest | undefined;
  const backend = store(async (_url, input) => {
    observed = input;
    return response(200, {
      "content-length": String(body.byteLength),
      "x-amz-meta-deviludo-sha256": digest,
      "x-amz-checksum-sha256": checksum,
    });
  });
  assert.deepEqual(await backend.verifyObject({ objectKey, artifactDigest: digest, sizeBytes: body.byteLength }), { sizeBytes: body.byteLength });
  assert.equal(observed!.method, "HEAD");
  assert.equal(observed!.headers["x-amz-checksum-mode"], "ENABLED");

  const corrupt = store(async () => response(200, {
    "content-length": String(body.byteLength),
    "x-amz-meta-deviludo-sha256": digest,
    "x-amz-checksum-sha256": Buffer.from("0".repeat(64), "hex").toString("base64"),
  }));
  await assert.rejects(corrupt.verifyObject({ objectKey, artifactDigest: digest, sizeBytes: body.byteLength }), /verification failed/);
});
