import assert from "node:assert/strict";
import { createHash } from "node:crypto";
import test from "node:test";
import {
  S3SteamDepotArtifactStore,
  type SteamDepotS3HttpRequest,
  type SteamDepotS3HttpResponse,
} from "../src/s3-artifact-store";

const ca = Buffer.from("-----BEGIN CERTIFICATE-----\ntrusted-test-ca-material\n-----END CERTIFICATE-----\n");
const body = Buffer.from("signed-depot-bytes");
const artifactDigest = createHash("sha256").update(body).digest("hex");
const objectKey = `tenants/11111111-1111-4111-8111-111111111111/projects/22222222-2222-4222-8222-222222222222/steam-releases/33333333-3333-4333-8333-333333333333/linux/artifact/${artifactDigest}`;
const checksum = Buffer.from(artifactDigest, "hex").toString("base64");

function response(statusCode: number, responseBody = Buffer.alloc(0), headers: SteamDepotS3HttpResponse["headers"] = {}) {
  return Object.freeze({ statusCode, body: responseBody, headers });
}

function store(http: (url: URL, input: SteamDepotS3HttpRequest) => Promise<SteamDepotS3HttpResponse>) {
  return new S3SteamDepotArtifactStore({
    endpoint: "https://s3.release.internal:9000/",
    bucket: "deviludo-release-evidence",
    region: "us-east-1",
    accessKeyId: "DEVILUDORELEASE01",
    secretAccessKey: Buffer.from("test-only-secret-access-key"),
    ca,
    now: () => new Date("2030-01-02T03:04:05.000Z"),
    http,
  });
}

test("Steam depot S3 downloads only an exact checksum-bound content address", async () => {
  let observed: Readonly<{ url: URL; request: SteamDepotS3HttpRequest }> | undefined;
  const artifacts = store(async (url, request) => {
    observed = { url, request };
    return response(200, body, {
      "content-length": String(body.byteLength),
      "x-amz-checksum-sha256": checksum,
      "x-amz-meta-deviludo-sha256": artifactDigest,
    });
  });
  assert.deepEqual(await artifacts.download({ objectKey, artifactDigest, maximumBytes: 1024 }), body);
  assert.equal(observed!.url.href, `https://s3.release.internal:9000/deviludo-release-evidence/${objectKey}`);
  assert.equal(observed!.request.method, "GET");
  assert.equal(observed!.request.headers["x-amz-checksum-mode"], "ENABLED");
  assert.match(observed!.request.headers.authorization!, /^AWS4-HMAC-SHA256 Credential=DEVILUDORELEASE01\/20300102\/us-east-1\/s3\/aws4_request/);
  assert.equal(observed!.request.headers.authorization!.includes("test-only-secret"), false);

  const drift = store(async () => response(200, body, {
    "content-length": String(body.byteLength),
    "x-amz-checksum-sha256": Buffer.from("0".repeat(64), "hex").toString("base64"),
    "x-amz-meta-deviludo-sha256": artifactDigest,
  }));
  await assert.rejects(drift.download({ objectKey, artifactDigest, maximumBytes: 1024 }), /download is invalid/);
});

test("Steam depot S3 writes once and accepts a replay only after byte verification", async () => {
  const calls: SteamDepotS3HttpRequest[] = [];
  const artifacts = store(async (_url, request) => {
    calls.push(request);
    if (request.method === "PUT") return response(412);
    return response(200, body, {
      "content-length": String(body.byteLength),
      "x-amz-checksum-sha256": checksum,
      "x-amz-meta-deviludo-sha256": artifactDigest,
    });
  });
  await artifacts.putImmutable({ objectKey, artifactDigest, contentType: "application/octet-stream", body });
  assert.deepEqual(calls.map((call) => call.method), ["PUT", "GET"]);
  assert.equal(calls[0]!.headers["if-none-match"], "*");
  assert.equal(calls[0]!.headers["x-amz-checksum-sha256"], checksum);

  const conflict = store(async (_url, request) => request.method === "PUT" ? response(409) : response(200, Buffer.from("changed"), {
    "content-length": "7",
    "x-amz-checksum-sha256": checksum,
    "x-amz-meta-deviludo-sha256": artifactDigest,
  }));
  await assert.rejects(conflict.putImmutable({
    objectKey, artifactDigest, contentType: "application/octet-stream", body,
  }), /download is invalid/);
});

test("Steam depot S3 readiness is bucket-scoped and configuration rejects unsafe endpoints", async () => {
  let observedPath = "";
  const artifacts = store(async (url, request) => {
    observedPath = url.pathname;
    assert.equal(request.method, "HEAD");
    return response(200);
  });
  await artifacts.probe();
  assert.equal(observedPath, "/deviludo-release-evidence");

  for (const endpoint of [
    "http://s3.release.internal/",
    "https://user@s3.release.internal/",
    "https://s3.release.internal/prefix",
    "https://s3.release.internal/?token=x",
    "https://s3.release.internal:9443/",
  ]) {
    assert.throws(() => new S3SteamDepotArtifactStore({
      endpoint,
      bucket: "deviludo-release-evidence",
      region: "us-east-1",
      accessKeyId: "DEVILUDORELEASE01",
      secretAccessKey: Buffer.from("test-only-secret-access-key"),
      ca,
    }), /configuration is invalid/);
  }
});
