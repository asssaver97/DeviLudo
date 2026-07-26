import assert from "node:assert/strict";
import { createHash } from "node:crypto";
import { chmod, mkdir, mkdtemp, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import test from "node:test";
import { steamCanonicalDigest } from "../../steam-publisher/src/artifacts";
import type { SteamTargetPlatform } from "../../steam-publisher/src/contracts";
import { parseSteamDepotFinalizationRequest } from "../src/contract";
import {
  LockedSteamDepotPlatformSigner,
  type SteamDepotNativeToolProcess,
} from "../src/locked-platform-signer";
import {
  parseSteamDepotNativePolicy,
  signingSchemeForPlatform,
  steamDepotNativePolicyDigest,
  steamDepotSigningIdentityDigest,
  type SteamDepotNativePolicy,
} from "../src/native-policy";

const tenantId = "11111111-1111-4111-8111-111111111111";
const projectId = "22222222-2222-4222-8222-222222222222";
const releaseId = "33333333-3333-4333-8333-333333333333";

test("locked platform signer fixes native argv and emits request-bound evidence for every desktop OS", async () => {
  for (const platform of ["windows", "linux", "macos"] as const) {
    const root = await mkdtemp(join(tmpdir(), `deviludo-platform-signer-${platform}-`));
    const toolsRoot = join(root, "tools"); const exportRoot = join(root, "export");
    await Promise.all([mkdir(toolsRoot), mkdir(exportRoot)]);
    const policy = await policyFixture(root, platform);
    const request = finalizationRequest(platform);
    const target = await targetFixture(exportRoot, platform);
    const calls: Array<Readonly<{ executable: string; args: readonly string[]; env: NodeJS.ProcessEnv }>> = [];
    const process: SteamDepotNativeToolProcess = async (executable, args, options) => {
      calls.push({ executable, args, env: options.env });
      if (platform === "linux" && args[0] === "sign-blob") {
        await writeFile(args[args.indexOf("--bundle") + 1]!, JSON.stringify({ verificationMaterial: "public" }));
      }
      if (platform === "macos" && args[0] === "notarytool") return {
        exitCode: 0,
        stdout: JSON.stringify({ id: "44444444-4444-4444-8444-444444444444", status: "Accepted", message: "Package Approved" }),
        stderr: "",
      };
      return { exitCode: 0, stdout: `${platform}-verified`, stderr: "" };
    };
    const signer = new LockedSteamDepotPlatformSigner({ policy, process, hostPlatform: "aix" });
    await signer.probe();
    const result = await signer.sign({ request, exportRoot, signingTarget: target });
    assert.equal(result.signingIdentityDigest, steamDepotSigningIdentityDigest(policy.signer));
    const signing = JSON.parse(result.signingEvidence.toString("utf8"));
    assert.equal(signing.requestDigest, request.requestDigest);
    assert.equal(signing.platform, platform);
    assert.equal(signing.signingScheme, signingSchemeForPlatform(platform));
    assert.equal(signing.status, "VERIFIED");
    assert.match(signing.verificationDigest, /^[a-f0-9]{64}$/);
    assert.equal(platform === "macos", result.notarizationEvidence !== null);
    if (result.notarizationEvidence) {
      const notarization = JSON.parse(result.notarizationEvidence.toString("utf8"));
      assert.equal(notarization.notarizationId, "44444444-4444-4444-8444-444444444444");
      assert.equal(notarization.status, "VERIFIED");
    }
    assert.ok(calls.every((call) => call.env.PATH === "" && call.env.NODE_ENV === "production"));
    if (platform === "windows") {
      assert.deepEqual(calls.map((call) => call.args[0]), ["sign", "verify"]);
      assert.ok(calls[0]!.args.includes("/tr"));
      assert.ok(calls[0]!.args.includes("A".repeat(40)));
    } else if (platform === "linux") {
      assert.deepEqual(calls.map((call) => call.args[0]), ["sign-blob", "verify-blob"]);
      assert.ok(calls[0]!.args.includes("kms://deviludo/steam-linux-signing"));
      assert.ok(calls[0]!.args.includes("--tlog-upload=true"));
    } else {
      assert.deepEqual(calls.map((call) => call.args[0]), [
        "--force", "--verify", "-c", "notarytool", "stapler", "--assess",
      ]);
      assert.ok(calls[3]!.args.includes("--keychain-profile"));
      assert.ok(calls[3]!.args.includes("deviludo-notary-production"));
    }
  }
});

test("native policy is exact, digestable and rejects platform or credential drift", async () => {
  const root = await mkdtemp(join(tmpdir(), "deviludo-native-policy-"));
  const toolsRoot = join(root, "tools"); await mkdir(toolsRoot);
  const policy = await policyFixture(root, "linux");
  assert.match(steamDepotNativePolicyDigest(policy), /^[a-f0-9]{64}$/);
  assert.throws(() => parseSteamDepotNativePolicy({
    ...policy,
    signer: { ...policy.signer, scheme: "WINDOWS_AUTHENTICODE" },
  }), /policy is invalid/);
  assert.throws(() => parseSteamDepotNativePolicy({
    ...policy,
    artifactStore: { ...policy.artifactStore, apiKey: "must-not-be-inline" },
  }), /policy is invalid/);
  assert.throws(() => parseSteamDepotNativePolicy({ ...policy, policyVersion: "latest" }), /policy is invalid/);
  assert.throws(() => parseSteamDepotNativePolicy({
    ...policy,
    artifactStore: { ...policy.artifactStore, endpoint: "http://s3.release.internal/" },
  }), /policy is invalid/);
});

test("tool digest drift stops before any platform signing process", async () => {
  const root = await mkdtemp(join(tmpdir(), "deviludo-native-tool-drift-"));
  const toolsRoot = join(root, "tools"); const exportRoot = join(root, "export");
  await Promise.all([mkdir(toolsRoot), mkdir(exportRoot)]);
  const policy = await policyFixture(root, "linux");
  const cosignPath = policy.signer.scheme === "LINUX_SIGSTORE" ? policy.signer.cosign.path : "";
  await chmod(cosignPath, 0o700);
  await writeFile(cosignPath, "tampered");
  let calls = 0;
  const signer = new LockedSteamDepotPlatformSigner({
    policy,
    hostPlatform: "aix",
    process: async () => { calls += 1; return { exitCode: 0, stdout: "", stderr: "" }; },
  });
  await assert.rejects(signer.probe(), /runtime/);
  assert.equal(calls, 0);
});

async function policyFixture(root: string, platform: SteamTargetPlatform): Promise<SteamDepotNativePolicy> {
  const tool = async (name: string) => {
    const path = join(root, "tools", name);
    const body = Buffer.from(`fixed-${name}`);
    await writeFile(path, body); await chmod(path, 0o500);
    return { path, digest: sha(body), version: "1.2.3" };
  };
  const common = {
    schemaVersion: "deviludo.steam-depot-native-policy.v1" as const,
    policyVersion: "1.0.0",
    platform,
    workRoot: join(root, "work"),
    artifactStore: {
      endpoint: "https://s3.release.internal:9000/",
      bucket: "deviludo-release-evidence",
      region: "us-east-1",
      accessKeyId: "DEVILUDORELEASE01",
      secretAccessKeyFile: join(root, "secrets", "s3-secret-access-key"),
      caFile: join(root, "secrets", "s3-ca.pem"),
    },
  };
  if (platform === "windows") return parseSteamDepotNativePolicy({ ...common, signer: {
    scheme: "WINDOWS_AUTHENTICODE",
    certificateSha1: "A".repeat(40),
    timestampUrl: "https://timestamp.digicert.com/",
    signtool: await tool("signtool.exe"),
  } });
  if (platform === "linux") {
    const publicKey = Buffer.from("public Sigstore verification key");
    const publicKeyFile = join(root, "cosign.pub"); await writeFile(publicKeyFile, publicKey);
    return parseSteamDepotNativePolicy({ ...common, signer: {
      scheme: "LINUX_SIGSTORE",
      signingKeyRef: "kms://deviludo/steam-linux-signing",
      publicKeyFile,
      publicKeyDigest: sha(publicKey),
      cosign: await tool("cosign"),
    } });
  }
  return parseSteamDepotNativePolicy({ ...common, signer: {
    scheme: "MACOS_DEVELOPER_ID",
    developerIdIdentity: "Developer ID Application: DeviLudo Studio (TEAMID1234)",
    notaryKeychainProfile: "deviludo-notary-production",
    codesign: await tool("codesign"),
    ditto: await tool("ditto"),
    spctl: await tool("spctl"),
    xcrun: await tool("xcrun"),
  } });
}

async function targetFixture(exportRoot: string, platform: SteamTargetPlatform): Promise<string> {
  if (platform === "windows") {
    const target = join(exportRoot, "DeviLudo.exe"); await writeFile(target, "windows"); return target;
  }
  if (platform === "linux") {
    const target = join(exportRoot, "DeviLudo.x86_64"); await writeFile(target, "linux"); return target;
  }
  const target = join(exportRoot, "DeviLudo.app"); const executable = join(target, "Contents", "MacOS");
  await mkdir(executable, { recursive: true }); await writeFile(join(executable, "DeviLudo"), "macos"); return target;
}

function finalizationRequest(platform: SteamTargetPlatform) {
  const sourceArtifactDigest = "6".repeat(64);
  const core = Object.freeze({
    schemaVersion: "deviludo.steam-depot-finalization.v1" as const,
    operationKey: `steam-depot-finalize:${releaseId}:${platform}`,
    tenantId,
    projectId,
    releaseId,
    mainCommitSha: "1".repeat(40),
    evidenceBundleDigest: "2".repeat(64),
    platform,
    sourceObjectKey: `tenants/${tenantId}/projects/${projectId}/runner-artifacts/44444444-4444-4444-8444-444444444444/${platform}/production-export/${sourceArtifactDigest}`,
    sourceArtifactDigest,
  });
  return parseSteamDepotFinalizationRequest({ ...core, requestDigest: steamCanonicalDigest(core) });
}
function sha(value: Buffer): string { return createHash("sha256").update(value).digest("hex"); }
