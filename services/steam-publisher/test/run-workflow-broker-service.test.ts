import assert from "node:assert/strict";
import { mkdtemp, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import test from "node:test";
import { steamWorkflowBrokerServiceConfigFromEnv } from "../src/run-workflow-broker-service";

test("Steam workflow Broker production config loads only bounded file-backed mTLS material", async () => {
  const root = await mkdtemp(join(tmpdir(), "deviludo-steam-broker-"));
  const paths = {
    key: join(root, "tls.key"), certificate: join(root, "tls.crt"), ca: join(root, "client-ca.crt"),
  };
  await Promise.all(Object.values(paths).map((path) => writeFile(path, "x".repeat(64), { mode: 0o600 })));
  const config = await steamWorkflowBrokerServiceConfigFromEnv({
    DEVILUDO_STEAM_WORKFLOW_BROKER_SERVER_TLS_KEY_FILE: paths.key,
    DEVILUDO_STEAM_WORKFLOW_BROKER_SERVER_TLS_CERT_FILE: paths.certificate,
    DEVILUDO_STEAM_WORKFLOW_BROKER_SERVER_CLIENT_CA_FILE: paths.ca,
    DEVILUDO_STEAM_WORKFLOW_BROKER_SERVER_ALLOWED_SPIFFE_IDS:
      '["spiffe://deviludo.internal/workload/temporal-steam-publisher"]',
    DEVILUDO_STEAM_WORKFLOW_BROKER_SERVER_VERSION: "1.2.3",
    DEVILUDO_STEAM_WORKFLOW_BROKER_SERVER_BINARY_DIGEST: "a".repeat(64),
  });
  assert.equal(config.host, "0.0.0.0");
  assert.equal(config.port, 4_745);
  assert.equal(config.version, "1.2.3");
  assert.equal(config.tlsKey.byteLength, 64);
  assert.deepEqual([...config.allowedSpiffeIds], ["spiffe://deviludo.internal/workload/temporal-steam-publisher"]);
  assert.doesNotMatch(JSON.stringify(config), /configVdf|accountPassword|guardCode|branchPassword/i);
});

test("Steam workflow Broker production config rejects floating identity and ambiguous network settings", async () => {
  await assert.rejects(steamWorkflowBrokerServiceConfigFromEnv({}), /TLS_KEY_FILE is required/);
  const root = await mkdtemp(join(tmpdir(), "deviludo-steam-broker-invalid-"));
  const path = join(root, "secret.pem");
  await writeFile(path, "x".repeat(64), { mode: 0o600 });
  const base = {
    DEVILUDO_STEAM_WORKFLOW_BROKER_SERVER_TLS_KEY_FILE: path,
    DEVILUDO_STEAM_WORKFLOW_BROKER_SERVER_TLS_CERT_FILE: path,
    DEVILUDO_STEAM_WORKFLOW_BROKER_SERVER_CLIENT_CA_FILE: path,
    DEVILUDO_STEAM_WORKFLOW_BROKER_SERVER_ALLOWED_SPIFFE_IDS:
      '["spiffe://deviludo.internal/workload/temporal-steam-publisher"]',
    DEVILUDO_STEAM_WORKFLOW_BROKER_SERVER_VERSION: "latest",
    DEVILUDO_STEAM_WORKFLOW_BROKER_SERVER_BINARY_DIGEST: "a".repeat(64),
  };
  await assert.rejects(steamWorkflowBrokerServiceConfigFromEnv(base), /version is invalid/);
  await assert.rejects(steamWorkflowBrokerServiceConfigFromEnv({
    ...base,
    DEVILUDO_STEAM_WORKFLOW_BROKER_SERVER_VERSION: "1.0.0",
    DEVILUDO_STEAM_WORKFLOW_BROKER_SERVER_HOST: "127.0.0.1",
  }), /host is invalid/);
});
