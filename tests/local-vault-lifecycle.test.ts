import assert from "node:assert/strict";
import { readFile } from "node:fs/promises";
import test from "node:test";

test("local startup rotates renewable Vault service tokens before Core starts", async () => {
  const [initializer, startup] = await Promise.all([
    readFile(new URL("../infra/vault/local-init.sh", import.meta.url), "utf8"),
    readFile(new URL("../scripts/local-up.mjs", import.meta.url), "utf8"),
  ]);
  assert.match(initializer, /issue_service_token api deviludo-api 1001:1001 0400/);
  assert.match(initializer, /issue_service_token executor deviludo-executor 0:0 0600/);
  assert.match(initializer, /-period=720h/);
  assert.match(initializer, /mv -f "\$temporary" "\/tokens\/\$\{name\}\.token"/);
  assert.match(startup, /"postgres", "vault"/);
  assert.match(startup, /await refreshLocalVaultTokens\(baseEnvironment\)/);
  assert.match(startup, /await refreshLocalExecutorSecrets\(environment\)/);
  assert.match(startup, /"run", "--rm", "--no-deps", "vault-init"/);
  assert.match(startup, /"run", "--rm", "--no-deps", "sandbox-executor-init"/);
  const compose = await readFile(new URL("../infra/docker-compose.yml", import.meta.url), "utf8");
  // Every service holding a Vault token has to renew it on the same cadence, or the
  // one that does not will start failing reads once its lease lapses. Asserted per
  // service rather than as a count so adding a token holder without renewal is what
  // fails, not merely changing how many there are.
  for (const service of ["core-api", "core-scheduler", "sandbox-executord"]) {
    const block = compose.match(new RegExp(` {2}${service}:([\\s\\S]*?)\\n {2}[a-z][a-z0-9-]*:`))?.[1] ?? "";
    assert.match(block, /DEVILUDO_VAULT_TOKEN_FILE/, `${service} must be given a Vault token`);
    assert.match(
      block,
      /DEVILUDO_VAULT_TOKEN_RENEW_INTERVAL_SECONDS: "3600"/,
      `${service} must renew its Vault token`,
    );
  }
});

test("the Core Vault policy grants each secret scope its own path", async () => {
  // Local and deployed policies have to stay in step, otherwise saving an image
  // generation key succeeds locally and is denied in a real cluster.
  const [local, deployed] = await Promise.all([
    readFile(new URL("../infra/vault/api.hcl", import.meta.url), "utf8"),
    readFile(new URL("../deploy/assets/vault-api.hcl", import.meta.url), "utf8"),
  ]);
  for (const policy of [local, deployed]) {
    for (const scope of ["agent-runtime", "image-generation"]) {
      assert.match(policy, new RegExp(
        `path "secret/data/deviludo/instance/${scope}/api-key/versions/\\*" \\{\\s*capabilities = \\["create", "update", "read"\\]`,
      ));
    }
    // Core writes and reads keys; it never enumerates or deletes them.
    assert.doesNotMatch(policy, /"delete"|"list"|"sudo"/);
  }
  assert.equal(local.trim(), deployed.trim());
});
