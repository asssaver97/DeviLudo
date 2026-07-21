import assert from "node:assert/strict";
import { generateKeyPairSync } from "node:crypto";
import { mkdtemp, mkdir, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import test from "node:test";
import { steamWorkflowExecutorConfigFromEnv } from "../src/run-workflow-executor-service";

async function fixture(t: { after(callback: () => Promise<void>): void }) {
  const root = await mkdtemp(join(tmpdir(), "deviludo-steam-executor-"));
  t.after(() => rm(root, { recursive: true, force: true }));
  const workRoot = join(root, "work");
  await mkdir(workRoot, { mode: 0o700 });
  const keys = generateKeyPairSync("ed25519");
  const publicKey = keys.publicKey.export({ format: "pem", type: "spki" });
  const files = {
    executable: join(root, "publisher"),
    nativeConfig: join(root, "publisher.json"),
    rcPublicKey: join(root, "rc-public.pem"),
    authorizationPublicKey: join(root, "authorization-public.pem"),
    tlsKey: join(root, "tls.key"),
    tlsCertificate: join(root, "tls.crt"),
    tlsCa: join(root, "tls-ca.crt"),
    finalizerTlsKey: join(root, "finalizer-tls.key"),
    finalizerTlsCertificate: join(root, "finalizer-tls.crt"),
    finalizerTlsCa: join(root, "finalizer-ca.crt"),
    s3Secret: join(root, "s3-secret"),
    s3Ca: join(root, "s3-ca.crt"),
  };
  await Promise.all([
    writeFile(files.executable, "native-binary", { mode: 0o500 }),
    writeFile(files.nativeConfig, "{}", { mode: 0o400 }),
    writeFile(files.rcPublicKey, publicKey, { mode: 0o400 }),
    writeFile(files.authorizationPublicKey, publicKey, { mode: 0o400 }),
    writeFile(files.tlsKey, "k".repeat(64), { mode: 0o400 }),
    writeFile(files.tlsCertificate, "c".repeat(64), { mode: 0o400 }),
    writeFile(files.tlsCa, "a".repeat(64), { mode: 0o400 }),
    writeFile(files.finalizerTlsKey, "f".repeat(64), { mode: 0o400 }),
    writeFile(files.finalizerTlsCertificate, "d".repeat(64), { mode: 0o400 }),
    writeFile(files.finalizerTlsCa, "q".repeat(64), { mode: 0o400 }),
    writeFile(files.s3Secret, "s".repeat(32), { mode: 0o400 }),
    writeFile(files.s3Ca, "r".repeat(64), { mode: 0o400 }),
  ]);
  const env = Object.freeze({
    DEVILUDO_STEAM_EXECUTOR_NATIVE_EXECUTABLE: files.executable,
    DEVILUDO_STEAM_EXECUTOR_NATIVE_EXECUTABLE_DIGEST: "a".repeat(64),
    DEVILUDO_STEAM_EXECUTOR_NATIVE_CONFIG_FILE: files.nativeConfig,
    DEVILUDO_STEAM_EXECUTOR_NATIVE_CONFIG_DIGEST: "b".repeat(64),
    DEVILUDO_STEAM_EXECUTOR_WORK_ROOT: workRoot,
    DEVILUDO_STEAM_EXECUTOR_RC_SIGNER_URL: "https://steam-rc-signer.internal",
    DEVILUDO_STEAM_EXECUTOR_RC_SIGNER_KEY_ID: "steam-rc-key-2026-07",
    DEVILUDO_STEAM_EXECUTOR_RC_SIGNER_PUBLIC_KEY_FILE: files.rcPublicKey,
    DEVILUDO_STEAM_EXECUTOR_RC_SIGNER_TLS_KEY_FILE: files.tlsKey,
    DEVILUDO_STEAM_EXECUTOR_RC_SIGNER_TLS_CERT_FILE: files.tlsCertificate,
    DEVILUDO_STEAM_EXECUTOR_RC_SIGNER_CA_FILE: files.tlsCa,
    DEVILUDO_STEAM_EXECUTOR_DEPOT_FINALIZER_URL: "https://steam-depot-finalizer.internal",
    DEVILUDO_STEAM_EXECUTOR_DEPOT_FINALIZER_TLS_KEY_FILE: files.finalizerTlsKey,
    DEVILUDO_STEAM_EXECUTOR_DEPOT_FINALIZER_TLS_CERT_FILE: files.finalizerTlsCertificate,
    DEVILUDO_STEAM_EXECUTOR_DEPOT_FINALIZER_CA_FILE: files.finalizerTlsCa,
    DEVILUDO_STEAM_EXECUTOR_AUTHORIZATION_KEY_ID: "steam-authorization-key-2026-07",
    DEVILUDO_STEAM_EXECUTOR_AUTHORIZATION_PUBLIC_KEY_FILE: files.authorizationPublicKey,
    DEVILUDO_STEAM_EXECUTOR_S3_ENDPOINT: "https://s3.internal",
    DEVILUDO_STEAM_EXECUTOR_S3_BUCKET: "deviludo-evidence",
    DEVILUDO_STEAM_EXECUTOR_S3_REGION: "cn-internal-1",
    DEVILUDO_STEAM_EXECUTOR_S3_ACCESS_KEY_ID: "STEAMEXECUTORACCESS",
    DEVILUDO_STEAM_EXECUTOR_S3_SECRET_KEY_FILE: files.s3Secret,
    DEVILUDO_STEAM_EXECUTOR_S3_CA_FILE: files.s3Ca,
  });
  return { files, env };
}

test("isolated Steam executor loads pinned native, KMS, verification and S3 identities", async (t) => {
  const { env } = await fixture(t);
  const config = await steamWorkflowExecutorConfigFromEnv(env);
  assert.equal(config.nativePublisher.executableDigest, "a".repeat(64));
  assert.equal(config.nativePublisher.configDigest, "b".repeat(64));
  assert.equal(config.rcSigner.keyId, "steam-rc-key-2026-07");
  assert.equal(config.rcSigner.publicKey.asymmetricKeyType, "ed25519");
  assert.equal(config.depotFinalizer.endpoint, "https://steam-depot-finalizer.internal");
  assert.equal(config.depotFinalizer.tls.key.toString("utf8"), "f".repeat(64));
  assert.equal(config.authorization.publicKey.asymmetricKeyType, "ed25519");
  assert.equal(config.s3.secretAccessKey.toString("utf8"), "s".repeat(32));
  assert.doesNotMatch(JSON.stringify(env), /configVdf|accountPassword|guardCode|branchPassword/i);
  config.s3.secretAccessKey.fill(0);
});

test("isolated Steam executor rejects missing, floating and inline secret configuration", async (t) => {
  const { env } = await fixture(t);
  await assert.rejects(steamWorkflowExecutorConfigFromEnv({
    ...env,
    DEVILUDO_STEAM_EXECUTOR_RC_SIGNER_PUBLIC_KEY_FILE: undefined,
  }), /PUBLIC_KEY_FILE is required/);
  await assert.rejects(steamWorkflowExecutorConfigFromEnv({
    ...env,
    DEVILUDO_STEAM_EXECUTOR_NATIVE_EXECUTABLE_DIGEST: "latest",
  }), /EXECUTABLE_DIGEST is invalid/);
  await assert.rejects(steamWorkflowExecutorConfigFromEnv({
    ...env,
    DEVILUDO_STEAM_EXECUTOR_S3_SECRET_KEY_FILE: "inline-secret-value",
  }), /path is invalid/);
  await assert.rejects(steamWorkflowExecutorConfigFromEnv({
    ...env,
    DEVILUDO_STEAM_EXECUTOR_DEPOT_FINALIZER_TLS_CERT_FILE: env.DEVILUDO_STEAM_EXECUTOR_RC_SIGNER_TLS_CERT_FILE,
  }), /must use distinct mTLS identities/);
});
