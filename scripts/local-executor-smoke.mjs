import { spawn } from "node:child_process";
import { createHash, randomUUID } from "node:crypto";
import { promisify } from "node:util";
import { execFile } from "node:child_process";
import { GetObjectCommand, PutObjectCommand, S3Client } from "@aws-sdk/client-s3";
import { getSignedUrl } from "@aws-sdk/s3-request-presigner";

const execute = promisify(execFile);
const root = new URL("..", import.meta.url);
const skipNativeE2e = process.env.DEVILUDO_SKIP_NATIVE_E2E === "1";
const workspaceId = randomUUID();
const projectId = randomUUID();
const workflowId = randomUUID();
const bucket = "deviludo-artifacts";
const createdKeys = [];

try {
  await minio(["alias", "set", "deviludo-smoke", "http://127.0.0.1:9000", "deviludo-local", "deviludo-local-secret"]);
  const fixtureImage = await imageId("deviludo-agent-fixture:local");
  const agentJobId = randomUUID();
  const agentPlan = {
    schemaVersion: "deviludo.sandbox-plan.v2",
    mode: "RESTRICTED_CONTAINER",
    workspace: workspacePath(agentJobId),
    objectPrefix: objectPrefix(agentJobId),
    vaultPath: vaultPath(agentJobId),
    agentConfiguration: {
      runtime: "CLAUDE_CODE",
      baseUrl: "https://fixture.invalid",
      models: { primary: "fixture", opus: "fixture", sonnet: "fixture", haiku: "fixture", subagent: "fixture" },
      credentialRef: `vault://instance/agent-runtime/api-key/versions/${randomUUID()}`,
      credentialEnvironmentVariable: "ANTHROPIC_AUTH_TOKEN",
      environment: {
        ANTHROPIC_BASE_URL: "https://fixture.invalid",
        ANTHROPIC_MODEL: "fixture",
        ANTHROPIC_DEFAULT_OPUS_MODEL: "fixture",
        ANTHROPIC_DEFAULT_SONNET_MODEL: "fixture",
        ANTHROPIC_DEFAULT_HAIKU_MODEL: "fixture",
        CLAUDE_CODE_SUBAGENT_MODEL: "fixture",
      },
      revision: 1,
    },
    networkPolicy: "AGENT_EGRESS_ALLOWLIST",
    job: job({
      jobId: agentJobId,
      jobKind: "AGENT_GENERATION",
      runtimeImage: fixtureImage,
      requiredCapabilities: ["MICROVM", "NETWORK_POLICY"],
      inputObjects: [],
      outputContract: { kinds: ["SPECIFICATION"], maxBytes: 134_217_728 },
      budget: { cpuMillis: 120_000, memoryBytes: 536_870_912, networkBytes: 0 },
      timeoutSeconds: 120,
      payload: { fixture: true, publishSourceRevision: 1 },
    }),
  };
  const agentProgress = [];
  const agentStarted = deferred();
  const agentReceiptPromise = runClient(agentPlan, event => {
    agentProgress.push(event);
    if (event.content === "Agent 已开始生成项目") agentStarted.resolve();
  });
  await Promise.race([
    agentStarted.promise,
    new Promise((_, reject) => setTimeout(() => reject(new Error("Fixture Agent did not start in time")), 30_000)),
  ]);
  const guidance = "保留键盘操作，并优先完成清晰的时间循环提示。";
  await sendGuidance(agentJobId, guidance);
  const agentReceipt = await agentReceiptPromise;
  assertReceipt(agentReceipt, ["SPECIFICATION"]);
  if (!agentProgress.some(event => event.kind === "AGENT_OUTPUT" && event.content === `已收到玩家引导：${guidance}`)) {
    throw new Error("Fixture Agent did not receive player guidance through the executor stream");
  }
  createdKeys.push(...agentReceipt.outputObjects.map(object => object.key));
  const source = agentReceipt.details?.sourceRevision;
  if (!source?.relativePath || !source?.digest) throw new Error("Fixture Agent did not publish a persistent source revision");

  const assetContent = Buffer.from("iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAYAAAAfFcSJAAAADUlEQVR42mNk+M/wHwAF/gL+Avv1AAAAAElFTkSuQmCC", "base64");
  const assetDigest = `sha256:${createHash("sha256").update(assetContent).digest("hex")}`;
  const assetKey = "ui/smoke-icon";
  const assetObjectKey = `workspaces/${workspaceId}/projects/${projectId}/assets/${assetKey}-${assetDigest.slice(7, 23)}.png`;
  await localS3().send(new PutObjectCommand({
    Bucket: bucket,
    Key: assetObjectKey,
    Body: assetContent,
    ContentType: "image/png",
    Metadata: { sha256: assetDigest },
  }));
  createdKeys.push(assetObjectKey);

  const buildJobId = randomUUID();
  const buildProgress = [];
  const buildReceipt = await runClient({
    schemaVersion: "deviludo.sandbox-plan.v2",
    mode: "RESTRICTED_CONTAINER",
    workspace: workspacePath(buildJobId),
    objectPrefix: objectPrefix(buildJobId),
    vaultPath: vaultPath(buildJobId),
    agentConfiguration: null,
    networkPolicy: "BUILD_EGRESS_DENY",
    job: job({
      jobId: buildJobId,
      jobKind: "ARTIFACT_BUILD",
      runtimeImage: await imageId("deviludo-godot-builder:local"),
      requiredCapabilities: ["RESTRICTED_CONTAINER", "BUILD_TOOLCHAIN"],
      inputObjects: [...agentReceipt.outputObjects, {
        kind: "ASSET",
        assetKey,
        bucket,
        key: assetObjectKey,
        sha256: assetDigest,
        sizeBytes: assetContent.length,
      }],
      outputContract: { kinds: ["BUILD"], maxBytes: 1_073_741_824 },
      budget: { cpuMillis: 300_000, memoryBytes: 2_147_483_648, networkBytes: 0 },
      timeoutSeconds: 300,
      payload: {
        targetPlatforms: ["macos"],
        sourceRevision: source.revision,
        sourceRelativePath: source.relativePath,
        sourceDigest: source.digest,
      },
    }),
  }, event => buildProgress.push(event));
  assertReceipt(buildReceipt, ["BUILD"]);
  if (!buildProgress.some(event => event.kind === "PHASE" && /已同步 1 个图片素材/.test(event.content))) {
    throw new Error("Godot Builder did not materialize the supplied image into the source tree");
  }
  const build = buildReceipt.outputObjects[0];
  if (build.targetPlatform !== "macos") throw new Error("Godot Builder did not produce a macOS artifact");
  createdKeys.push(build.key);
  await assertObjectBytes(build);

  const macReport = skipNativeE2e ? null : await runNativeMacE2e(build);
  if (macReport && (macReport.schemaVersion !== "deviludo.godot-guest-report.v1"
    || macReport.outcome !== "PASSED" || macReport.failureDomain !== null
    || macReport.guest?.isolation !== "DEVELOPMENT_NATIVE" || macReport.guest?.exitCode !== 0
    || macReport.inputDigest !== build.sha256)) {
    throw new Error(`Native macOS E2E report is invalid: ${JSON.stringify(macReport)}`);
  }

  console.log(JSON.stringify({
    fixtureAgent: {
      receipt: agentReceipt.schemaVersion,
      providerCalled: false,
      simulated: agentReceipt.simulated,
      progressEvents: agentProgress.length,
      playerGuidance: "delivered-and-observed",
    },
    build: { receipt: buildReceipt.schemaVersion, simulated: buildReceipt.simulated, materializedAssets: 1 },
    artifact: { kind: build.kind, targetPlatform: build.targetPlatform, sha256: build.sha256, sizeBytes: build.sizeBytes },
    macE2e: macReport && {
      schemaVersion: macReport.schemaVersion,
      isolation: macReport.guest.isolation,
      exitCode: macReport.guest.exitCode,
    },
  }));
} finally {
  for (const key of createdKeys) await minio(["rm", "--force", `deviludo-smoke/${bucket}/${key}`]).catch(() => undefined);
}

function job(input) {
  return {
    schemaVersion: "deviludo.job.v4",
    jobId: input.jobId,
    workflowId,
    workspaceId,
    projectId,
    poolKind: "CORE",
    jobKind: input.jobKind,
    targetOperatingSystem: null,
    requiredCapabilities: input.requiredCapabilities,
    exclusive: false,
    isolationGeneration: 1,
    runtimeImage: input.runtimeImage,
    workflowProfile: "VALIDATE",
    inputObjects: input.inputObjects,
    outputContract: input.outputContract,
    budget: input.budget,
    timeoutSeconds: input.timeoutSeconds,
    payload: input.payload,
    lease: { token: randomUUID(), expiresAt: new Date(Date.now() + 10 * 60_000).toISOString(), fencingToken: 1 },
  };
}

function workspacePath(jobId) {
  return `/var/lib/deviludo/workspaces/${workspaceId}/${projectId}/${jobId}/g1`;
}

function objectPrefix(jobId) {
  return `workspaces/${workspaceId}/projects/${projectId}/jobs/${jobId}`;
}

function vaultPath(jobId) {
  return `workspaces/${workspaceId}/projects/${projectId}/jobs/${jobId}`;
}

function assertReceipt(receipt, kinds) {
  if (receipt.schemaVersion !== "deviludo.executor-receipt.v2" || receipt.simulated !== false
    || receipt.exitCode !== 0 || receipt.outputObjects?.length !== kinds.length
    || kinds.some(kind => !receipt.outputObjects.some(object => object.kind === kind))) {
    throw new Error(`Executor receipt is invalid: ${JSON.stringify(receipt)}`);
  }
}

async function imageId(image) {
  return (await execute("docker", ["image", "inspect", "--format", "{{.Id}}", image], {
    cwd: root,
    timeout: 10_000,
  })).stdout.trim();
}

async function assertObjectBytes(object) {
  const content = await minio(["cat", `deviludo-smoke/${object.bucket}/${object.key}`], true);
  const digest = `sha256:${createHash("sha256").update(content).digest("hex")}`;
  if (content.length !== object.sizeBytes || digest !== object.sha256) {
    throw new Error("Executor artifact bytes do not match its receipt");
  }
}

async function runNativeMacE2e(object) {
  const client = localS3();
  const url = await getSignedUrl(client, new GetObjectCommand({ Bucket: object.bucket, Key: object.key }), { expiresIn: 300 });
  return runJson(process.execPath, [new URL("./executors/local-macos-job.mjs", import.meta.url).pathname, "test"], {
    schemaVersion: "deviludo.e2e-execution.v1",
    action: "test",
    jobId: randomUUID(),
    workspaceId,
    projectId,
    payload: {},
    inputs: [{ object, url, expiresAt: new Date(Date.now() + 300_000).toISOString() }],
  });
}

function localS3() {
  return new S3Client({
    region: "us-east-1",
    endpoint: "http://127.0.0.1:39000",
    forcePathStyle: true,
    credentials: { accessKeyId: "deviludo-local", secretAccessKey: "deviludo-local-secret" },
  });
}

async function runClient(plan, onProgress) {
  return runJson("docker", [
    "compose", "-f", "infra/docker-compose.yml", "exec", "-T", "core-sandbox",
    "/usr/local/bin/sandbox-executor-client", "execute",
  ], plan, 10 * 60_000, onProgress);
}

async function sendGuidance(jobId, content) {
  const result = await runJson("docker", [
    "compose", "-f", "infra/docker-compose.yml", "exec", "-T", "core-sandbox",
    "/usr/local/bin/sandbox-executor-client", "guidance",
  ], { jobId, content }, 30_000);
  if (result?.accepted !== true) throw new Error("Executor rejected player guidance");
}

function runJson(executable, arguments_, input, timeout = 5 * 60_000, onProgress) {
  return new Promise((resolve, reject) => {
    const child = spawn(executable, arguments_, { cwd: root, shell: false, stdio: ["pipe", "pipe", "pipe"] });
    child.stdin.end(JSON.stringify(input));
    const stdout = [];
    const stderr = [];
    let progressBuffer = "";
    child.stdout.on("data", chunk => stdout.push(Buffer.from(chunk)));
    child.stderr.on("data", chunk => {
      stderr.push(Buffer.from(chunk));
      if (!onProgress) return;
      progressBuffer += chunk.toString("utf8");
      const lines = progressBuffer.split(/\r?\n/);
      progressBuffer = lines.pop() ?? "";
      for (const line of lines) consumeProgress(line, onProgress);
    });
    const timer = setTimeout(() => child.kill("SIGKILL"), timeout);
    child.once("error", error => { clearTimeout(timer); reject(error); });
    child.once("close", code => {
      clearTimeout(timer);
      if (onProgress && progressBuffer.trim()) consumeProgress(progressBuffer, onProgress);
      if (code !== 0) return reject(new Error(`Command failed: ${Buffer.concat(stderr).toString("utf8").slice(0, 4_000)}`));
      try { resolve(JSON.parse(Buffer.concat(stdout).toString("utf8"))); }
      catch { reject(new Error("Command returned invalid JSON")); }
    });
  });
}

function consumeProgress(line, onProgress) {
  if (!line.startsWith("DEVILUDO_PROGRESS:")) return;
  const event = JSON.parse(line.slice("DEVILUDO_PROGRESS:".length));
  if (["PHASE", "AGENT_OUTPUT"].includes(event?.kind) && typeof event.content === "string") onProgress(event);
}

function deferred() {
  let resolve;
  const promise = new Promise(done => { resolve = done; });
  return { promise, resolve };
}

async function dockerCompose(arguments_) {
  return execute("docker", ["compose", "-f", "infra/docker-compose.yml", ...arguments_], {
    cwd: root,
    timeout: 30_000,
    maxBuffer: 1_073_741_824,
    encoding: "buffer",
  });
}

async function minio(arguments_, raw = false) {
  const result = await dockerCompose(["exec", "-T", "minio", "mc", ...arguments_]);
  return raw ? result.stdout : result.stdout.toString("utf8");
}
