import assert from "node:assert/strict";
import { createHash } from "node:crypto";
import { chmod, mkdir, mkdtemp, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import test from "node:test";
import { canonicalJson } from "../../runner-control/src/canonical";
import { parseSteamDepotNativePolicy } from "../src/native-policy";
import {
  executeSteamDepotNativeCommand,
  parseSteamDepotNativeCommand,
} from "../src/run-native-controller";

test("native controller CLI probes one exact platform policy and no broader capability", async () => {
  const root = await mkdtemp(join(tmpdir(), "deviludo-native-controller-cli-"));
  const workRoot = join(root, "work"); const secretsRoot = join(root, "secrets");
  await Promise.all([mkdir(workRoot), mkdir(secretsRoot)]);
  const cosign = join(root, "cosign"); const publicKeyFile = join(root, "cosign.pub");
  const secretAccessKeyFile = join(secretsRoot, "s3-key"); const caFile = join(secretsRoot, "s3-ca.pem");
  const cosignBody = Buffer.from("fixed-cosign-binary"); const publicKey = Buffer.from("fixed-public-key");
  await Promise.all([
    writeFile(cosign, cosignBody, { mode: 0o500 }),
    writeFile(publicKeyFile, publicKey, { mode: 0o400 }),
    writeFile(secretAccessKeyFile, "test-only-secret-access-key", { mode: 0o400 }),
    writeFile(caFile, "-----BEGIN CERTIFICATE-----\ntest-only-release-ca-material\n-----END CERTIFICATE-----\n", { mode: 0o400 }),
  ]);
  await chmod(cosign, 0o500);
  const policy = parseSteamDepotNativePolicy({
    schemaVersion: "deviludo.steam-depot-native-policy.v1",
    policyVersion: "1.0.0",
    platform: "linux",
    workRoot,
    artifactStore: {
      endpoint: "https://s3.release.internal:9000/",
      bucket: "deviludo-release-evidence",
      region: "us-east-1",
      accessKeyId: "DEVILUDORELEASE01",
      secretAccessKeyFile,
      caFile,
    },
    signer: {
      scheme: "LINUX_SIGSTORE",
      signingKeyRef: "kms://deviludo/steam-linux-signing",
      publicKeyFile,
      publicKeyDigest: sha(publicKey),
      cosign: { path: cosign, digest: sha(cosignBody), version: "2.6.0" },
    },
  });
  const policyBody = Buffer.from(canonicalJson(policy));
  const policyFile = join(root, "policy.json"); await writeFile(policyFile, policyBody, { mode: 0o400 });
  let probes = 0;
  const output = await executeSteamDepotNativeCommand({ kind: "PROBE", policyFile }, {
    hostPlatform: "aix",
    toolProcess: async () => { throw new Error("probe must not execute signing tools"); },
    s3Http: async (_url, request) => {
      probes += 1; assert.equal(request.method, "HEAD");
      return { statusCode: 200, headers: {}, body: Buffer.alloc(0) };
    },
  });
  assert.equal(probes, 1);
  assert.deepEqual(JSON.parse(output ?? ""), {
    schemaVersion: "deviludo.native-steam-depot-finalizer-probe.v1",
    status: "READY",
    policyDigest: sha(policyBody),
    supportedSchemes: ["LINUX_SIGSTORE"],
  });
});

test("native controller CLI accepts only the parent service's fixed argv", () => {
  assert.deepEqual(parseSteamDepotNativeCommand([
    "probe", "--policy-file", "/opt/deviludo/policy.json", "--json",
  ]), { kind: "PROBE", policyFile: "/opt/deviludo/policy.json" });
  assert.deepEqual(parseSteamDepotNativeCommand([
    "finalize", "--policy-file", "/opt/deviludo/policy.json",
    "--request-file", "/var/lib/deviludo/request.json",
    "--receipt-file", "/var/lib/deviludo/receipt.json",
  ]), {
    kind: "FINALIZE",
    policyFile: "/opt/deviludo/policy.json",
    requestFile: "/var/lib/deviludo/request.json",
    receiptFile: "/var/lib/deviludo/receipt.json",
  });
  assert.throws(() => parseSteamDepotNativeCommand([
    "finalize", "--policy-file", "/opt/deviludo/policy.json",
    "--request-file", "/var/lib/deviludo/request.json",
    "--receipt-file", "/var/lib/deviludo/request.json",
  ]), /arguments is invalid/);
  assert.throws(() => parseSteamDepotNativeCommand([
    "probe", "--policy-file", "relative.json", "--json",
  ]), /path is invalid/);
  assert.throws(() => parseSteamDepotNativeCommand([
    "probe", "--policy-file", "/opt/deviludo/policy.json", "--json", "--verbose",
  ]), /arguments is invalid/);
});

function sha(value: Buffer): string { return createHash("sha256").update(value).digest("hex"); }
