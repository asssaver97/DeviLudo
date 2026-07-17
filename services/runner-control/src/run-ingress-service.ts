import { createPrivateKey, type KeyObject } from "node:crypto";
import { readFile } from "node:fs/promises";
import type { Server as HttpsServer } from "node:https";
import { pathToFileURL } from "node:url";
import { postgresWorkflowPoolFromEnv } from "../../temporal/src/node-postgres";
import { runnerEvidenceArchiveFromEnv } from "./evidence-archive";
import { runnerFleetPolicyFromEnv } from "./fleet-manifest";
import { createRunnerIngressHandler, createRunnerIngressHttpsServer } from "./ingress-http";
import { PostgresRunnerIngressStore } from "./postgres-ingress";

export interface RunnerIngressServiceConfig {
  readonly host: string;
  readonly port: number;
  readonly maxBodyBytes: number;
  readonly leaseDurationSeconds: number;
  readonly tlsKey: Buffer;
  readonly tlsCertificate: Buffer;
  readonly runnerClientCa: Buffer;
  readonly jobSigningKeyId: string;
  readonly jobSigningPrivateKey: KeyObject;
}

/** Starts only the dedicated Runner mTLS listener; it is never mounted in Web. */
export async function runRunnerIngressService(options: {
  readonly env?: Readonly<Record<string, string | undefined>>;
} = {}): Promise<void> {
  const env: Readonly<Record<string, string | undefined>> = Object.freeze({
    ...(options.env ?? process.env),
    DEVILUDO_WORKFLOW_DESTINATION: "runner-control",
  });
  const config = await runnerIngressServiceConfigFromEnv(env);
  const pool = postgresWorkflowPoolFromEnv(env);
  let server: HttpsServer | null = null;
  try {
    const fleet = runnerFleetPolicyFromEnv(env);
    const archive = await runnerEvidenceArchiveFromEnv(env);
    const store = new PostgresRunnerIngressStore({
      pool,
      admission: fleet,
      assignments: fleet,
      signer: { keyId: config.jobSigningKeyId, privateKey: config.jobSigningPrivateKey },
      evidenceArchive: archive,
      leaseDurationSeconds: config.leaseDurationSeconds,
    });
    const readiness = async () => {
      await Promise.all([pool.probe(), fleet.probe(), archive.probe()]);
    };
    const handler = createRunnerIngressHandler({ operations: store, readiness });
    server = createRunnerIngressHttpsServer({
      tls: { key: config.tlsKey, cert: config.tlsCertificate, ca: config.runnerClientCa },
      handler,
      maxBodyBytes: config.maxBodyBytes,
    });
    await readiness();
    await listen(server, config.port, config.host);
    diagnostic("READY");

    const shutdown = new AbortController();
    const requestShutdown = () => shutdown.abort();
    process.once("SIGINT", requestShutdown);
    process.once("SIGTERM", requestShutdown);
    try {
      await Promise.race([waitForAbort(shutdown.signal), waitForServerFailure(server)]);
    } finally {
      process.removeListener("SIGINT", requestShutdown);
      process.removeListener("SIGTERM", requestShutdown);
    }
  } finally {
    if (server?.listening) await close(server);
    await pool.close();
    diagnostic("STOPPED");
  }
}

export async function runnerIngressServiceConfigFromEnv(
  env: Readonly<Record<string, string | undefined>> = process.env,
): Promise<RunnerIngressServiceConfig> {
  const host = env.DEVILUDO_RUNNER_INGRESS_HOST?.trim() || "0.0.0.0";
  if (!/^[A-Za-z0-9][A-Za-z0-9.:-]{0,253}$/.test(host)) throw new Error("Runner ingress host is invalid");
  const port = positiveInteger(env.DEVILUDO_RUNNER_INGRESS_PORT, 4300, 1, 65_535, "port");
  const maxBodyBytes = positiveInteger(
    env.DEVILUDO_RUNNER_INGRESS_MAX_BODY_BYTES, 1024 * 1024, 1_024, 4 * 1024 * 1024, "body limit",
  );
  const leaseDurationSeconds = positiveInteger(
    env.DEVILUDO_RUNNER_LEASE_SECONDS, 300, 30, 3_600, "lease duration",
  );
  const jobSigningKeyId = requiredEnv(env, "DEVILUDO_RUNNER_JOB_SIGNING_KEY_ID");
  if (!/^[A-Za-z0-9][A-Za-z0-9._:-]{2,159}$/.test(jobSigningKeyId)) {
    throw new Error("Runner job signing key ID is invalid");
  }
  const [tlsKey, tlsCertificate, runnerClientCa, signingPem] = await Promise.all([
    readRequiredFile(env, "DEVILUDO_RUNNER_INGRESS_TLS_KEY_FILE"),
    readRequiredFile(env, "DEVILUDO_RUNNER_INGRESS_TLS_CERT_FILE"),
    readRequiredFile(env, "DEVILUDO_RUNNER_INGRESS_CLIENT_CA_FILE"),
    readRequiredFile(env, "DEVILUDO_RUNNER_JOB_SIGNING_KEY_FILE"),
  ]);
  const jobSigningPrivateKey = createPrivateKey(signingPem);
  if (jobSigningPrivateKey.asymmetricKeyType !== "ed25519") {
    throw new Error("Runner job signing key must be Ed25519");
  }
  return Object.freeze({
    host,
    port,
    maxBodyBytes,
    leaseDurationSeconds,
    tlsKey,
    tlsCertificate,
    runnerClientCa,
    jobSigningKeyId,
    jobSigningPrivateKey,
  });
}

async function readRequiredFile(env: Readonly<Record<string, string | undefined>>, name: string): Promise<Buffer> {
  const path = requiredEnv(env, name);
  if (!path.startsWith("/") || path.length > 4_096 || /\0/.test(path)) throw new Error(`${name} path is invalid`);
  const value = await readFile(path);
  if (value.byteLength < 32 || value.byteLength > 1024 * 1024) throw new Error(`${name} file is invalid`);
  return value;
}

function listen(server: HttpsServer, port: number, host: string): Promise<void> {
  return new Promise((resolve, reject) => {
    const onError = (error: Error) => { server.removeListener("listening", onListening); reject(error); };
    const onListening = () => { server.removeListener("error", onError); resolve(); };
    server.once("error", onError);
    server.once("listening", onListening);
    server.listen(port, host);
  });
}

function close(server: HttpsServer): Promise<void> {
  return new Promise((resolve, reject) => server.close((error) => error ? reject(error) : resolve()));
}

function waitForServerFailure(server: HttpsServer): Promise<never> {
  return new Promise((_, reject) => server.once("error", reject));
}

function waitForAbort(signal: AbortSignal): Promise<void> {
  if (signal.aborted) return Promise.resolve();
  return new Promise((resolve) => signal.addEventListener("abort", () => resolve(), { once: true }));
}

function requiredEnv(env: Readonly<Record<string, string | undefined>>, name: string): string {
  const value = env[name]?.trim();
  if (!value) throw new Error(`${name} is required`);
  return value;
}

function positiveInteger(
  value: string | undefined,
  fallback: number,
  minimum: number,
  maximum: number,
  label: string,
): number {
  if (value === undefined) return fallback;
  const parsed = Number.parseInt(value, 10);
  if (!Number.isInteger(parsed) || parsed < minimum || parsed > maximum || String(parsed) !== value) {
    throw new Error(`Runner ingress ${label} is invalid`);
  }
  return parsed;
}

function diagnostic(event: "READY" | "STOPPED" | "FAILED"): void {
  process.stderr.write(`${JSON.stringify({ service: "deviludo-runner-ingress", event })}\n`);
}

if (process.argv[1] && import.meta.url === pathToFileURL(process.argv[1]).href) {
  void runRunnerIngressService().catch(() => {
    diagnostic("FAILED");
    process.exitCode = 1;
  });
}
