import assert from "node:assert/strict";
import { readFile } from "node:fs/promises";
import test from "node:test";

const readStartup = () => readFile(new URL("../scripts/local-up.mjs", import.meta.url), "utf8");

test("every one-shot local initialisation step is gated instead of re-run unconditionally", async () => {
  const startup = await readStartup();
  // Each of these steps costs a container creation, so a repeat start must be able
  // to skip the ones whose inputs are unchanged.
  assert.match(startup, /if \(!matchesStartupCache\("vaultInit", vaultFingerprint\)\) await refreshLocalVaultTokens/);
  assert.match(startup, /if \(!matchesStartupCache\("executorSecrets", executorSecretsFingerprint\)\) await refreshLocalExecutorSecrets/);
  assert.match(startup, /cachedStartupValue\("dockerSocketGid", dockerIdentity, \/\^\\d\+\$\/\)\s*\?\? await resolveDockerSocketGid\(\)/);
  // The migration and bootstrap containers are reachable only through the init
  // profile, so their skips are justified by the committed database state.
  assert.match(startup, /migrateWithOptionalBaselineReset\(environment, instanceState\)/);
  assert.match(startup, /bootstrapInstance\(environment, runtimeImages, instanceState, migrationRan\)/);
  assert.match(startup, /if \(state\?\.baseline === "001 deviludo-core-source-v1"\) return false;/);
});

test("a fingerprint that cannot be computed never satisfies a gate", async () => {
  const startup = await readStartup();
  // The failure mode that matters is a skip that should not have happened, so an
  // unknown input has to be unusable rather than merely falsy-equal.
  assert.match(startup, /function matchesStartupCache\(key, fingerprint\) \{\s*return typeof fingerprint === "string" && startupCache\[key\] === fingerprint;/);
  assert.match(startup, /function digest\(parts\) \{\s*if \(parts\.some\(part => part === null \|\| part === undefined\)\) return null;/);
  // Length-prefixing keeps two different part lists from hashing the same way.
  assert.match(startup, /hash\.update\(`\$\{value\.length\}:`, "utf8"\)/);
  // Reissued Vault tokens have to invalidate the executor secrets that install them.
  assert.match(startup, /digest\(\["executor-secrets", volumes, vaultFingerprint, \.\.\.sources\]\)/);
});

test("the startup cache is scoped to one daemon, time-bounded, and dropped after a reset", async () => {
  const startup = await readStartup();
  assert.match(startup, /if \(!identity\) return \{\};/);
  assert.match(startup, /if \(parsed\.dockerIdentity !== identity\) return \{\};/);
  // A stack left down long enough for token renewal to lapse must reissue rather
  // than trust a fingerprint that says nothing about the token's remaining life.
  assert.match(startup, /const startupCacheMaxAgeMs = 7 \* 24 \* 60 \* 60 \* 1000;/);
  assert.match(startup, /age >= 0 && age < startupCacheMaxAgeMs \? parsed : \{\}/);
  // Recorded only after the stack is up, so a start that fails midway redoes the work.
  assert.match(startup, /if \(!baselineReset\) \{\s*await writeStartupCache\(\{/);
  assert.match(startup, /baselineReset = true;/);
});

test("the bootstrap skip verifies stored key material, not just the presence of rows", async () => {
  const startup = await readStartup();
  // Comparing against sha256(public_key_pem) computed in SQL means these have to be
  // plain digests of the key bytes, so a rotated host keypair still forces a re-run.
  assert.match(startup, /function sha256Hex\(value\) \{\s*return createHash\("sha256"\)\.update\(value, "utf8"\)\.digest\("hex"\);/);
  assert.match(startup, /`local-core-executor:\$\{sha256Hex\(coreKey\)\}`/);
  assert.match(startup, /`\$\{state\.macNodeId\}:\$\{sha256Hex\(e2eKey\)\}`/);
  assert.match(startup, /if \(state\.pools !== "CORE,E2E_MACOS,WEB"\) return null;/);
  // Ordering is pinned to the C collation so the comparison ignores the database locale.
  assert.match(startup, /ORDER BY runtime_key COLLATE \\"C\\"/);
  assert.match(startup, /ORDER BY executor_id COLLATE \\"C\\"/);
  // A missing table would fail the state query at parse time, so the catalog is probed first.
  assert.match(startup, /to_regclass\('deviludo\.\$\{table\}'\) IS NOT NULL/);
});

test("local image builds stay reproducible so runtime digests are not re-registered every start", async () => {
  // Buildx stamps a fresh provenance attestation into the image config, so a fully
  // cached rebuild otherwise mints a new image id — which would churn the runtime
  // image digests and the executor allowlist on every start.
  const [startup, e2e] = await Promise.all([
    readStartup(),
    readFile(new URL("../scripts/run-e2e.mjs", import.meta.url), "utf8"),
  ]);
  for (const source of [startup, e2e]) {
    assert.match(source, /BUILDX_NO_DEFAULT_ATTESTATIONS: "1"/);
  }
});
