import assert from "node:assert/strict";
import { generateKeyPairSync } from "node:crypto";
import { mkdtemp, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import test from "node:test";
import { steamSecureUiServiceConfigFromEnv } from "../src/run-secure-ui-service";

async function fixture() {
  const root = await mkdtemp(join(tmpdir(), "deviludo-steam-secure-ui-"));
  const names = ["server.key", "server.crt", "identity.key", "identity.crt", "identity-ca.crt",
    "access.key", "access.crt", "access-ca.crt", "mfa.key", "mfa.crt", "mfa-ca.crt", "invalid-session.key"];
  await Promise.all(names.map((name) => writeFile(join(root, name), "x".repeat(64), { mode: 0o600 })));
  const session = generateKeyPairSync("ed25519");
  await writeFile(join(root, "session-private.pem"), session.privateKey.export({ type: "pkcs8", format: "pem" }), { mode: 0o600 });
  return {
    DEVILUDO_STEAM_SECURE_UI_TLS_KEY_FILE: join(root, "server.key"),
    DEVILUDO_STEAM_SECURE_UI_TLS_CERT_FILE: join(root, "server.crt"),
    DEVILUDO_STEAM_SECURE_UI_IDENTITY_TLS_KEY_FILE: join(root, "identity.key"),
    DEVILUDO_STEAM_SECURE_UI_IDENTITY_TLS_CERT_FILE: join(root, "identity.crt"),
    DEVILUDO_STEAM_SECURE_UI_IDENTITY_CA_FILE: join(root, "identity-ca.crt"),
    DEVILUDO_STEAM_SECURE_UI_ACCESS_TLS_KEY_FILE: join(root, "access.key"),
    DEVILUDO_STEAM_SECURE_UI_ACCESS_TLS_CERT_FILE: join(root, "access.crt"),
    DEVILUDO_STEAM_SECURE_UI_ACCESS_CA_FILE: join(root, "access-ca.crt"),
    DEVILUDO_STEAM_SECURE_UI_MFA_TLS_KEY_FILE: join(root, "mfa.key"),
    DEVILUDO_STEAM_SECURE_UI_MFA_TLS_CERT_FILE: join(root, "mfa.crt"),
    DEVILUDO_STEAM_SECURE_UI_MFA_CA_FILE: join(root, "mfa-ca.crt"),
    DEVILUDO_STEAM_UI_SESSION_PRIVATE_KEY_FILE: join(root, "session-private.pem"),
    DEVILUDO_STEAM_UI_SESSION_KEY_ID: "steam-ui-key-2026-07",
    DEVILUDO_STEAM_SECURE_UI_PUBLIC_ORIGIN: "https://app.deviludo.example/",
    DEVILUDO_STEAM_SECURE_UI_IDENTITY_URL: "https://identity.internal/",
    DEVILUDO_STEAM_SECURE_UI_ACCESS_URL: "https://steam-access.internal/",
    DEVILUDO_STEAM_SECURE_UI_MFA_URL: "https://mfa.internal/",
  } as const;
}

test("Steam Secure UI config isolates its server, identity, access and MFA credentials", async () => {
  const config = await steamSecureUiServiceConfigFromEnv(await fixture());
  assert.equal(config.host, "0.0.0.0");
  assert.equal(config.port, 4576);
  assert.equal(config.publicOrigin, "https://app.deviludo.example/");
  assert.equal(config.sessionPrivateKey.asymmetricKeyType, "ed25519");
  assert.equal(config.sessionPublicKey.asymmetricKeyType, "ed25519");
  assert.notEqual(config.identityTls.key, config.accessTls.key);
  assert.notEqual(config.accessTls.key, config.mfaTls.key);
  assert.doesNotMatch(JSON.stringify(config), /PRIVATE KEY|password|guard.?code|config.?vdf/i);
});

test("Steam Secure UI config rejects non-HTTPS origins, ambiguous binds and non-Ed25519 keys", async () => {
  const env = await fixture();
  await assert.rejects(steamSecureUiServiceConfigFromEnv({ ...env, DEVILUDO_STEAM_SECURE_UI_ACCESS_URL: "http://127.0.0.1:4575/" }), /origin is invalid/);
  await assert.rejects(steamSecureUiServiceConfigFromEnv({ ...env, DEVILUDO_STEAM_SECURE_UI_HOST: "127.0.0.1" }), /bind host is invalid/);
  await assert.rejects(steamSecureUiServiceConfigFromEnv({ ...env,
    DEVILUDO_STEAM_SECURE_UI_MFA_TLS_KEY_FILE: env.DEVILUDO_STEAM_SECURE_UI_ACCESS_TLS_KEY_FILE }), /must be distinct/);
  await assert.rejects(steamSecureUiServiceConfigFromEnv({ ...env,
    DEVILUDO_STEAM_UI_SESSION_PRIVATE_KEY_FILE: join(env.DEVILUDO_STEAM_SECURE_UI_TLS_KEY_FILE, "..", "invalid-session.key") }), /DECODER routines|unsupported|invalid/i);
});
