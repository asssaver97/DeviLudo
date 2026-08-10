import assert from "node:assert/strict";
import { readFile } from "node:fs/promises";
import test from "node:test";

const readStartup = () => readFile(new URL("../scripts/local-up.mjs", import.meta.url), "utf8");

test("cacheable local initialisation is gated while the migration ledger is always verified", async () => {
  const startup = await readStartup();
  // Each of these steps costs a container creation, so a repeat start must be able
  // to skip the ones whose inputs are unchanged.
  assert.match(startup, /if \(!matchesStartupCache\("vaultInit", vaultFingerprint\)\) \{[\s\S]*?await refreshLocalVaultTokens/);
  assert.match(startup, /if \(!matchesStartupCache\("executorSecrets", executorSecretsFingerprint\)\) \{[\s\S]*?await refreshLocalExecutorSecrets/);
  assert.match(startup, /cachedStartupValue\("dockerSocketGid", dockerIdentity, \/\^\\d\+\$\/\)\s*\?\? await resolveDockerSocketGid\(\)/);
  // Baseline compatibility cannot prove that later versioned migrations are
  // present, so every start compares the complete immutable ledger before it
  // decides whether creating a migration container is necessary.
  assert.match(startup, /readExpectedMigrationLedger\(\)/);
  assert.match(startup, /migrateWithOptionalBaselineReset\(environment, instanceState, expectedMigrationLedger\)/);
  assert.match(startup, /state\?\.baseline === "001 deviludo-core-source-v1" && state\.migrations === expectedLedger/);
  assert.match(startup, /bootstrapInstance\(environment, runtimeImages, instanceState, migrationRan\)/);
  assert.match(startup, /await runMigration\(environment\)/);
  assert.match(startup, /if \(!migrationRan && !baselineReset\)/);
});

test("an unchanged checkout reuses verified images and never runs two local starts concurrently", async () => {
  const startup = await readStartup();
  assert.match(startup, /openSync\(startupLockFile, "wx", 0o600\)/);
  assert.match(startup, /LOCAL_UP_ALREADY_RUNNING/);
  assert.match(startup, /"ls-files", "--cached", "--others", "--exclude-standard", "-z"/);
  assert.match(startup, /path === "\.dockerignore" \|\| !isDockerIgnored\(path, ignoreRules\)/);
  assert.match(startup, /startupCache\.imageInputFingerprint !== inputFingerprint/);
  assert.match(startup, /age >= imageCacheMaxAgeMs/);
  assert.match(startup, /current\[image\] === startupCache\.imageIds\[image\]/);
  assert.match(startup, /if \(!imageIds\) \{[\s\S]*executeVisible\("docker"/);
  assert.match(startup, /stage: "images_reused"/);
  // Healthy services are retained. A stop is reserved for rotated credentials,
  // whose in-memory consumers must reload their token files.
  assert.match(startup, /if \(!matchesStartupCache\("vaultInit", vaultFingerprint\)\) \{\s*await stopCredentialConsumers/);
  assert.doesNotMatch(startup, /const startupCache = await readStartupCache\(dockerIdentity\);[\s\S]{0,500}await stopLocalE2e\(\)/);
});

test("local project directories use a reusable host bridge without exposing Git credentials to task containers", async () => {
  const [startup, bridge, daemon, proxy, compose] = await Promise.all([
    readStartup(),
    readFile(new URL("../scripts/local-git-import-server.mjs", import.meta.url), "utf8"),
    readFile(new URL("../scripts/local-git-import-daemon.mjs", import.meta.url), "utf8"),
    readFile(new URL("../scripts/local-project-bridge-proxy.mjs", import.meta.url), "utf8"),
    readFile(new URL("../infra/docker-compose.yml", import.meta.url), "utf8"),
  ]);
  assert.match(startup, /startLocalGitImport\(\)/);
  assert.match(startup, /gitImportConfiguration: gitImportConfigurationFingerprint/);
  assert.match(startup, /randomBytes\(32\)\.toString\("base64url"\)/);
  assert.match(bridge, /"clone", "--depth=1", "--single-branch", "--no-tags"/);
  assert.match(bridge, /GIT_TERMINAL_PROMPT: "0"/);
  assert.match(bridge, /"\/directory\/select"/);
  assert.match(bridge, /"\/github\/clone"/);
  assert.doesNotMatch(bridge, /createStoredZip|application\/zip/);
  assert.match(bridge, /"\/directory\/git\/status"/);
  assert.match(bridge, /"\/directory\/git\/branch"/);
  assert.match(bridge, /"\/internal\/directory\/source"/);
  assert.match(bridge, /"\/internal\/directory\/sync"/);
  assert.match(bridge, /LOCAL_PROJECT_CHANGED/);
  assert.match(bridge, /"switch", "-c", branchName/);
  assert.match(bridge, /request\.headers\.origin/);
  assert.match(daemon, /if \(await healthReady\(port\)\) return started/);
  assert.match(proxy, /allowedPaths = new Set\(\["\/internal\/directory\/source", "\/internal\/directory\/sync"\]\)/);
  assert.match(proxy, /equalToken/);
  assert.doesNotMatch(proxy, /\/directory\/select|\/github\/clone/);
  assert.match(compose, /host\.docker\.internal:host-gateway/);
  assert.match(compose, /local-project-bridge-proxy:[\s\S]*?networks:[\s\S]*?- data[\s\S]*?- local-host/);
  assert.doesNotMatch(compose, /\.ssh|\.gitconfig|github\.token|GIT_ASKPASS/);
});

test("Docker dependency downloads are cached and health checks probe quickly only during startup", async () => {
  const [compose, dockerignore, web, webTsconfig, ...dockerfiles] = await Promise.all([
    readFile(new URL("../infra/docker-compose.yml", import.meta.url), "utf8"),
    readFile(new URL("../.dockerignore", import.meta.url), "utf8"),
    readFile(new URL("../Dockerfile.web", import.meta.url), "utf8"),
    readFile(new URL("../tsconfig.web.json", import.meta.url), "utf8"),
    ...["Dockerfile.web", "Dockerfile.core", "Dockerfile.executor", "Dockerfile.agent-claude", "Dockerfile.agent-codex"]
      .map(name => readFile(new URL(`../${name}`, import.meta.url), "utf8")),
  ]);
  for (const dockerfile of dockerfiles) {
    assert.match(dockerfile, /# syntax=docker\/dockerfile:1\.7/);
    assert.match(dockerfile, /--mount=type=cache,target=\/root\/\.npm/);
    assert.match(dockerfile, /--no-audit --no-fund/);
  }
  assert.doesNotMatch(web, /COPY \. \./);
  assert.match(web, /COPY package\.json package-lock\.json \.\//);
  assert.match(web, /COPY app \.\/app/);
  assert.match(web, /COPY next\.config\.ts next-env\.d\.ts tsconfig\.json tsconfig\.web\.json/);
  assert.match(webTsconfig, /"app\/\*\*\/\*\.tsx"/);
    for (const ignored of ["test-results", "playwright-report", "*.tsbuildinfo"]) {
    assert.match(dockerignore, new RegExp(`^${ignored.replace(/[.*+?^${}()|[\]\\]/g, "\\$&")}$`, "m"));
  }
  assert.equal((compose.match(/start_interval: 500ms/g) ?? []).length, 5);
  assert.equal((compose.match(/start_period: 30s/g) ?? []).length, 5);
  assert.equal((compose.match(/interval: 10s/g) ?? []).length, 5);
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
