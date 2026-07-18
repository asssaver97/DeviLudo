import assert from "node:assert/strict";
import { generateKeyPairSync } from "node:crypto";
import { mkdtemp, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import test from "node:test";
import { steamAccessServiceConfigFromEnv } from "../src/run-access-service";

async function fixture() {
  const root = await mkdtemp(join(tmpdir(), "deviludo-steam-access-"));
  const tlsNames = ["server.key", "server.crt", "client-ca.crt", "dependency.key", "dependency.crt", "dependency-ca.crt"];
  await Promise.all(tlsNames.map((name) => writeFile(join(root, name), "x".repeat(64), { mode: 0o600 })));
  const ui = generateKeyPairSync("ed25519");
  const authorization = generateKeyPairSync("ed25519");
  await Promise.all([
    writeFile(join(root, "ui-public.pem"), ui.publicKey.export({ type: "spki", format: "pem" }), { mode: 0o600 }),
    writeFile(join(root, "authorization-public.pem"), authorization.publicKey.export({ type: "spki", format: "pem" }), { mode: 0o600 }),
  ]);
  return {
    DEVILUDO_STEAM_ACCESS_TLS_KEY_FILE: join(root, "server.key"),
    DEVILUDO_STEAM_ACCESS_TLS_CERT_FILE: join(root, "server.crt"),
    DEVILUDO_STEAM_ACCESS_CLIENT_CA_FILE: join(root, "client-ca.crt"),
    DEVILUDO_STEAM_ACCESS_DEPENDENCY_TLS_KEY_FILE: join(root, "dependency.key"),
    DEVILUDO_STEAM_ACCESS_DEPENDENCY_TLS_CERT_FILE: join(root, "dependency.crt"),
    DEVILUDO_STEAM_ACCESS_DEPENDENCY_CA_FILE: join(root, "dependency-ca.crt"),
    DEVILUDO_STEAM_UI_SESSION_PUBLIC_KEY_FILE: join(root, "ui-public.pem"),
    DEVILUDO_STEAM_AUTHORIZATION_PUBLIC_KEY_FILE: join(root, "authorization-public.pem"),
    DEVILUDO_STEAM_ACCESS_WEB_SPIFFE_IDS: "spiffe://deviludo.internal/workload/web",
    DEVILUDO_STEAM_ACCESS_UI_SPIFFE_IDS: "spiffe://deviludo.internal/workload/steam-secure-ui",
    DEVILUDO_STEAM_ACCESS_PUBLIC_ORIGIN: "https://steam-access.deviludo.example/",
    DEVILUDO_STEAM_LOGIN_CONNECTOR_URL: "https://steam-login.internal/",
    DEVILUDO_STEAM_CONFIG_VAULT_URL: "https://steam-vault.internal/",
    DEVILUDO_STEAM_MFA_VERIFIER_URL: "https://mfa.internal/",
    DEVILUDO_STEAM_AUTHORIZATION_SIGNER_URL: "https://kms.internal/",
    DEVILUDO_STEAM_UI_SESSION_KEY_ID: "steam-ui-key-1",
    DEVILUDO_STEAM_AUTHORIZATION_KEY_ID: "steam-publish-key-1",
  } as const;
}

test("Steam access production config loads only file-mounted keys and disjoint workload identities", async () => {
  const config = await steamAccessServiceConfigFromEnv(await fixture());
  assert.equal(config.host, "0.0.0.0");
  assert.equal(config.port, 4575);
  assert.equal(config.publicOrigin, "https://steam-access.deviludo.example/");
  assert.deepEqual([...config.webSpiffeIds], ["spiffe://deviludo.internal/workload/web"]);
  assert.deepEqual([...config.uiSpiffeIds], ["spiffe://deviludo.internal/workload/steam-secure-ui"]);
  assert.equal(config.uiSessionPublicKey.asymmetricKeyType, "ed25519");
  assert.equal(config.publishAuthorizationPublicKey.asymmetricKeyType, "ed25519");
  assert.doesNotMatch(JSON.stringify(config), /PRIVATE KEY|password|guard.?code|config.?vdf/i);
});

test("Steam access production config rejects shared identities, non-HTTPS dependencies and bind ambiguity", async () => {
  const env = await fixture();
  await assert.rejects(steamAccessServiceConfigFromEnv({
    ...env,
    DEVILUDO_STEAM_ACCESS_UI_SPIFFE_IDS: env.DEVILUDO_STEAM_ACCESS_WEB_SPIFFE_IDS,
  }), /must be disjoint/);
  await assert.rejects(steamAccessServiceConfigFromEnv({
    ...env,
    DEVILUDO_STEAM_CONFIG_VAULT_URL: "http://127.0.0.1:8200/",
  }), /dependency origin is invalid/);
  await assert.rejects(steamAccessServiceConfigFromEnv({
    ...env,
    DEVILUDO_STEAM_ACCESS_HOST: "127.0.0.1",
  }), /bind host is invalid/);
  await assert.rejects(steamAccessServiceConfigFromEnv({
    ...env,
    DEVILUDO_STEAM_UI_SESSION_PUBLIC_KEY_FILE: env.DEVILUDO_STEAM_ACCESS_TLS_KEY_FILE,
  }), /DECODER routines|unsupported|invalid/i);
});
