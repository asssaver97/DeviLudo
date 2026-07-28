import { createServer, type Server } from "node:http";
import { request as httpsRequest } from "node:https";
import { constants } from "node:fs";
import { open } from "node:fs/promises";
import { isAbsolute, resolve } from "node:path";

type Environment = Readonly<Record<string, string | undefined>>;
type Probe = Readonly<{ status: "READY" | "BLOCKED"; body: Readonly<Record<string, unknown>> | null }>;
type Mtls = Readonly<{ key: Buffer; certificate: Buffer; ca: Buffer }>;
const MAX_BYTES = 16 * 1024;

export async function evaluateP0RuntimeReadiness(
  env: Environment,
  options: Readonly<{ fetch?: typeof fetch; timeoutMs?: number }> = {},
): Promise<Readonly<Record<string, unknown>>> {
  const fetcher = options.fetch;
  const timeoutMs = options.timeoutMs ?? 2_000;
  if (!Number.isSafeInteger(timeoutMs) || timeoutMs < 100 || timeoutMs > 10_000) throw new Error("P0 readiness timeout is invalid");
  const mtls = fetcher ? null : await loadMtls(env).catch(() => null);
  const [profile, runners, inference, artifacts, secrets, migrations] = await Promise.all([
    probe(env.DEVILUDO_AGENT_PROFILE_READINESS_URL, "/healthz/p0-profile", fetcher, mtls, timeoutMs, (body) => body.schemaVersion === "deviludo.agent-profile-readiness.v1"
      && body.status === "ready" && body.agent === "claude-code" && body.profileState === "READY" && body.providerState === "READY"
      && body.credentialState === "ACTIVE" && body.installationState === "ACTIVE" && body.workerState === "READY"
      && exactVersion(body.cliVersion) && exactModel(body.model)),
    probe(env.DEVILUDO_RUNNER_FLEET_READINESS_URL, "/healthz", fetcher, mtls, timeoutMs, (body) => body.schemaVersion === "deviludo.runner-fleet-readiness.v1"
      && body.status === "ready" && body.linux === "ONLINE" && body.windows === "ONLINE" && body.macCapacity === "ON_DEMAND_READY"),
    probe(env.DEVILUDO_INFERENCE_GATEWAY_URL, "/healthz", fetcher, mtls, timeoutMs, (body) => body.status === "ok"
      && body.service === "deviludo-inference-gateway" && body.connector === "CONFIGURED" && body.providerProbe === "CONFIGURED"),
    probe(env.DEVILUDO_EVIDENCE_ARCHIVE_URL, "/healthz", fetcher, mtls, timeoutMs, (body) => body.status === "ok" && body.service === "deviludo-evidence-archive"),
    probe(env.DEVILUDO_SECRET_BROKER_URL, "/healthz", fetcher, mtls, timeoutMs, (body) => body.status === "ok" && body.service === "deviludo-secret-broker"),
    probe(env.DEVILUDO_MIGRATION_READINESS_URL, "/healthz/migrations", fetcher, mtls, timeoutMs, (body) => body.schemaVersion === "deviludo.migration-readiness.v1"
      && body.status === "ready" && body.pending === 0),
  ]);
  const ready = [profile, runners, inference, artifacts, secrets, migrations].every((item) => item.status === "READY");
  const profileBody = profile.body ?? {};
  return Object.freeze({
    schemaVersion: "deviludo.p0-runtime-readiness.v1", status: ready ? "ready" : "blocked",
    claudeAgent: ready ? "claude-code" : "BLOCKED", claudeCliVersion: ready ? profileBody.cliVersion : "BLOCKED",
    claudeModel: ready ? profileBody.model : "BLOCKED", claudeProfile: profile.status,
    agentFleet: profile.status, linuxFleet: runners.status, windowsFleet: runners.status,
    macCapacity: runners.status === "READY" ? "ON_DEMAND_READY" : "BLOCKED",
    inferenceGateway: inference.status, artifactStore: artifacts.status, vault: secrets.status, migrations: migrations.status,
  });
}

export function createP0ReadinessServer(env: Environment = process.env, options: Readonly<{ fetch?: typeof fetch }> = {}): Server {
  return createServer((request, response) => {
    if (request.method !== "GET" || request.url !== "/healthz") { response.writeHead(404).end(); return; }
    void evaluateP0RuntimeReadiness(env, options).then((body) => {
      const ready = body.status === "ready";
      response.writeHead(ready ? 200 : 503, { "content-type": "application/json", "cache-control": "no-store" });
      response.end(JSON.stringify(body));
    }).catch(() => {
      response.writeHead(503, { "content-type": "application/json", "cache-control": "no-store" });
      response.end(JSON.stringify({ schemaVersion: "deviludo.p0-runtime-readiness.v1", status: "blocked" }));
    });
  });
}

async function probe(endpoint: string | undefined, pathname: string, fetcher: typeof fetch | undefined, mtls: Mtls | null, timeoutMs: number,
  validator: (body: Readonly<Record<string, unknown>>) => boolean): Promise<Probe> {
  if (!endpoint) return Object.freeze({ status: "BLOCKED", body: null });
  try {
    const url = new URL(endpoint);
    const internal = url.hostname.endsWith(".deviludo.svc.cluster.local");
    if (!internal || (url.protocol !== "http:" && url.protocol !== "https:")
      || url.username || url.password || url.search || url.hash || url.pathname !== "/") throw new Error();
    url.pathname = pathname;
    const response = url.protocol === "https:" && !fetcher
      ? await mtlsJson(url, mtls, timeoutMs)
      : await fetchJson(url, fetcher ?? fetch, timeoutMs);
    if (!response.ok || response.redirected || response.contentType?.split(";", 1)[0]?.trim() !== "application/json") throw new Error();
    const text = response.text;
    if (Buffer.byteLength(text) > MAX_BYTES) throw new Error();
    const body = JSON.parse(text) as Readonly<Record<string, unknown>>;
    if (!body || Array.isArray(body) || !validator(body)) throw new Error();
    return Object.freeze({ status: "READY", body });
  } catch { return Object.freeze({ status: "BLOCKED", body: null }); }
}

async function fetchJson(url: URL, fetcher: typeof fetch, timeoutMs: number) {
  const response = await fetcher(url, { method: "GET", headers: { accept: "application/json" }, redirect: "error", signal: AbortSignal.timeout(timeoutMs) });
  return Object.freeze({ ok: response.ok, redirected: response.redirected,
    contentType: response.headers.get("content-type"), text: await response.text() });
}

async function mtlsJson(url: URL, tls: Mtls | null, timeoutMs: number): Promise<Readonly<{
  ok: boolean; redirected: boolean; contentType: string | null; text: string;
}>> {
  if (!tls) throw new Error("P0 readiness mTLS is not configured");
  return new Promise((accept, reject) => {
    const request = httpsRequest(url, {
      method: "GET", headers: { accept: "application/json" }, key: tls.key, cert: tls.certificate, ca: tls.ca,
      minVersion: "TLSv1.3", rejectUnauthorized: true, timeout: timeoutMs,
    }, (response) => {
      const chunks: Buffer[] = []; let length = 0;
      response.on("data", (chunk: Buffer | string) => {
        const value = Buffer.isBuffer(chunk) ? chunk : Buffer.from(chunk);
        length += value.byteLength;
        if (length > MAX_BYTES) { request.destroy(new Error("P0 readiness response is oversized")); return; }
        chunks.push(value);
      });
      response.once("error", reject);
      response.once("end", () => accept(Object.freeze({
        ok: (response.statusCode ?? 500) >= 200 && (response.statusCode ?? 500) < 300,
        redirected: (response.statusCode ?? 0) >= 300 && (response.statusCode ?? 0) < 400,
        contentType: typeof response.headers["content-type"] === "string" ? response.headers["content-type"] : null,
        text: Buffer.concat(chunks).toString("utf8"),
      })));
    });
    request.once("timeout", () => request.destroy(new Error("P0 readiness probe timed out")));
    request.once("error", reject);
    request.end();
  });
}

async function loadMtls(env: Environment): Promise<Mtls> {
  const [key, certificate, ca] = await Promise.all([
    readSecret(env, "DEVILUDO_P0_READINESS_TLS_KEY_FILE"),
    readSecret(env, "DEVILUDO_P0_READINESS_TLS_CERT_FILE"),
    readSecret(env, "DEVILUDO_P0_READINESS_CA_FILE"),
  ]);
  return Object.freeze({ key, certificate, ca });
}

async function readSecret(env: Environment, name: string): Promise<Buffer> {
  const path = env[name]?.trim();
  if (!path || !isAbsolute(path) || resolve(path) !== path || path.length > 4_096 || /\0/.test(path)) throw new Error(`${name} is invalid`);
  const file = await open(path, constants.O_RDONLY | constants.O_NOFOLLOW);
  try {
    const metadata = await file.stat();
    if (!metadata.isFile() || metadata.size < 32 || metadata.size > 1024 * 1024) throw new Error(`${name} is invalid`);
    return await file.readFile();
  } finally { await file.close(); }
}

function exactVersion(value: unknown): boolean { return typeof value === "string" && /^\d+\.\d+\.\d+$/.test(value); }
function exactModel(value: unknown): boolean { return typeof value === "string" && /^[A-Za-z0-9][A-Za-z0-9._:-]{2,199}$/.test(value)
  && !/^(latest|default|sonnet)$/i.test(value); }
