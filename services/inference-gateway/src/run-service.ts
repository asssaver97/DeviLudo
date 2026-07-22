import { constants } from "node:fs";
import { open } from "node:fs/promises";
import { isAbsolute, resolve } from "node:path";
import { pathToFileURL } from "node:url";
import { postgresWorkflowPoolFromEnv } from "../../temporal/src/node-postgres";
import { MtlsGatewayCredentialResolver } from "./credential-broker";
import { NodeGatewayDnsResolver } from "./dns-resolver";
import { buildInferenceGateway } from "./http";
import { inferenceGatewayRegistries, PostgresInferenceGatewayStore } from "./postgres-store";
import { ProductionGatewayConnector } from "./production-connector";
import { GatewayProbeSpiffeAuthorizer, StrictGatewayProviderProbe } from "./provider-probe";
import { StrictGatewayInferenceReconciliation } from "./reconciliation";

const MAX_SECRET_BYTES = 1024 * 1024;

export async function inferenceGatewayServiceFromEnv(
  env: Readonly<Record<string, string | undefined>> = process.env,
) {
  if (env.NODE_ENV !== "production") throw new Error("Inference Gateway production service requires NODE_ENV=production");
  const [serverKey, serverCertificate, serverClientCa, signingKey, brokerKey, brokerCertificate, brokerCa] = await Promise.all([
    secretFile(env, "DEVILUDO_INFERENCE_GATEWAY_TLS_KEY_FILE", 32, MAX_SECRET_BYTES),
    secretFile(env, "DEVILUDO_INFERENCE_GATEWAY_TLS_CERT_FILE", 32, MAX_SECRET_BYTES),
    secretFile(env, "DEVILUDO_INFERENCE_GATEWAY_CLIENT_CA_FILE", 32, MAX_SECRET_BYTES),
    secretFile(env, "DEVILUDO_INFERENCE_GATEWAY_RUN_TOKEN_KEY_FILE", 32, 128),
    secretFile(env, "DEVILUDO_INFERENCE_CREDENTIAL_BROKER_TLS_KEY_FILE", 32, MAX_SECRET_BYTES),
    secretFile(env, "DEVILUDO_INFERENCE_CREDENTIAL_BROKER_TLS_CERT_FILE", 32, MAX_SECRET_BYTES),
    secretFile(env, "DEVILUDO_INFERENCE_CREDENTIAL_BROKER_CA_FILE", 32, MAX_SECRET_BYTES),
  ]);
  const serviceEnv = Object.freeze({ ...env, DEVILUDO_WORKFLOW_DESTINATION: "inference-gateway" });
  const pool = postgresWorkflowPoolFromEnv(serviceEnv);
  try {
    const store = new PostgresInferenceGatewayStore(pool);
    const registries = inferenceGatewayRegistries(store);
    const dns = new NodeGatewayDnsResolver();
    const credentials = new MtlsGatewayCredentialResolver({
      endpoint: required(env, "DEVILUDO_INFERENCE_CREDENTIAL_BROKER_URL"),
      tls: { key: brokerKey, certificate: brokerCertificate, ca: brokerCa },
      timeoutMs: seconds(env.DEVILUDO_INFERENCE_CREDENTIAL_BROKER_TIMEOUT_SECONDS, 10, 1, 60) * 1_000,
    });
    const connector = new ProductionGatewayConnector({ credentials, usage: registries.usage, dns });
    const readiness = Object.freeze({
      async probe(): Promise<void> { await Promise.all([store.probe(), connector.probe()]); },
    });
    const providerProbe = new StrictGatewayProviderProbe({ credentials, dns });
    const probeAuthorizer = new GatewayProbeSpiffeAuthorizer(
      spiffeIds(required(env, "DEVILUDO_INFERENCE_GATEWAY_PROBE_SPIFFE_IDS")),
    );
    const reconciliation = new StrictGatewayInferenceReconciliation(store);
    const reconciliationAuthorizer = new GatewayProbeSpiffeAuthorizer(
      spiffeIds(required(env, "DEVILUDO_INFERENCE_GATEWAY_RECONCILIATION_SPIFFE_IDS")),
    );
    const server = buildInferenceGateway({
      signingKey,
      ...registries,
      dns,
      connector,
      readiness,
      providerProbe,
      authorizeProviderProbe: (request) => probeAuthorizer.authorize(request),
      reconciliation,
      authorizeReconciliation: (request) => reconciliationAuthorizer.authorize(request),
      https: {
        key: serverKey, cert: serverCertificate, ca: serverClientCa, minVersion: "TLSv1.3",
        requestCert: true, rejectUnauthorized: true,
      },
    });
    signingKey.fill(0);
    return Object.freeze({
      host: bindHost(env.DEVILUDO_INFERENCE_GATEWAY_HOST),
      port: integer(env.DEVILUDO_INFERENCE_GATEWAY_PORT, 4_743, 1_024, 65_535),
      pool,
      store,
      credentials,
      connector,
      readiness,
      providerProbe,
      reconciliation,
      server,
    });
  } catch (error) {
    signingKey.fill(0);
    await pool.close().catch(() => undefined);
    throw error;
  }
}

export async function runInferenceGatewayService(
  env: Readonly<Record<string, string | undefined>> = process.env,
): Promise<void> {
  const runtime = await inferenceGatewayServiceFromEnv(env);
  try {
    await Promise.all([runtime.pool.probe(), runtime.readiness.probe()]);
    await runtime.server.listen({ host: runtime.host, port: runtime.port });
    diagnostic("READY");
    const shutdown = new AbortController();
    const requestShutdown = () => shutdown.abort();
    process.once("SIGINT", requestShutdown);
    process.once("SIGTERM", requestShutdown);
    try { await waitForAbort(shutdown.signal); }
    finally {
      process.removeListener("SIGINT", requestShutdown);
      process.removeListener("SIGTERM", requestShutdown);
    }
  } finally {
    await runtime.server.close().catch(() => undefined);
    await runtime.pool.close();
    diagnostic("STOPPED");
  }
}

async function secretFile(
  env: Readonly<Record<string, string | undefined>>,
  name: string,
  minimum: number,
  maximum: number,
): Promise<Buffer> {
  const path = absolute(env, name);
  const file = await open(path, constants.O_RDONLY | constants.O_NOFOLLOW);
  try {
    const metadata = await file.stat();
    if (!metadata.isFile() || metadata.size < minimum || metadata.size > maximum) throw new Error(`${name} file is invalid`);
    const value = await file.readFile();
    if (value.byteLength < minimum || value.byteLength > maximum) throw new Error(`${name} file is invalid`);
    return value;
  } finally { await file.close(); }
}

function absolute(env: Readonly<Record<string, string | undefined>>, name: string): string {
  const value = required(env, name);
  if (!isAbsolute(value) || resolve(value) !== value || value.length > 4_096 || /\0/.test(value)) throw new Error(`${name} path is invalid`);
  return value;
}
function required(env: Readonly<Record<string, string | undefined>>, name: string): string {
  const value = env[name]?.trim();
  if (!value) throw new Error(`${name} is required`);
  return value;
}
function bindHost(value: string | undefined): string {
  const selected = value?.trim() || "0.0.0.0";
  if (selected !== "0.0.0.0" && selected !== "::") throw new Error("Inference Gateway bind host is invalid");
  return selected;
}
function spiffeIds(value: string): ReadonlySet<string> {
  let parsed: unknown;
  try { parsed = JSON.parse(value) as unknown; } catch { throw new Error("Inference Gateway probe SPIFFE allow-list is invalid"); }
  if (!Array.isArray(parsed) || parsed.length < 1 || parsed.length > 32 || new Set(parsed).size !== parsed.length) {
    throw new Error("Inference Gateway probe SPIFFE allow-list is invalid");
  }
  const ids = parsed.map((item) => {
    if (typeof item !== "string") throw new Error("Inference Gateway probe SPIFFE allow-list is invalid");
    const url = new URL(item);
    if (url.protocol !== "spiffe:" || !url.hostname || url.username || url.password || url.search || url.hash || url.pathname === "/") {
      throw new Error("Inference Gateway probe SPIFFE allow-list is invalid");
    }
    return url.toString();
  });
  if (JSON.stringify(ids) !== JSON.stringify([...ids].sort())) throw new Error("Inference Gateway probe SPIFFE allow-list must be sorted");
  return new Set(ids);
}
function seconds(value: string | undefined, fallback: number, minimum: number, maximum: number): number {
  return integer(value, fallback, minimum, maximum);
}
function integer(value: string | undefined, fallback: number, minimum: number, maximum: number): number {
  if (value === undefined) return fallback;
  const parsed = Number.parseInt(value, 10);
  if (!Number.isInteger(parsed) || parsed < minimum || parsed > maximum || String(parsed) !== value) throw new Error("Inference Gateway integer configuration is invalid");
  return parsed;
}
function waitForAbort(signal: AbortSignal): Promise<void> {
  if (signal.aborted) return Promise.resolve();
  return new Promise((accept) => signal.addEventListener("abort", () => accept(), { once: true }));
}
function diagnostic(event: "READY" | "STOPPED" | "FAILED"): void {
  process.stderr.write(`${JSON.stringify({ service: "deviludo-inference-gateway", event })}\n`);
}

if (process.argv[1] && import.meta.url === pathToFileURL(process.argv[1]).href) {
  void runInferenceGatewayService().catch(() => { diagnostic("FAILED"); process.exitCode = 1; });
}
