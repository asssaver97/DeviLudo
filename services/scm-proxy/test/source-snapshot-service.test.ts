import assert from "node:assert/strict";
import { createHash } from "node:crypto";
import { mkdtemp, readFile, realpath, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import test from "node:test";
import type { RunnerArtifactTransfer } from "../../evidence-archive/src/runner-artifacts";
import type { TestKitArtifactTransferHttp } from "../../runner-control/src/testkit-artifact-client";
import type { GitHubRepositoryBinding, GitHubSourceTreeConnector } from "../src/github-contracts";
import { GitHubSourceMaterializer } from "../src/github-source-materializer";
import { SourceSnapshotGrantService } from "../src/source-snapshot-service";

const tenantId = "11111111-1111-4111-8111-111111111111";
const projectId = "22222222-2222-4222-8222-222222222222";
const runId = "33333333-3333-4333-8333-333333333333";
const commitSha = "a".repeat(40);
const sourceDigest = "b".repeat(64);
const identity = {
  spiffeId: "spiffe://deviludo.internal/artifact-preparer",
  certificateFingerprint: "c".repeat(64),
  certificateSerial: "01",
  certificateNotAfter: "2030-01-02T00:00:00.000Z",
};
const binding: GitHubRepositoryBinding = {
  tenantId,
  projectId,
  installationId: "123456",
  repositoryId: 991,
  repositoryNodeId: "R_repo991",
  owner: "north-dock-studio",
  name: "ember-archipelago",
  defaultBranch: "main",
};

test("SCM source service builds, uploads, verifies and grants one authoritative snapshot", async () => {
  const fixture = await serviceFixture();
  try {
    const response = await fixture.service.grant(identity, request());
    assert.equal(response.schemaVersion, "deviludo.source-snapshot-grant.v1");
    assert.equal(response.sourceDigest, sourceDigest);
    assert.equal(response.method, "GET");
    assert.match(String(response.objectKey), new RegExp(`^tenants/${tenantId}/projects/${projectId}/scm-snapshots/${commitSha}/${sourceDigest}/[a-f0-9]{64}\\.tar\\.zst$`));
    assert.equal(fixture.uploads, 1);
    assert.equal(fixture.verified, 1);
    assert.equal(JSON.stringify(response).includes("ghs_"), false);
    await fixture.service.probe();
  } finally { await fixture.close(); }
});

test("SCM source service rejects tenant, authority and upload drift before returning a grant", async () => {
  const forbidden = await serviceFixture({ forbidden: true });
  try { await assert.rejects(forbidden.service.grant(identity, request()), /tenant forbidden/); }
  finally { await forbidden.close(); }

  const authority = await serviceFixture({ authorityDigest: "f".repeat(64) });
  try { await assert.rejects(authority.service.grant(identity, request()), /authority receipt/); }
  finally { await authority.close(); }

  const upload = await serviceFixture({ uploadStatus: 500 });
  try { await assert.rejects(upload.service.grant(identity, request()), /upload/); }
  finally { await upload.close(); }

  const fields = await serviceFixture();
  try { await assert.rejects(fields.service.grant(identity, { ...request(), objectKey: "attacker" }), /request fields/); }
  finally { await fields.close(); }
});

test("SCM source service issues the download grant from the post-upload clock", async () => {
  let clockReads = 0;
  const fixture = await serviceFixture({
    now: () => new Date(clockReads++ === 0 ? "2030-01-01T00:00:00.000Z" : "2030-01-01T00:10:00.000Z"),
  });
  try {
    const response = await fixture.service.grant(identity, request());
    assert.equal(response.expiresAt, "2030-01-01T00:15:00.000Z");
  } finally { await fixture.close(); }
});

function request() {
  return {
    schemaVersion: "deviludo.source-snapshot-grant-request.v1",
    tenantId,
    projectId,
    runId,
    mode: "CANDIDATE",
    commitSha,
    sourceDigest,
  };
}

async function serviceFixture(options: {
  readonly forbidden?: boolean;
  readonly authorityDigest?: string;
  readonly uploadStatus?: number;
  readonly now?: () => Date;
} = {}) {
  const root = await realpath(await mkdtemp(join(tmpdir(), "deviludo-source-service-")));
  const project = Buffer.from('config_version=5\n[application]\nconfig/name="Snapshot"\n');
  const script = Buffer.from("extends Node\n");
  const projectSha = gitBlobSha(project);
  const scriptSha = gitBlobSha(script);
  const connector: GitHubSourceTreeConnector = {
    async getSourceTree() {
      return {
        commitSha,
        treeSha: "d".repeat(40),
        sourceDigest,
        entries: [
          { path: "project.godot", mode: "100644", type: "blob", sha: projectSha },
          { path: "scripts/main.gd", mode: "100644", type: "blob", sha: scriptSha },
        ],
      };
    },
    async getBlob(_binding, sha) {
      if (sha === projectSha) return project;
      if (sha === scriptSha) return script;
      throw new Error("unknown blob");
    },
  };
  let uploads = 0;
  let verified = 0;
  const stored = new Map<string, { digest: string; size: number }>();
  const transfer: RunnerArtifactTransfer = {
    async probe() {},
    async createUploadGrant(input) {
      return {
        method: "PUT",
        url: `https://s3.internal/bucket/${input.objectKey}?signature=upload`,
        requiredHeaders: {
          "content-length": String(input.sizeBytes),
          "content-type": input.contentType,
          "if-none-match": "*",
          "x-amz-checksum-sha256": Buffer.from(input.artifactDigest, "hex").toString("base64"),
          "x-amz-meta-deviludo-sha256": input.artifactDigest,
        },
        expiresAt: input.expiresAt,
      };
    },
    async createDownloadGrant(input) {
      return {
        method: "GET",
        url: `https://s3.internal/bucket/${input.objectKey}?signature=download`,
        requiredHeaders: {},
        expiresAt: input.expiresAt,
      };
    },
    async verifyObject(input) {
      verified += 1;
      const value = stored.get(input.objectKey);
      if (!value || value.digest !== input.artifactDigest || value.size !== input.sizeBytes) throw new Error("not stored");
      return { sizeBytes: value.size };
    },
  };
  const transferHttp: TestKitArtifactTransferHttp = {
    async download() { throw new Error("not supported"); },
    async upload(input) {
      uploads += 1;
      const bytes = await readFile(input.sourcePath);
      const objectKey = decodeURIComponent(input.url.pathname.slice("/bucket/".length));
      stored.set(objectKey, { digest: createHash("sha256").update(bytes).digest("hex"), size: bytes.byteLength });
      return { statusCode: options.uploadStatus ?? 200 };
    },
  };
  return {
    service: new SourceSnapshotGrantService({
      tenants: {
        async authorize(_identity, tenant) {
          if (options.forbidden || tenant !== tenantId) throw new Error("tenant forbidden");
        },
        async probe() {},
      },
      authority: {
        async resolve() { return { binding, sourceDigest: options.authorityDigest ?? sourceDigest }; },
        async probe() {},
      },
      materializer: new GitHubSourceMaterializer(connector),
      transfer,
      transferCa: Buffer.alloc(32),
      allowedTransferOrigins: ["https://s3.internal"],
      workRoot: join(root, "work"),
      transferHttp,
      now: options.now ?? (() => new Date("2030-01-01T00:00:00.000Z")),
    }),
    get uploads() { return uploads; },
    get verified() { return verified; },
    close: () => rm(root, { recursive: true, force: true }),
  };
}

function gitBlobSha(content: Buffer): string {
  return createHash("sha1").update(`blob ${content.byteLength}\0`).update(content).digest("hex");
}
