import { constants } from "node:fs";
import { open } from "node:fs/promises";
import { isAbsolute, resolve } from "node:path";
import { pathToFileURL } from "node:url";
import { NodeGatewayDnsResolver } from "../../inference-gateway/src/dns-resolver";
import { postgresWorkflowPoolFromEnv } from "../../temporal/src/node-postgres";
import { MtlsSpecModelCredentialResolver } from "./credential-broker";
import { createSpecModelBrokerHandler, createSpecModelBrokerHttpsServer } from "./ingress-http";
import { PostgresSpecModelOperationStore } from "./postgres-operations";
import { PostgresSpecModelProviderAuthority } from "./provider-authority";
import { ProductionSpecModelGenerator } from "./production-generator";
import { StrictSpecModelReconciliationService } from "./reconciliation";
import { SpecModelBrokerService } from "./service";

const MAX_SECRET_BYTES = 1024 * 1024;
const SAFE_ID = /^[A-Za-z0-9][A-Za-z0-9._:-]{0,199}$/;

export async function specModelBrokerRuntimeFromEnv(
  env: Readonly<Record<string, string | undefined>> = process.env,
) {
  if (env.NODE_ENV !== "production") throw new Error("Specification model Broker requires NODE_ENV=production");
  const [serverKey, serverCertificate, clientCa, brokerKey, brokerCertificate, brokerCa] = await Promise.all([
    secret(env, "DEVILUDO_SPEC_MODEL_TLS_KEY_FILE"),
    secret(env, "DEVILUDO_SPEC_MODEL_TLS_CERT_FILE"),
    secret(env, "DEVILUDO_SPEC_MODEL_CLIENT_CA_FILE"),
    secret(env, "DEVILUDO_SPEC_MODEL_SECRET_BROKER_TLS_KEY_FILE"),
    secret(env, "DEVILUDO_SPEC_MODEL_SECRET_BROKER_TLS_CERT_FILE"),
    secret(env, "DEVILUDO_SPEC_MODEL_SECRET_BROKER_CA_FILE"),
  ]);
  const pool = postgresWorkflowPoolFromEnv({ ...env, DEVILUDO_WORKFLOW_DESTINATION: "spec-model-broker" });
  try {
    const profileRevisionId = safeId(required(env, "DEVILUDO_SPEC_MODEL_PROFILE_REVISION_ID"));
    const store = new PostgresSpecModelOperationStore(pool);
    const authority = new PostgresSpecModelProviderAuthority(pool);
    const credentials = new MtlsSpecModelCredentialResolver({
      endpoint: required(env, "DEVILUDO_SPEC_MODEL_SECRET_BROKER_URL"),
      tls: { key: brokerKey, certificate: brokerCertificate, ca: brokerCa },
      timeoutMs: integer(env.DEVILUDO_SPEC_MODEL_SECRET_BROKER_TIMEOUT_MS, 10_000, 1_000, 60_000),
    });
    const generator = new ProductionSpecModelGenerator({
      credentials,
      dns: new NodeGatewayDnsResolver(),
      timeoutMs: integer(env.DEVILUDO_SPEC_MODEL_UPSTREAM_TIMEOUT_MS, 120_000, 1_000, 120_000),
    });
    const service = new SpecModelBrokerService({
      store,
      authority,
      generator,
      profileRevisionId,
      leaseSeconds: integer(env.DEVILUDO_SPEC_MODEL_OPERATION_LEASE_SECONDS, 180, 30, 600),
    });
    const generationSpiffeIds = spiffeSet(required(env, "DEVILUDO_SPEC_MODEL_CLIENT_SPIFFE_IDS"));
    const reconciliationSpiffeIds = spiffeSet(required(env, "DEVILUDO_SPEC_MODEL_RECONCILIATION_SPIFFE_IDS"));
    if ([...reconciliationSpiffeIds].some((identity) => generationSpiffeIds.has(identity))) {
      throw new Error("Specification model generation and reconciliation identities must be disjoint");
    }
    const reconciliation = new StrictSpecModelReconciliationService(store);
    const handler = createSpecModelBrokerHandler({
      service,
      allowedSpiffeIds: generationSpiffeIds,
      reconciliation,
      reconciliationSpiffeIds,
    });
    const server = createSpecModelBrokerHttpsServer({
      tls: { key: serverKey, cert: serverCertificate, ca: clientCa },
      handler,
      requestTimeoutMs: integer(env.DEVILUDO_SPEC_MODEL_REQUEST_TIMEOUT_MS, 130_000, 1_000, 180_000),
    });
    return Object.freeze({
      host: host(env.DEVILUDO_SPEC_MODEL_HOST),
      port: integer(env.DEVILUDO_SPEC_MODEL_PORT, 4_773, 1_024, 65_535),
      pool,
      store,
      authority,
      credentials,
      generator,
      service,
      reconciliation,
      server,
    });
  } catch (error) {
    await pool.close().catch(() => undefined);
    throw error;
  }
}

export async function runSpecModelBrokerService(
  env: Readonly<Record<string, string | undefined>> = process.env,
): Promise<void> {
  const runtime = await specModelBrokerRuntimeFromEnv(env);
  try {
    await runtime.service.probe();
    await new Promise<void>((ready, reject) => {
      const fail = (error: Error) => reject(error);
      runtime.server.once("error", fail);
      runtime.server.listen(runtime.port, runtime.host, () => { runtime.server.off("error", fail); ready(); });
    });
    diagnostic("READY");
    const close = () => runtime.server.close();
    process.once("SIGINT", close);
    process.once("SIGTERM", close);
    await new Promise<void>((closed, reject) => {
      runtime.server.once("close", closed);
      runtime.server.once("error", reject);
    });
  } finally {
    await runtime.pool.close();
    diagnostic("STOPPED");
  }
}

async function secret(env: Readonly<Record<string, string | undefined>>, name: string): Promise<Buffer> {
  const path = required(env, name);
  if (!isAbsolute(path) || resolve(path) !== path || path.length > 4_096 || /\0/.test(path)) throw new Error(`${name} path is invalid`);
  const file = await open(path, constants.O_RDONLY | constants.O_NOFOLLOW);
  try {
    const metadata = await file.stat();
    if (!metadata.isFile() || metadata.size < 32 || metadata.size > MAX_SECRET_BYTES) throw new Error(`${name} file is invalid`);
    return await file.readFile();
  } finally { await file.close(); }
}
function spiffeSet(value: string): ReadonlySet<string> {
  const values = value.split(",").map((item) => item.trim());
  if (!values.length || values.some((item) => !item) || new Set(values).size !== values.length) {
    throw new Error("Specification model SPIFFE allow-list is invalid");
  }
  for (const item of values) {
    const url = new URL(item);
    if (url.protocol !== "spiffe:" || !url.hostname || url.username || url.password
      || url.search || url.hash || url.toString() !== item) throw new Error("Specification model SPIFFE identity is invalid");
  }
  return new Set(values);
}
function safeId(value: string): string { if (!SAFE_ID.test(value)) throw new Error("Specification model Profile revision is invalid"); return value; }
function host(value: string | undefined): string {
  const result = value?.trim() || "0.0.0.0";
  if (result !== "0.0.0.0" && result !== "::") throw new Error("Specification model host is invalid");
  return result;
}
function integer(value: string | undefined, fallback: number, minimum: number, maximum: number): number {
  if (value === undefined) return fallback;
  const result = Number(value);
  if (!Number.isInteger(result) || result < minimum || result > maximum || String(result) !== value) {
    throw new Error("Specification model numeric configuration is invalid");
  }
  return result;
}
function required(env: Readonly<Record<string, string | undefined>>, name: string): string {
  const value = env[name]?.trim();
  if (!value) throw new Error(`${name} is required`);
  return value;
}
function diagnostic(event: "READY" | "STOPPED" | "FAILED"): void {
  process.stderr.write(`${JSON.stringify({ service: "deviludo-spec-model-broker", event })}\n`);
}

if (process.argv[1] && import.meta.url === pathToFileURL(process.argv[1]).href) {
  void runSpecModelBrokerService().catch(() => { diagnostic("FAILED"); process.exitCode = 1; });
}
