import assert from "node:assert/strict";
import { createHash } from "node:crypto";
import { chmod, mkdtemp, mkdir, readFile, rm, writeFile } from "node:fs/promises";
import { join } from "node:path";
import { tmpdir } from "node:os";
import test from "node:test";
import type { SteamBuildSession, SteamRcArtifactClaims } from "../src/contracts";
import {
  LockedNativeSteamPublisherConnector,
  type NativeSteamPublisherProcess,
} from "../src/locked-native-publisher";

const tenantId = "11111111-1111-4111-8111-111111111111";
const projectId = "22222222-2222-4222-8222-222222222222";
const releaseId = "33333333-3333-4333-8333-333333333333";
const buildReceiptId = "44444444-4444-4444-8444-444444444444";
const requestDigest = "a".repeat(64);
const steamAppId = "2841930";
const buildId = "91234567";
const session: SteamBuildSession = Object.freeze({
  id: "steam-session-001", tenantId, accountId: "build-account-001", accountName: "deviludo_build",
  configVdfSecretRef: "vault://steam/config-vdf/versions/3", credentialVersionId: buildReceiptId,
  allowedAppIds: Object.freeze([steamAppId]),
  permissions: Object.freeze(["EditAppMetadata", "PublishAppChanges"] as const),
  state: "ACTIVE", verifiedAt: "2030-01-01T00:00:00.000Z", expiresAt: "2030-02-01T00:00:00.000Z",
});
const rc: SteamRcArtifactClaims = Object.freeze({
  kind: "deviludo-steam-rc", version: 1, tenantId, projectId, releaseId,
  mainCommitSha: "b".repeat(40), sourceDigest: "c".repeat(64),
  specRevisionId: "55555555-5555-4555-8555-555555555555",
  specDigest: "d".repeat(64), testPlanDigest: "e".repeat(64), evidenceBundleDigest: "f".repeat(64),
  steamAppId, targetMatrix: Object.freeze(["linux"] as const),
  depots: Object.freeze([{ depotId: "2841931", platform: "linux" as const,
    objectRef: "s3://evidence/tenants/release/linux.tar", artifactDigest: "1".repeat(64), sizeBytes: 1024 }]),
  issuedAt: "2030-01-01T00:00:00.000Z", expiresAt: "2030-01-01T01:00:00.000Z",
});

async function fixture(process: NativeSteamPublisherProcess) {
  const root = await mkdtemp(join(tmpdir(), "deviludo-native-publisher-"));
  const executable = join(root, "publisher");
  const configFile = join(root, "config.json");
  const workRoot = join(root, "work");
  await Promise.all([
    writeFile(executable, "fixed-native-publisher", { mode: 0o500 }),
    writeFile(configFile, "{\"vaultSocket\":\"fixed\"}", { mode: 0o400 }),
    mkdir(workRoot, { mode: 0o700 }),
  ]);
  const executableDigest = await digest(executable);
  const configDigest = await digest(configFile);
  return {
    root,
    configDigest,
    connector: new LockedNativeSteamPublisherConnector({
      executable, executableDigest, configFile, configDigest, workRoot, process,
    }),
  };
}

test("locked native Steam publisher pins artifacts, argv and exact private/default receipts", async () => {
  const calls: Array<{ args: readonly string[]; env: NodeJS.ProcessEnv }> = [];
  let configDigest = "";
  const process: NativeSteamPublisherProcess = async (_executable, args, options) => {
    calls.push({ args, env: options.env });
    if (args[0] === "probe") return { exitCode: 0, stderr: "", stdout: JSON.stringify({
      schemaVersion: "deviludo.native-steam-publisher-probe.v1", status: "READY", configDigest,
    }) };
    const requestPath = String(args[args.indexOf("--request-file") + 1]);
    const responsePath = String(args[args.indexOf("--response-file") + 1]);
    const request = JSON.parse(await readFile(requestPath, "utf8")) as Record<string, unknown>;
    assert.equal("password" in request, false);
    assert.equal("guardCode" in request, false);
    if (args[0] === "upload-private-beta") {
      assert.equal(request.schemaVersion, "deviludo.native-steam-private-beta-request.v1");
      await writeFile(responsePath, JSON.stringify({
        schemaVersion: "deviludo.native-steam-private-beta-receipt.v1",
        steamAppId, buildId, betaBranch: "private_beta", passwordProtected: true,
        depotManifestIds: { "2841931": "81234567" }, uploadedAt: "2030-01-01T00:02:00.000Z",
      }), { flag: "wx", mode: 0o400 });
    } else {
      assert.equal(args[0], "publish-default-branch");
      assert.equal(request.schemaVersion, "deviludo.native-steam-default-branch-request.v1");
      await writeFile(responsePath, JSON.stringify({
        schemaVersion: "deviludo.native-steam-default-branch-receipt.v1",
        releaseId, steamAppId, betaBuildId: buildId, defaultBranchBuildId: buildId,
        publishedAt: "2030-01-02T00:00:00.000Z",
      }), { flag: "wx", mode: 0o400 });
    }
    return { exitCode: 0, stdout: "", stderr: "" };
  };
  const value = await fixture(process);
  configDigest = value.configDigest;
  try {
    await value.connector.probe();
    const upload = await value.connector.uploadPrivateBeta({
      operationKey: "steam-private-beta:operation-001", requestDigest, rc, session,
      betaBranch: "private_beta", branchPasswordSecretRef: "vault://steam/beta/versions/7",
    });
    assert.equal(upload.buildId, buildId);
    assert.deepEqual(upload.depotManifestIds, { "2841931": "81234567" });
    const replay = await value.connector.uploadPrivateBeta({
      operationKey: "steam-private-beta:operation-001", requestDigest, rc, session,
      betaBranch: "private_beta", branchPasswordSecretRef: "vault://steam/beta/versions/7",
    });
    assert.deepEqual(replay, upload);
    const published = await value.connector.promote({
      operationKey: "workflow-job:66666666-6666-4666-8666-666666666666", requestDigest,
      tenantId, projectId, releaseId, steamAppId, betaBuildId: buildId, buildReceiptId,
      steamInstallEvidenceBundleDigest: "2".repeat(64), session,
      externalApprovalIds: ["valve-1", "first-1", "default-1"],
    });
    assert.equal(published.defaultBranchBuildId, buildId);
    assert.equal(calls.filter((call) => call.args[0] === "upload-private-beta").length, 1);
    assert.deepEqual(calls.at(-1)?.args.slice(0, 3), ["publish-default-branch", "--config-file", join(value.root, "config.json")]);
    assert.equal(Object.keys(calls.at(-1)?.env ?? {}).includes("PATH"), false);
    assert.doesNotMatch(JSON.stringify(calls), /config-vdf|beta\/versions|steam.?guard/i);
  } finally { await rm(value.root, { recursive: true, force: true }); }
});

test("locked native Steam publisher fails before execution on artifact drift and rejects credential output", async () => {
  let calls = 0;
  const value = await fixture(async () => {
    calls += 1;
    return { exitCode: 0, stdout: "config.vdf leaked", stderr: "" };
  });
  try {
    await assert.rejects(value.connector.probe(), /probe is invalid/);
    assert.equal(calls, 1);
    await chmod(join(value.root, "config.json"), 0o600);
    await writeFile(join(value.root, "config.json"), "tampered");
    await assert.rejects(value.connector.uploadPrivateBeta({
      operationKey: "steam-private-beta:operation-001", requestDigest, rc, session,
      betaBranch: "private_beta", branchPasswordSecretRef: "vault://steam/beta/versions/7",
    }), /runtime file digest is invalid/);
    assert.equal(calls, 1);
  } finally { await rm(value.root, { recursive: true, force: true }); }
});

async function digest(path: string): Promise<string> {
  return createHash("sha256").update(await readFile(path)).digest("hex");
}
