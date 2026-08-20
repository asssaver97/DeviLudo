import assert from "node:assert/strict";
import { readFile } from "node:fs/promises";
import test from "node:test";

const readStartup = () => readFile(new URL("../scripts/local-up.mjs", import.meta.url), "utf8");

test("cacheable local initialisation is gated while the migration ledger is always verified", async () => {
  const startup = await readStartup();
  // Each of these steps costs a container creation, so a repeat start must be able
  // to skip the ones whose inputs are unchanged.
  assert.match(startup, /if \(!matchesStartupCache\("vaultInit", fingerprint\)\) \{[\s\S]*?await refreshLocalVaultTokens/);
  assert.match(startup, /if \(!matchesStartupCache\("executorSecrets", fingerprint\)\) \{[\s\S]*?await refreshLocalExecutorSecrets/);
  assert.match(startup, /cachedStartupValue\("dockerSocketGid", dockerIdentity, \/\^\\d\+\$\/\)[\s\S]*return await resolveDockerSocketGid\(\)/);
  // Baseline compatibility cannot prove that later versioned migrations are
  // present, so every start compares the complete immutable ledger before it
  // decides whether creating a migration container is necessary.
  assert.match(startup, /readExpectedMigrationLedger\(\)/);
  assert.match(startup, /migrateWithOptionalBaselineReset\(environment, instanceState, expectedMigrationLedger\)/);
  assert.match(startup, /state\?\.baseline === "001 deviludo-self-hosted-v1" && state\.migrations === expectedLedger/);
  assert.match(startup, /bootstrapInstance\(environment, runtimeImages, instanceState, applied\)/);
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
  assert.doesNotMatch(startup, /imageCacheMaxAgeMs|age >= imageCacheMaxAgeMs/);
  assert.match(startup, /current\[image\] === startupCache\.imageIds\[image\]/);
  assert.match(startup, /if \(resolvedImageIds\) \{[\s\S]*跳过 10 个镜像的重复构建/);
  assert.match(startup, /await buildLocalImages\(baseEnvironment\)/);
  assert.match(startup, /async function buildLocalImages\(environment\)/);
  assert.match(startup, /并行 BuildKit 会话中断；正在复用已完成的层缓存逐个重试/);
  assert.match(startup, /for \(const \[index, entry\] of localImageBuilds\.entries\(\)\)/);
  // Healthy services are retained. A stop is reserved for rotated credentials,
  // whose in-memory consumers must reload their token files.
  assert.match(startup, /if \(!matchesStartupCache\("vaultInit", fingerprint\)\) \{[\s\S]*await stopCredentialConsumers/);
  assert.doesNotMatch(startup, /const startupCache = await readStartupCache\(dockerIdentity\);[\s\S]{0,500}await stopLocalE2e\(\)/);
});

test("local project directories use a reusable host bridge without exposing Git credentials to task containers", async () => {
  const [startup, bridge, bridgeDaemon, executorDaemon, proxy, compose] = await Promise.all([
    readStartup(),
    readFile(new URL("../scripts/local-git-import-server.mjs", import.meta.url), "utf8"),
    readFile(new URL("../scripts/local-git-import-daemon.mjs", import.meta.url), "utf8"),
    readFile(new URL("../services/sandbox-executor/src/daemon.ts", import.meta.url), "utf8"),
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
  assert.match(bridge, /"\/internal\/directory\/git\/commit"/);
  assert.match(bridge, /LOCAL_PROJECT_CHANGED/);
  assert.match(bridge, /"switch", "-c", branchName/);
  assert.match(bridge, /request\.headers\.origin/);
  assert.match(bridgeDaemon, /if \(await healthReady\(port\)\) return started/);
  assert.match(executorDaemon, /base\.hostname !== "local-project-bridge-proxy"/);
  assert.doesNotMatch(executorDaemon, /base\.hostname !== "host\.docker\.internal"/);
  assert.match(proxy, /allowedPaths = new Set\([\s\S]*"\/internal\/directory\/source"[\s\S]*"\/internal\/directory\/sync"[\s\S]*"\/internal\/directory\/git\/commit"/);
  assert.match(proxy, /equalToken/);
  assert.match(proxy, /target\.hostname !== "host\.docker\.internal"/);
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
  for (const ignored of ["test-results", "playwright-report", "*.tsbuildinfo", "README.md", "deploy", ".github"]) {
    assert.match(dockerignore, new RegExp(`^${ignored.replace(/[.*+?^${}()|[\]\\]/g, "\\$&")}$`, "m"));
  }
  assert.match(dockerignore, /^scripts\/\*\*$/m);
  assert.match(dockerignore, /^!scripts\/migrate-postgres\.mjs$/m);
  assert.match(dockerignore, /^!scripts\/local-project-bridge-proxy\.mjs$/m);
  assert.doesNotMatch(dockerignore, /^!scripts\/local-up\.mjs$/m);
  assert.equal((compose.match(/start_interval: 500ms/g) ?? []).length, 5);
  assert.equal((compose.match(/start_period: 30s/g) ?? []).length, 5);
  assert.equal((compose.match(/interval: 10s/g) ?? []).length, 5);
});

test("a fingerprint that cannot be computed never satisfies a gate", async () => {
  const startup = await readStartup();
  // The failure mode that matters is a skip that should not have happened, so an
  // unknown input has to be unusable rather than merely falsy-equal.
  assert.match(startup, /function matchesCachedFingerprint\(key, fingerprint\) \{\s*return typeof fingerprint === "string" && startupCache\[key\] === fingerprint;/);
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
  assert.match(startup, /return Number\.isFinite\(recordedAt\) \? parsed : \{\}/);
  assert.match(startup, /age >= 0 && age < startupCacheMaxAgeMs[\s\S]*matchesCachedFingerprint\(key, fingerprint\)/);
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

test("local startup returns with E2E preparation in the background and exposes continuous progress", async () => {
  const [startup, daemon, macNode, tart, dashboard, bootstrap] = await Promise.all([
    readStartup(),
    readFile(new URL("../scripts/local-e2e-daemon.mjs", import.meta.url), "utf8"),
    readFile(new URL("../scripts/local-macos-e2e.mjs", import.meta.url), "utf8"),
    readFile(new URL("../scripts/local-tart-prepare.mjs", import.meta.url), "utf8"),
    readFile(new URL("../components/ServerPoolDashboard.tsx", import.meta.url), "utf8"),
    readFile(new URL("../scripts/local-bootstrap.mjs", import.meta.url), "utf8"),
  ]);
  assert.match(startup, /启动 Web、Core 与本地依赖服务[\s\S]*启动 macOS E2E 后台准备/);
  assert.match(startup, /startLocalE2e\(\{ refresh: refreshE2eVm \}\)/);
  assert.doesNotMatch(startup, /preflightLocalTartE2e/);
  assert.doesNotMatch(startup, /prepareLocalTartE2e\(\{ refresh: refreshE2eVm \}\)/);
  assert.match(daemon, /arguments_\.push\("--refresh-e2e-vm"\)/);
  assert.match(macNode, /\/v1\/e2e\/nodes\/\$\{configuration\.nodeId\}\/preparation/);
  assert.match(macNode, /state: "FAILED"/);
  assert.match(tart, /onProgress[\s\S]*DOWNLOADING_BASE[\s\S]*percentage/);
  assert.match(dashboard, /preparing \? 2_000 : 15_000/);
  assert.match(dashboard, /role="progressbar"/);
  assert.doesNotMatch(bootstrap, /"cosign"/);
  assert.match(bootstrap, /function executeVisible/);
  assert.match(startup, /仍在进行：[\s\S]*formatDuration/);
  assert.match(startup, /"--wait",\s*"--no-deps",\s*\.\.\.localRuntimeServices/);
  assert.match(startup, /"run", "--rm", "--no-deps", "minio-init"/);
  assert.match(startup, /matchesCachedFingerprint\("projectSources", projectFingerprint\)/);
  assert.match(startup, /matchesCachedFingerprint\("objectStore", objectStoreFingerprint\)/);
  assert.match(startup, /executeVisible\("docker", \[\s*"compose"/);
});
