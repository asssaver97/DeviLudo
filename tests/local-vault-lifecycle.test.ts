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
  assert.equal((compose.match(/DEVILUDO_VAULT_TOKEN_RENEW_INTERVAL_SECONDS: "3600"/g) ?? []).length, 2);
});
