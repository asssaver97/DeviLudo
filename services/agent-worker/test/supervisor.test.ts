import assert from "node:assert/strict";
import type {
  ChildProcessWithoutNullStreams,
  SpawnOptionsWithoutStdio,
} from "node:child_process";
import { EventEmitter } from "node:events";
import { mkdir, mkdtemp, readFile, realpath, rm, stat, symlink } from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { PassThrough } from "node:stream";
import { test } from "node:test";
import { ClaudeCodeAdapter } from "../../../adapters/claude-code";
import { CodexCliAdapter } from "../../../adapters/codex-cli";
import type { RunHandle, RuntimeSpec } from "../../../lib/agent/types";
import type { SpawnImplementation } from "../src/contracts";
import { CliInstallationVerifier } from "../src/installation-verifier";
import { SecureRuntimeFileMaterializer } from "../src/runtime-files";
import { AgentExecutionSupervisor } from "../src/supervisor";

const RUN_ROOT = "/srv/deviludo/runs/run-1/attempt-1";
const WORKSPACE = `${RUN_ROOT}/workspace`;
const SECRET_REF = "vault://transit/run-token/run-1-attempt-1";
const SECRET_VALUE = "fixture-runtime-secret-934857";
const IMAGE_DIGEST = `sha256:${"a".repeat(64)}` as const;
const codexProbe = Object.freeze({
  agent: "codex-cli" as const,
  executable: "codex" as const,
  argv: Object.freeze(["--version"]),
  expectedVersion: "0.91.0",
  imageDigest: IMAGE_DIGEST,
});

const handle: RunHandle = Object.freeze({
  runId: "run-1",
  attemptId: "attempt-1",
  agent: "codex-cli",
  executorHandle: "worker-process-1",
});

test("spawns a fixed executable without a shell and collects redacted JSONL events", async () => {
  const harness = createHarness();
  const supervisor = makeSupervisor(harness.spawn, {
    PATH: "/opt/deviludo/bin:/usr/bin",
    LANG: "C.UTF-8",
    NODE_OPTIONS: "--require=/tmp/hostile.js",
    AWS_SECRET_ACCESS_KEY: "must-not-cross-the-boundary",
  });

  const run = await supervisor.start(request(runtime()));
  const secretEvent = JSON.stringify({ type: "warning", message: `token=${SECRET_VALUE}` });
  harness.child.stdout.write('{"type":"thread.started","thread_id":"session-1"}\n');
  harness.child.stdout.write(
    '{"type":"item.completed","item":{"type":"file_change","path":"src/game.gd"}}\n',
  );
  harness.child.stdout.write(`${secretEvent.slice(0, 27)}`);
  harness.child.stdout.write(`${secretEvent.slice(27)}\n`);
  harness.child.stdout.write(
    '{"type":"turn.completed","usage":{"input_tokens":12,"output_tokens":7,"cost_usd":0.04}}\n',
  );
  harness.child.stderr.write(`Authorization: Bearer ${SECRET_VALUE}`);
  harness.child.close(0, null);

  const execution = await run.completion;
  assert.equal(execution.status, "completed");
  assert.equal(execution.result.status, "completed");
  assert.deepEqual(execution.result.changedFiles, ["src/game.gd"]);
  assert.equal(execution.result.usage.inputTokens, 12);
  assert.equal(execution.diagnostics.stderr.includes(SECRET_VALUE), false);
  assert.match(execution.diagnostics.stderr, /\[REDACTED]/);
  assert.equal(JSON.stringify(execution).includes(SECRET_VALUE), false);

  assert.equal(harness.calls.length, 1);
  const call = harness.calls[0];
  assert.equal(call?.executable, "codex");
  assert.deepEqual(call?.args, ["exec", "--json", "-"]);
  assert.equal(call?.options.shell, false);
  assert.deepEqual(call?.options.stdio, ["pipe", "pipe", "pipe"]);
  assert.equal(call?.options.cwd, WORKSPACE);
  assert.equal(call?.options.env?.DEVILUDO_RUN_TOKEN, SECRET_VALUE);
  assert.equal(call?.options.env?.PATH, "/opt/deviludo/bin:/usr/bin");
  assert.equal(call?.options.env?.LANG, "C.UTF-8");
  assert.equal(call?.options.env?.NODE_OPTIONS, undefined);
  assert.equal(call?.options.env?.AWS_SECRET_ACCESS_KEY, undefined);
  assert.equal(harness.child.stdinText(), "implement the approved game specification");
});

test("applies the same supervisor contract to Claude Code stream-json output", async () => {
  const harness = createHarness();
  const supervisor = makeSupervisor(
    harness.spawn,
    { PATH: "/usr/bin", LANG: "C.UTF-8" },
    undefined,
    "ANTHROPIC_API_KEY",
  );
  const claudeHandle: RunHandle = Object.freeze({
    ...handle,
    agent: "claude-code",
    executorHandle: "worker-process-claude",
  });
  const runtimeSpec: RuntimeSpec = Object.freeze({
    executable: "claude",
    args: Object.freeze(["-p", "--output-format", "stream-json"]),
    cwd: WORKSPACE,
    stdin: '{"type":"user","message":{"role":"user","content":[]}}\n',
    env: Object.freeze({
      CLAUDE_CONFIG_DIR: `${RUN_ROOT}/claude-home`,
      ANTHROPIC_BASE_URL: "https://inference.internal.example/v1",
      ANTHROPIC_MODEL: "claude-sonnet-4-20260514",
      DISABLE_UPDATES: "1",
    }),
    secretEnv: Object.freeze({ ANTHROPIC_API_KEY: SECRET_REF }),
    files: Object.freeze([
      Object.freeze({
        relativePath: "claude-home/settings.json",
        contents: "{}",
        mode: 0o400 as const,
      }),
    ]),
    timeoutSeconds: 2,
    redactedArgIndexes: Object.freeze([]),
  });
  const run = await supervisor.start({
    adapter: new ClaudeCodeAdapter(),
    runHandle: claudeHandle,
    installationProbe: {
      agent: "claude-code",
      executable: "claude",
      argv: ["--version"],
      expectedVersion: "2.1.14",
      imageDigest: IMAGE_DIGEST,
    },
    runtimeSpec,
    workerRunRoot: RUN_ROOT,
    workspaceRoot: WORKSPACE,
  });
  harness.child.stdout.write(
    '{"type":"system","subtype":"init","session_id":"claude-session"}\n',
  );
  harness.child.stdout.write(
    '{"type":"result","subtype":"success","session_id":"claude-session","is_error":false,"total_cost_usd":0.05}\n',
  );
  harness.child.close(0, null);

  const execution = await run.completion;
  assert.equal(execution.status, "completed");
  assert.equal(execution.result.sessionId, "claude-session");
  assert.equal(harness.calls[0]?.executable, "claude");
  assert.equal(harness.calls[0]?.options.shell, false);
  assert.equal(harness.calls[0]?.options.env?.ANTHROPIC_API_KEY, SECRET_VALUE);
});

test("rejects workspace escapes, runtime file traversal and unapproved environment keys before spawn", async () => {
  const harness = createHarness();
  const supervisor = makeSupervisor(harness.spawn);

  await assert.rejects(
    supervisor.start(request(runtime({ cwd: "/srv/deviludo/another-project" }))),
    /Runtime cwd escapes/,
  );
  await assert.rejects(
    supervisor.start(
      request(
        runtime({
          files: [{ relativePath: "../stolen", contents: "x", mode: 0o400 }],
        }),
      ),
    ),
    /Runtime file path escapes/,
  );
  await assert.rejects(
    supervisor.start(
      request(runtime({ env: { ...runtime().env, NODE_OPTIONS: "--inspect" } })),
    ),
    /environment variable is not permitted: NODE_OPTIONS/,
  );
  await assert.rejects(
    supervisor.start(request(runtime({ args: ["exec", "--json", "/etc/passwd"] }))),
    /Runtime argument path escapes/,
  );
  await assert.rejects(
    supervisor.start(request(runtime({ args: ["exec", "--yolo", "-"] }))),
    /bypasses the worker security policy/,
  );
  await assert.rejects(
    supervisor.start(
      request(
        runtime({
          env: {
            ...runtime().env,
            CODEX_HOME: "/srv/deviludo/another-run/codex-home",
          },
        }),
      ),
    ),
    /CODEX_HOME path escapes/,
  );
  assert.equal(harness.calls.length, 0);
});

test("requires opaque SecretRefs and never resolves secrets for an invalid request", async () => {
  const harness = createHarness();
  let resolutions = 0;
  const supervisor = new AgentExecutionSupervisor({
    spawn: harness.spawn,
    secretResolver: {
      async resolve() {
        resolutions += 1;
        return SECRET_VALUE;
      },
    },
    hostEnvironment: { PATH: "/usr/bin" },
  });

  await assert.rejects(
    supervisor.start(
      request(runtime({ secretEnv: { DEVILUDO_RUN_TOKEN: "plaintext-token" } })),
    ),
    /opaque SecretRef/,
  );
  assert.equal(resolutions, 0);
  assert.equal(harness.calls.length, 0);
});

test("cancellation is idempotent and terminates with SIGTERM", async () => {
  const harness = createHarness(true);
  const supervisor = makeSupervisor(harness.spawn);
  const run = await supervisor.start(request(runtime({ timeoutSeconds: 30 })));

  assert.equal(run.cancel(), true);
  assert.equal(run.cancel(), false);
  const execution = await run.completion;
  assert.equal(execution.status, "cancelled");
  assert.equal(execution.result.status, "cancelled");
  assert.equal(execution.diagnostics.cancelled, true);
  assert.deepEqual(harness.child.signals, ["SIGTERM"]);
});

test("timeout terminates the process and is distinguished from user cancellation", async () => {
  const harness = createHarness(true);
  const supervisor = makeSupervisor(harness.spawn);
  const run = await supervisor.start(request(runtime({ timeoutSeconds: 0.01 })));
  const execution = await run.completion;

  assert.equal(execution.status, "timed_out");
  assert.equal(execution.result.status, "failed");
  assert.equal(execution.diagnostics.timedOut, true);
  assert.equal(execution.diagnostics.cancelled, false);
  assert.match(execution.events.at(-1)?.message ?? "", /timed out/);
  assert.deepEqual(harness.child.signals, ["SIGTERM"]);
});

test("non-zero exits, malformed output and oversized lines yield bounded diagnostics", async () => {
  const harness = createHarness();
  const supervisor = makeSupervisor(harness.spawn, undefined, {
    maxJsonLineBytes: 128,
    maxStderrBytes: 256,
  });
  const run = await supervisor.start(request(runtime()));
  harness.child.stdout.write(`${"x".repeat(256)}\n`);
  harness.child.stdout.write("not-json\n");
  harness.child.stderr.write(
    `api_key=${SECRET_VALUE} ${"z".repeat(220)} ${SECRET_VALUE}`,
  );
  harness.child.close(7, null);

  const execution = await run.completion;
  assert.equal(execution.status, "failed");
  assert.equal(execution.diagnostics.exitCode, 7);
  assert.equal(execution.diagnostics.droppedJsonLines, 1);
  assert.ok(execution.diagnostics.stderr.length <= 256);
  assert.equal(execution.diagnostics.stderr.includes(SECRET_VALUE), false);
  assert.equal(execution.diagnostics.stderr.includes(SECRET_VALUE.slice(0, 8)), false);
  assert.equal(execution.diagnostics.adapter.warningCount, 1);
  assert.match(execution.events.at(-1)?.message ?? "", /code 7/);
});

test("verifies the pinned installation and materializes runtime files before resolving a secret", async () => {
  const harness = createHarness();
  const order: string[] = [];
  const supervisor = new AgentExecutionSupervisor({
    spawn(executable, args, options) {
      order.push("spawn");
      return harness.spawn(executable, args, options);
    },
    installationVerifier: {
      async verify(plan) {
        order.push("probe");
        return { agent: plan.agent, executable: plan.executable, expectedVersion: plan.expectedVersion, observedVersion: plan.expectedVersion, imageDigest: plan.imageDigest };
      },
    },
    runtimeFileMaterializer: {
      async materialize() { order.push("files"); },
    },
    secretResolver: {
      async resolve() {
        order.push("secret");
        return SECRET_VALUE;
      },
    },
    hostEnvironment: { PATH: "/usr/bin" },
  });
  const run = await supervisor.start(request(runtime()));
  assert.deepEqual(order, ["probe", "files", "secret", "spawn"]);
  harness.child.stdout.write('{"type":"turn.completed"}\n');
  harness.child.close(0, null);
  assert.equal((await run.completion).status, "completed");
});

test("installation mismatch stops before files, secrets, or Agent process creation", async () => {
  const harness = createHarness();
  let materializations = 0;
  let resolutions = 0;
  const supervisor = new AgentExecutionSupervisor({
    spawn: harness.spawn,
    installationVerifier: { async verify() { throw new Error("Installed Agent CLI version mismatch: expected 0.91.0, observed 0.92.0"); } },
    runtimeFileMaterializer: { async materialize() { materializations += 1; } },
    secretResolver: { async resolve() { resolutions += 1; return SECRET_VALUE; } },
    hostEnvironment: { PATH: "/usr/bin" },
  });
  await assert.rejects(supervisor.start(request(runtime())), /version mismatch/);
  assert.equal(materializations, 0);
  assert.equal(resolutions, 0);
  assert.equal(harness.calls.length, 0);
});

test("CLI installation verifier accepts only the exact fixed version command", async () => {
  const calls: string[] = [];
  const verifier = new CliInstallationVerifier({
    hostEnvironment: { PATH: "/opt/agents/bin", NODE_OPTIONS: "--inspect", AWS_SECRET_ACCESS_KEY: "no" },
    observedImageDigest: IMAGE_DIGEST,
    async run(executable, argv, options) {
      calls.push(`${executable} ${argv.join(" ")}`);
      assert.equal(options.env.PATH, "/opt/agents/bin");
      assert.equal(options.env.NODE_OPTIONS, undefined);
      assert.equal(options.env.AWS_SECRET_ACCESS_KEY, undefined);
      return { stdout: "codex-cli 0.91.0", stderr: "" };
    },
  });
  const verified = await verifier.verify(codexProbe);
  assert.equal(verified.observedVersion, "0.91.0");
  assert.deepEqual(calls, ["codex --version"]);
  await assert.rejects(verifier.verify({ ...codexProbe, expectedVersion: "0.92.0" }), /version mismatch/);
  await assert.rejects(verifier.verify({ ...codexProbe, argv: ["--help"] }), /fixed --version/);
  const wrongImage = new CliInstallationVerifier({
    observedImageDigest: `sha256:${"b".repeat(64)}`,
    async run() { throw new Error("must not execute"); },
  });
  await assert.rejects(wrongImage.verify(codexProbe), /image digest/);
  const missingImage = new CliInstallationVerifier({
    hostEnvironment: { PATH: "/usr/bin" },
    async run() { throw new Error("must not execute"); },
  });
  await assert.rejects(missingImage.verify(codexProbe), /image identity/);
});

test("runtime file materializer creates immutable files and rejects overwrite or symlink parents", async () => {
  const temporaryInput = await mkdtemp(path.join(os.tmpdir(), "deviludo-agent-files-"));
  const temporary = await realpath(temporaryInput);
  const runRoot = path.join(temporary, "attempt");
  const outside = path.join(temporary, "outside");
  await mkdir(runRoot, { recursive: true });
  await mkdir(outside, { recursive: true });
  const materializer = new SecureRuntimeFileMaterializer();
  try {
    await materializer.materialize(runRoot, [{ relativePath: "codex-home/config.toml", contents: "locked=true\n", mode: 0o600 }]);
    const target = path.join(runRoot, "codex-home/config.toml");
    assert.equal(await readFile(target, "utf8"), "locked=true\n");
    assert.equal((await stat(target)).mode & 0o777, 0o600);
    await assert.rejects(
      materializer.materialize(runRoot, [{ relativePath: "codex-home/config.toml", contents: "replace=true\n", mode: 0o600 }]),
      /could not be materialized/,
    );
    assert.equal(await readFile(target, "utf8"), "locked=true\n");

    await symlink(outside, path.join(runRoot, "linked"), "dir");
    await assert.rejects(
      materializer.materialize(runRoot, [{ relativePath: "linked/secret", contents: "x", mode: 0o400 }]),
      /symbolic links/,
    );
  } finally {
    await rm(temporary, { recursive: true, force: true });
  }
});

interface SpawnCall {
  readonly executable: string;
  readonly args: readonly string[];
  readonly options: SpawnOptionsWithoutStdio;
}

function createHarness(autoCloseOnKill = false) {
  const child = new FakeChild(autoCloseOnKill);
  const calls: SpawnCall[] = [];
  const spawn: SpawnImplementation = (executable, args, options) => {
    calls.push({ executable, args: [...args], options });
    return child as unknown as ChildProcessWithoutNullStreams;
  };
  return { child, calls, spawn };
}

class FakeChild extends EventEmitter {
  readonly stdin = new PassThrough();
  readonly stdout = new PassThrough();
  readonly stderr = new PassThrough();
  readonly signals: NodeJS.Signals[] = [];
  readonly #stdinChunks: Buffer[] = [];
  readonly #autoCloseOnKill: boolean;

  constructor(autoCloseOnKill: boolean) {
    super();
    this.#autoCloseOnKill = autoCloseOnKill;
    this.stdin.on("data", (chunk: Buffer) => this.#stdinChunks.push(Buffer.from(chunk)));
  }

  kill(signal: NodeJS.Signals = "SIGTERM"): boolean {
    this.signals.push(signal);
    if (this.#autoCloseOnKill) queueMicrotask(() => this.close(null, signal));
    return true;
  }

  close(code: number | null, signal: NodeJS.Signals | null): void {
    this.stdout.end();
    this.stderr.end();
    this.emit("close", code, signal);
  }

  stdinText(): string {
    return Buffer.concat(this.#stdinChunks).toString("utf8");
  }
}

function makeSupervisor(
  spawn: SpawnImplementation,
  hostEnvironment: Readonly<Record<string, string | undefined>> = {
    PATH: "/usr/bin",
    LANG: "C.UTF-8",
  },
  limits?: { readonly maxJsonLineBytes?: number; readonly maxStderrBytes?: number },
  expectedSecretVariable = "DEVILUDO_RUN_TOKEN",
): AgentExecutionSupervisor {
  return new AgentExecutionSupervisor({
    spawn,
    secretResolver: {
      async resolve(secretRef, context) {
        assert.equal(secretRef, SECRET_REF);
        assert.equal(context.runId, handle.runId);
        assert.equal(context.attemptId, handle.attemptId);
        assert.equal(context.environmentVariable, expectedSecretVariable);
        return SECRET_VALUE;
      },
    },
    hostEnvironment,
    limits,
    installationVerifier: {
      async verify(plan) {
        return {
          agent: plan.agent,
          executable: plan.executable,
          expectedVersion: plan.expectedVersion,
          observedVersion: plan.expectedVersion,
          imageDigest: plan.imageDigest,
        };
      },
    },
    runtimeFileMaterializer: { async materialize() {} },
  });
}

function request(runtimeSpec: RuntimeSpec) {
  return {
    adapter: new CodexCliAdapter(),
    runHandle: handle,
    installationProbe: codexProbe,
    runtimeSpec,
    workerRunRoot: RUN_ROOT,
    workspaceRoot: WORKSPACE,
  } as const;
}

function runtime(overrides: Partial<RuntimeSpec> = {}): RuntimeSpec {
  return Object.freeze({
    executable: "codex" as const,
    args: Object.freeze(["exec", "--json", "-"]),
    cwd: WORKSPACE,
    stdin: "implement the approved game specification",
    env: Object.freeze({
      CODEX_HOME: `${RUN_ROOT}/codex-home`,
      DEVILUDO_AGENT_UPDATE_POLICY: "immutable-image-only",
    }),
    secretEnv: Object.freeze({ DEVILUDO_RUN_TOKEN: SECRET_REF }),
    files: Object.freeze([
      Object.freeze({
        relativePath: "codex-home/config.toml",
        contents: "model_provider = \"deviludo_gateway\"",
        mode: 0o600 as const,
        redactFromDiagnostics: true,
      }),
    ]),
    timeoutSeconds: 2,
    redactedArgIndexes: Object.freeze([]),
    ...overrides,
  });
}
