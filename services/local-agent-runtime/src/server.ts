import { createServer, type IncomingMessage, type Server, type ServerResponse } from "node:http";
import { pathToFileURL } from "node:url";
import type { CliVersionInspector } from "./readiness";
import type {
  LocalAgentCancellationRequest,
  LocalAgentExecutionRequest,
  LocalAgentExecutor,
  LocalAgentPreflightRequest,
  LocalProviderBindingVerifier,
} from "./contracts";
import {
  LocalAgentExecutionRequestError,
  LocalAgentExecutionService,
  LocalAgentRunCancelledError,
} from "./execution";
import { LocalAgentReadinessService } from "./readiness";
import {
  LocalProviderControl,
  LocalProviderBindingConflictError,
  LocalProviderControlConflictError,
  LocalProviderControlInputError,
  LocalProviderProbeError,
} from "./provider-control";
import {
  LocalAgentRuntimeAuthenticationError,
  LocalAgentRuntimeRequestVerifier,
  localAgentRuntimeKeyFromEnvironment,
} from "./request-auth";
import { localExecutionStackFromEnvironment, type LocalExecutionStack } from "./local-execution-stack";

const HOST = "127.0.0.1";
type Environment = Readonly<Record<string, string | undefined>>;

export interface LocalAgentRuntimeDependencies {
  readonly cliVersionInspector?: CliVersionInspector;
  readonly providerBindingVerifier?: LocalProviderBindingVerifier;
  readonly providerControl?: LocalProviderControl;
  readonly executor?: LocalAgentExecutor;
}

export interface LocalAgentRuntime {
  readonly host: typeof HOST;
  readonly port: number;
  readonly readiness: LocalAgentReadinessService;
  readonly execution: LocalAgentExecutionService;
  readonly providerControl: LocalProviderControl | null;
  readonly executionStack: LocalExecutionStack | null;
  readonly server: Server;
}

export function localAgentRuntimeFromEnvironment(
  env: Environment = process.env,
  dependencies: LocalAgentRuntimeDependencies = {},
): LocalAgentRuntime {
  const port = environmentPort(env.DEVILUDO_LOCAL_AGENT_RUNTIME_PORT);
  const requestVerifier = new LocalAgentRuntimeRequestVerifier(localAgentRuntimeKeyFromEnvironment(env));
  const providerControl = dependencies.providerControl
    ?? (env.DEVILUDO_LOCAL_TEST_MODE === "1" && env.DEVILUDO_LOCAL_PROVIDER_CONTROL === "1"
      ? new LocalProviderControl()
      : null);
  const executionStack = dependencies.executor
    ? null
    : localExecutionStackFromEnvironment(env, providerControl);
  const readiness = new LocalAgentReadinessService({
    inspector: dependencies.cliVersionInspector,
    claudeVersion: env.DEVILUDO_LOCAL_CLAUDE_EXPECTED_VERSION,
    codexVersion: env.DEVILUDO_LOCAL_CODEX_EXPECTED_VERSION,
    executionEnabled: env.DEVILUDO_LOCAL_AGENT_EXECUTION === "1",
    inferenceGatewayUrl: env.DEVILUDO_LOCAL_INFERENCE_GATEWAY_URL,
    workerImageIdentity: env.DEVILUDO_WORKER_IMAGE_DIGEST,
    expectedWorkerImageIdentity: env.DEVILUDO_LOCAL_EXPECTED_WORKER_IMAGE_DIGEST,
    localDeterministicWorkerAttestation: env.DEVILUDO_LOCAL_TEST_MODE === "1"
      && env.DEVILUDO_LOCAL_DETERMINISTIC_WORKER_ATTESTATION === "1",
    allowLocalLoopbackInferenceGateway: executionStack !== null,
    providerBindingVerifier: dependencies.providerBindingVerifier ?? providerControl ?? undefined,
  });
  const execution = new LocalAgentExecutionService({
    readiness,
    executor: dependencies.executor ?? executionStack?.executor,
  });
  const server = createServer((request, response) => route(request, response, { requestVerifier, readiness, execution, providerControl }));
  return Object.freeze({ host: HOST, port, readiness, execution, providerControl, executionStack, server });
}

export async function runLocalAgentRuntime(
  env: Environment = process.env,
  dependencies: LocalAgentRuntimeDependencies = {},
): Promise<void> {
  const runtime = localAgentRuntimeFromEnvironment(env, dependencies);
  try {
    if (runtime.executionStack) {
      await runtime.executionStack.gateway.listen({
        host: runtime.executionStack.gatewayHost,
        port: runtime.executionStack.gatewayPort,
      });
    }
    await listen(runtime.server, runtime.port, runtime.host);
  } catch (error) {
    if (runtime.executionStack) {
      await runtime.executionStack.relay.close();
      try { await runtime.executionStack.gateway.close(); }
      catch { /* The Gateway may have failed before it acquired a listener. */ }
      runtime.executionStack.authority.close();
    }
    throw error;
  }
  console.log(`[local-agent-runtime] Ready at http://${runtime.host}:${runtime.port}`);
  const shutdown = new AbortController();
  const stop = () => shutdown.abort();
  process.once("SIGINT", stop);
  process.once("SIGTERM", stop);
  try {
    await new Promise<void>((resolve) => {
      shutdown.signal.addEventListener("abort", () => resolve(), { once: true });
    });
  } finally {
    process.removeListener("SIGINT", stop);
    process.removeListener("SIGTERM", stop);
    runtime.execution.cancelAll();
    if (runtime.executionStack) {
      await runtime.executionStack.relay.close();
      await runtime.executionStack.gateway.close();
      runtime.executionStack.authority.close();
    }
    runtime.providerControl?.close();
    await close(runtime.server);
  }
}

async function route(
  request: IncomingMessage,
  response: ServerResponse,
  runtime: Readonly<{
    requestVerifier: LocalAgentRuntimeRequestVerifier;
    readiness: LocalAgentReadinessService;
    execution: LocalAgentExecutionService;
    providerControl: LocalProviderControl | null;
  }>,
): Promise<void> {
  try {
    const url = new URL(request.url ?? "/", `http://${HOST}`);
    if (request.method === "GET" && url.pathname === "/health" && !url.search) {
      json(response, 200, await runtime.readiness.health());
      return;
    }
    if (request.method === "POST" && url.pathname === "/v1/preflight" && !url.search) {
      const command = await readPreflightRequest(request, "/v1/preflight", runtime.requestVerifier);
      let preflight;
      try { preflight = await runtime.readiness.preflight(command); }
      catch { throw new LocalRequestError("Local Agent preflight validation failed"); }
      json(response, 200, { data: preflight });
      return;
    }
    if (request.method === "POST" && url.pathname === "/v1/runs" && !url.search) {
      const command = await readExecutionRequest(request, "/v1/runs", runtime.requestVerifier);
      const disconnected = new AbortController();
      const abort = () => {
        if (!response.writableEnded) disconnected.abort();
      };
      request.once("aborted", abort);
      response.once("close", abort);
      const outcome = await runtime.execution.execute(command, disconnected.signal).finally(() => {
        request.removeListener("aborted", abort);
        response.removeListener("close", abort);
      });
      if (outcome.state === "BLOCKED") {
        json(response, 409, { error: { code: outcome.preflight.code, message: outcome.preflight.message }, data: { preflight: outcome.preflight } });
        return;
      }
      if (outcome.state === "EXECUTOR_NOT_CONFIGURED") {
        json(response, 503, { error: { code: "LOCAL_AGENT_EXECUTOR_NOT_CONFIGURED", message: "Local Agent executor is not configured; no process was started" } });
        return;
      }
      json(response, 201, { data: outcome.receipt });
      return;
    }
    if (request.method === "POST" && url.pathname === "/v1/runs/cancel" && !url.search) {
      const command = await readCancellationRequest(request, "/v1/runs/cancel", runtime.requestVerifier);
      const outcome = runtime.execution.cancel(command);
      json(response, outcome.state === "CANCELLATION_REQUESTED" ? 202 : 200, { data: outcome });
      return;
    }
    if (request.method === "POST" && url.pathname === "/v1/provider-credentials" && !url.search) {
      requireProviderControl(runtime.providerControl);
      const command = await readObject(request, "/v1/provider-credentials", runtime.requestVerifier);
      json(response, 201, { data: runtime.providerControl!.putCredential(command) });
      return;
    }
    if (request.method === "POST" && url.pathname === "/v1/provider-credentials/revoke" && !url.search) {
      requireProviderControl(runtime.providerControl);
      const command = await readObject(request, "/v1/provider-credentials/revoke", runtime.requestVerifier);
      json(response, 200, { data: runtime.providerControl!.revokeCredential(command) });
      return;
    }
    if (request.method === "POST" && url.pathname === "/v1/provider-probes" && !url.search) {
      requireProviderControl(runtime.providerControl);
      const command = await readObject(request, "/v1/provider-probes", runtime.requestVerifier);
      json(response, 200, { data: await runtime.providerControl!.probe(command) });
      return;
    }
    if (request.method === "POST" && url.pathname === "/v1/provider-bindings/rebind" && !url.search) {
      requireProviderControl(runtime.providerControl);
      const command = await readObject(request, "/v1/provider-bindings/rebind", runtime.requestVerifier);
      json(response, 200, { data: runtime.providerControl!.rebind(command) });
      return;
    }
    if (request.method === "POST" && url.pathname === "/v1/provider-bindings/check" && !url.search) {
      requireProviderControl(runtime.providerControl);
      const command = await readObject(request, "/v1/provider-bindings/check", runtime.requestVerifier);
      json(response, 200, { data: runtime.providerControl!.checkBinding(command) });
      return;
    }
    if (request.method === "POST" && url.pathname === "/v1/provider-bindings/activate" && !url.search) {
      requireProviderControl(runtime.providerControl);
      const command = await readObject(request, "/v1/provider-bindings/activate", runtime.requestVerifier);
      json(response, 200, { data: runtime.providerControl!.activate(command) });
      return;
    }
    if (request.method === "POST" && url.pathname === "/v1/provider-bindings/disable" && !url.search) {
      requireProviderControl(runtime.providerControl);
      const command = await readObject(request, "/v1/provider-bindings/disable", runtime.requestVerifier);
      json(response, 200, { data: runtime.providerControl!.disable(command) });
      return;
    }
    json(response, 404, { error: { code: "NOT_FOUND", message: "Local Agent runtime route not found" } });
  } catch (error) {
    if (error instanceof LocalAgentRuntimeAuthenticationError) {
      json(response, 403, { error: { code: "LOCAL_AGENT_RUNTIME_AUTH_REQUIRED", message: "Authenticated local Agent runtime request is required" } });
      return;
    }
    if (error instanceof LocalAgentRunCancelledError) {
      json(response, 409, { error: { code: "LOCAL_AGENT_RUN_CANCELLED", message: "Local Agent run was cancelled" } });
      return;
    }
    if (error instanceof LocalProviderControlInputError) {
      json(response, 400, { error: { code: "INVALID_LOCAL_PROVIDER_REQUEST", message: "Local Provider request is invalid" } });
      return;
    }
    if (error instanceof LocalProviderControlConflictError) {
      json(response, 409, { error: { code: "LOCAL_CREDENTIAL_VERSION_CONFLICT", message: "Credential version already exists with different material" } });
      return;
    }
    if (error instanceof LocalProviderBindingConflictError) {
      json(response, 409, { error: { code: "LOCAL_PROVIDER_BINDING_CONFLICT", message: "Provider binding successor conflicts with existing immutable lineage" } });
      return;
    }
    if (error instanceof LocalProviderProbeError) {
      json(response, 422, { error: { code: "LOCAL_PROVIDER_PROBE_FAILED", message: "Provider compatibility probe failed" } });
      return;
    }
    const invalidRequest = error instanceof LocalRequestError || error instanceof LocalAgentExecutionRequestError;
    json(response, invalidRequest ? 400 : 500, { error: { code: invalidRequest ? "INVALID_LOCAL_AGENT_REQUEST" : "LOCAL_AGENT_RUNTIME_FAILED", message: invalidRequest ? "Local Agent request is invalid" : "Local Agent runtime request failed" } });
  }
}

class LocalRequestError extends Error {}

function requireProviderControl(value: LocalProviderControl | null): asserts value is LocalProviderControl {
  if (!value) throw new LocalProviderProbeError("Local Provider control is not enabled");
}

async function readPreflightRequest(
  request: IncomingMessage,
  path: LocalAgentRuntimeAssertionPath,
  verifier: LocalAgentRuntimeRequestVerifier,
): Promise<LocalAgentPreflightRequest> {
  const item = await readObject(request, path, verifier);
  exactKeys(item, [
    "adapterVersion", "agent", "credentialVersionId", "expectedVersion", "imageDigest", "installationId",
    "model", "modelRoles", "profileRevisionId", "projectId", "providerRevisionId", "runId",
  ]);
  return preflightFrom(item);
}

async function readExecutionRequest(
  request: IncomingMessage,
  path: LocalAgentRuntimeAssertionPath,
  verifier: LocalAgentRuntimeRequestVerifier,
): Promise<LocalAgentExecutionRequest> {
  return parseLocalAgentExecutionRequest(await readObject(request, path, verifier));
}

export function parseLocalAgentExecutionRequest(value: unknown): LocalAgentExecutionRequest {
  if (!value || typeof value !== "object" || Array.isArray(value)) {
    throw new LocalRequestError("Local Agent execution request is invalid");
  }
  const item = value as Record<string, unknown>;
  exactKeys(item, [
    "adapterVersion", "agent", "attemptId", "budget", "credentialVersionId", "expectedVersion",
    "imageDigest", "installationId", "model", "modelRoles", "profileRevisionId", "projectId",
    "prompt", "promptDigest", "providerProtocol", "providerRevisionId", "runId", "specRevisionId",
    "tenantId", "testPlanRevisionId", "timeoutSeconds",
  ]);
  return {
    ...preflightFrom(item),
    tenantId: requireString(item.tenantId),
    attemptId: requireString(item.attemptId),
    specRevisionId: requireString(item.specRevisionId),
    testPlanRevisionId: requireString(item.testPlanRevisionId),
    installationId: requireString(item.installationId),
    adapterVersion: requireString(item.adapterVersion),
    providerProtocol: requireProtocol(item.providerProtocol),
    budget: requireBudget(item.budget),
    timeoutSeconds: requireInteger(item.timeoutSeconds),
    promptDigest: requireSha256(item.promptDigest),
    prompt: requireString(item.prompt, 64 * 1024),
  };
}

export function parseLocalAgentCancellationRequest(value: unknown): LocalAgentCancellationRequest {
  if (!value || typeof value !== "object" || Array.isArray(value)) {
    throw new LocalRequestError("Local Agent cancellation request is invalid");
  }
  const item = value as Record<string, unknown>;
  exactKeys(item, ["attemptId", "projectId", "reason", "runId", "tenantId"]);
  return {
    tenantId: requireString(item.tenantId),
    projectId: requireString(item.projectId),
    runId: requireString(item.runId),
    attemptId: requireString(item.attemptId),
    reason: requireString(item.reason, 2_000),
  };
}

type LocalAgentRuntimeAssertionPath = "/v1/preflight" | "/v1/runs" | "/v1/runs/cancel"
  | "/v1/provider-credentials" | "/v1/provider-credentials/revoke" | "/v1/provider-probes"
  | "/v1/provider-bindings/check" | "/v1/provider-bindings/rebind"
  | "/v1/provider-bindings/activate" | "/v1/provider-bindings/disable";

async function readCancellationRequest(
  request: IncomingMessage,
  path: "/v1/runs/cancel",
  verifier: LocalAgentRuntimeRequestVerifier,
): Promise<LocalAgentCancellationRequest> {
  return parseLocalAgentCancellationRequest(await readObject(request, path, verifier));
}

async function readObject(
  request: IncomingMessage,
  path: LocalAgentRuntimeAssertionPath,
  verifier: LocalAgentRuntimeRequestVerifier,
): Promise<Record<string, unknown>> {
  if (!String(request.headers["content-type"] ?? "").toLowerCase().startsWith("application/json")) {
    throw new LocalRequestError("Local Agent request requires JSON");
  }
  const chunks: Buffer[] = [];
  let size = 0;
  for await (const chunk of request) {
    const buffer = Buffer.isBuffer(chunk) ? chunk : Buffer.from(chunk);
    size += buffer.byteLength;
    if (size > 128 * 1024) throw new LocalRequestError("Local Agent request body is too large");
    chunks.push(buffer);
  }
  const body = Buffer.concat(chunks);
  verifier.verify({ method: "POST", path, body, headers: request.headers });
  let value: unknown;
  try { value = JSON.parse(body.toString("utf8")); }
  catch { throw new LocalRequestError("Local Agent request body is invalid"); }
  if (!value || typeof value !== "object" || Array.isArray(value)) throw new LocalRequestError("Local Agent request body is invalid");
  return value as Record<string, unknown>;
}

function preflightFrom(item: Record<string, unknown>): LocalAgentPreflightRequest {
  return {
    projectId: requireString(item.projectId),
    runId: requireString(item.runId),
    profileRevisionId: requireString(item.profileRevisionId),
    installationId: requireString(item.installationId),
    agent: requireAgent(item.agent),
    expectedVersion: requireString(item.expectedVersion),
    imageDigest: requireString(item.imageDigest),
    adapterVersion: requireString(item.adapterVersion),
    providerRevisionId: requireString(item.providerRevisionId),
    credentialVersionId: requireString(item.credentialVersionId),
    model: requireString(item.model),
    modelRoles: requireModelRoles(item.modelRoles),
  };
}

function requireModelRoles(value: unknown): LocalAgentPreflightRequest["modelRoles"] {
  if (!value || typeof value !== "object" || Array.isArray(value)) throw new LocalRequestError("Local Agent model roles are invalid");
  const roles = value as Record<string, unknown>;
  if (JSON.stringify(Object.keys(roles).sort()) !== JSON.stringify([
    "planningModel", "primaryModel", "smallFastModel", "subagentModel",
  ])) throw new LocalRequestError("Local Agent model roles are invalid");
  return Object.freeze({
    primaryModel: requireString(roles.primaryModel, 200),
    planningModel: requireString(roles.planningModel, 200),
    smallFastModel: requireString(roles.smallFastModel, 200),
    subagentModel: requireString(roles.subagentModel, 200),
  });
}

function requireString(value: unknown, max = 512): string {
  if (typeof value !== "string" || !value || value.length > max || value.includes("\0")) throw new LocalRequestError("Local Agent request field is invalid");
  return value;
}

function requireAgent(value: unknown): "claude-code" | "codex-cli" {
  if (value !== "claude-code" && value !== "codex-cli") throw new LocalRequestError("Local Agent preflight Agent is invalid");
  return value;
}

function requireProtocol(value: unknown): LocalAgentExecutionRequest["providerProtocol"] {
  if (value !== "anthropic-messages" && value !== "openai-responses") throw new LocalRequestError("Local Agent protocol is invalid");
  return value;
}

function requireBudget(value: unknown): LocalAgentExecutionRequest["budget"] {
  if (!value || typeof value !== "object" || Array.isArray(value)) throw new LocalRequestError("Local Agent budget is invalid");
  const budget = value as Record<string, unknown>;
  exactKeys(budget, ["maxCostUsd", "maxInputTokens", "maxOutputTokens", "maxTurns"]);
  return {
    maxTurns: requireInteger(budget.maxTurns),
    maxCostUsd: requireNumber(budget.maxCostUsd),
    maxInputTokens: requireInteger(budget.maxInputTokens),
    maxOutputTokens: requireInteger(budget.maxOutputTokens),
  };
}

function exactKeys(value: Record<string, unknown>, expected: readonly string[]): void {
  if (JSON.stringify(Object.keys(value).sort()) !== JSON.stringify([...expected].sort())) {
    throw new LocalRequestError("Local Agent request shape is invalid");
  }
}

function requireInteger(value: unknown): number {
  if (!Number.isSafeInteger(value)) throw new LocalRequestError("Local Agent integer field is invalid");
  return value as number;
}

function requireNumber(value: unknown): number {
  if (typeof value !== "number" || !Number.isFinite(value)) throw new LocalRequestError("Local Agent number field is invalid");
  return value;
}

function requireSha256(value: unknown): string {
  if (typeof value !== "string" || !/^[a-f0-9]{64}$/.test(value)) {
    throw new LocalRequestError("Local Agent digest field is invalid");
  }
  return value;
}

function environmentPort(value: string | undefined): number {
  const raw = value ?? "4312";
  if (!/^\d+$/.test(raw)) throw new Error("DEVILUDO_LOCAL_AGENT_RUNTIME_PORT is invalid");
  const port = Number(raw);
  if (!Number.isSafeInteger(port) || port < 1024 || port > 65_535) throw new Error("DEVILUDO_LOCAL_AGENT_RUNTIME_PORT is invalid");
  return port;
}

function json(response: ServerResponse, status: number, body: unknown): void {
  response.statusCode = status;
  response.setHeader("content-type", "application/json; charset=utf-8");
  response.setHeader("cache-control", "no-store");
  response.setHeader("x-content-type-options", "nosniff");
  response.end(JSON.stringify(body));
}

function listen(server: Server, port: number, host: string): Promise<void> {
  return new Promise((resolve, reject) => {
    const fail = (error: Error) => { server.off("listening", ready); reject(error); };
    const ready = () => { server.off("error", fail); resolve(); };
    server.once("error", fail);
    server.once("listening", ready);
    server.listen(port, host);
  });
}

function close(server: Server): Promise<void> {
  return new Promise((resolve, reject) => server.close((error) => error ? reject(error) : resolve()));
}

if (process.argv[1] && import.meta.url === pathToFileURL(process.argv[1]).href) {
  await runLocalAgentRuntime();
}
