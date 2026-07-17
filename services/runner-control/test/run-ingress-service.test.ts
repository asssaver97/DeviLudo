import assert from "node:assert/strict";
import { generateKeyPairSync } from "node:crypto";
import { mkdtemp, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import test from "node:test";
import { runnerIngressServiceConfigFromEnv } from "../src/run-ingress-service";

test("Runner ingress production config loads bounded TLS files and one exact Ed25519 job key", async () => {
  const directory = await mkdtemp(join(tmpdir(), "deviludo-runner-host-"));
  try {
    const tlsKey = join(directory, "tls.key");
    const tlsCert = join(directory, "tls.crt");
    const clientCa = join(directory, "ca.crt");
    const signingKey = join(directory, "signing.pem");
    const { privateKey } = generateKeyPairSync("ed25519");
    await Promise.all([
      writeFile(tlsKey, Buffer.alloc(64, 1)),
      writeFile(tlsCert, Buffer.alloc(64, 2)),
      writeFile(clientCa, Buffer.alloc(64, 3)),
      writeFile(signingKey, privateKey.export({ format: "pem", type: "pkcs8" })),
    ]);
    const config = await runnerIngressServiceConfigFromEnv({
      DEVILUDO_RUNNER_INGRESS_HOST: "127.0.0.1",
      DEVILUDO_RUNNER_INGRESS_PORT: "4430",
      DEVILUDO_RUNNER_INGRESS_MAX_BODY_BYTES: "2048",
      DEVILUDO_RUNNER_LEASE_SECONDS: "120",
      DEVILUDO_RUNNER_INGRESS_TLS_KEY_FILE: tlsKey,
      DEVILUDO_RUNNER_INGRESS_TLS_CERT_FILE: tlsCert,
      DEVILUDO_RUNNER_INGRESS_CLIENT_CA_FILE: clientCa,
      DEVILUDO_RUNNER_JOB_SIGNING_KEY_ID: "runner-job-key-17",
      DEVILUDO_RUNNER_JOB_SIGNING_KEY_FILE: signingKey,
    });
    assert.equal(config.host, "127.0.0.1");
    assert.equal(config.port, 4430);
    assert.equal(config.maxBodyBytes, 2048);
    assert.equal(config.leaseDurationSeconds, 120);
    assert.equal(config.jobSigningKeyId, "runner-job-key-17");
    assert.equal(config.jobSigningPrivateKey.asymmetricKeyType, "ed25519");
  } finally {
    await rm(directory, { recursive: true, force: true });
  }
});

test("Runner ingress production config rejects ambiguous hosts before reading secret files", async () => {
  await assert.rejects(runnerIngressServiceConfigFromEnv({
    DEVILUDO_RUNNER_INGRESS_HOST: "0.0.0.0; attacker",
  }), /host is invalid/);
});
