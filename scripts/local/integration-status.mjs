#!/usr/bin/env node

import { createHash } from "node:crypto";
import { existsSync, readFileSync } from "node:fs";
import { createConnection } from "node:net";
import { resolve } from "node:path";
import { loadEnvFile } from "node:process";
import { pathToFileURL } from "node:url";
import pg from "pg";

const { Client } = pg;
const DEFAULT_TIMEOUT_MS = 2_000;
const LOOPBACK_HOSTS = new Set(["127.0.0.1", "localhost", "::1", "[::1]"]);
const LATEST_MIGRATION = Object.freeze({
  version: 62,
  filename: "062_runner_native_install_authorizations.sql",
  digest: createHash("sha256").update(readFileSync(
    new URL("../../infra/postgres/062_runner_native_install_authorizations.sql", import.meta.url),
  )).digest("hex"),
});

export function resolveIntegrationConfig(env = process.env) {
  const database = localUrl(env.DATABASE_URL ?? "postgresql://deviludo:deviludo-local-only@127.0.0.1:5432/deviludo", ["postgres:", "postgresql:"]);
  const redis = localUrl(env.REDIS_URL ?? "redis://:deviludo-local-only@127.0.0.1:6379", ["redis:"]);
  if (!database.username || !database.password) throw new Error("DATABASE_URL must include local integration credentials");
  if (redis.username) throw new Error("REDIS_URL must use the password-only local integration account");
  if (!redis.password) throw new Error("REDIS_URL must include the local integration password");
  const temporal = localAddress(env.TEMPORAL_ADDRESS ?? "127.0.0.1:7233");
  const minio = localUrl(env.S3_ENDPOINT ?? "http://127.0.0.1:9000", ["http:"]);
  const vault = localUrl(env.VAULT_ADDR ?? "http://127.0.0.1:8200", ["http:"]);
  const telemetry = localUrl(env.DEVILUDO_OTEL_HEALTH_URL ?? "http://127.0.0.1:13133", ["http:"]);
  return Object.freeze({ database, redis, temporal, minio, vault, telemetry });
}

export async function inspectLocalIntegration(env = process.env, probes = defaultProbes()) {
  const config = resolveIntegrationConfig(env);
  const checks = [
    ["PostgreSQL schema 062", () => probes.postgres(config.database)],
    ["Redis authenticated PING", () => probes.redis(config.redis)],
    ["Temporal transport", () => probes.tcp(config.temporal)],
    ["MinIO health", () => probes.http(new URL("/minio/health/live", config.minio))],
    ["Vault health", () => probes.http(new URL("/v1/sys/health?standbyok=true&sealedcode=503&uninitcode=503", config.vault))],
    ["OpenTelemetry collector", () => probes.http(new URL("/", config.telemetry))],
  ];
  return Promise.all(checks.map(async ([name, check]) => {
    try {
      await check();
      return Object.freeze({ name, ready: true, detail: "READY" });
    } catch (error) {
      return Object.freeze({ name, ready: false, detail: safeFailure(error) });
    }
  }));
}

function defaultProbes() {
  return Object.freeze({
    postgres: postgresProbe,
    redis: redisProbe,
    tcp: tcpProbe,
    http: httpProbe,
  });
}

async function postgresProbe(url) {
  const client = new Client({ connectionString: url.href, connectionTimeoutMillis: DEFAULT_TIMEOUT_MS, ssl: false });
  try {
    await client.connect();
    const schema = await client.query(`SELECT
      EXISTS (
        SELECT 1 FROM information_schema.columns
         WHERE table_schema = 'deviludo' AND table_name = 'agent_runs'
           AND column_name = 'agent_version_attestation_required'
      ) AND to_regprocedure(
        'deviludo.agent_profile_version_attestation_is_valid(jsonb)'
      ) IS NOT NULL
      AND to_regclass('public.deviludo_schema_migrations') IS NOT NULL AS latest_schema`);
    if (schema.rows[0]?.latest_schema !== true) throw new Error("latest migration is missing");
    const ledger = await client.query(`SELECT
      EXISTS (
        SELECT 1 FROM public.deviludo_schema_migrations
         WHERE version = $1 AND filename = $2 AND digest = $3
      )
      AND EXISTS (
        SELECT 1 FROM pg_trigger
         WHERE tgrelid = 'public.deviludo_schema_migrations'::regclass
           AND tgname = 'deviludo_schema_migrations_immutable'
           AND NOT tgisinternal
      ) AS latest_schema`, [LATEST_MIGRATION.version, LATEST_MIGRATION.filename, LATEST_MIGRATION.digest]);
    if (ledger.rows[0]?.latest_schema !== true) {
      throw new Error("latest migration is missing");
    }
  } finally {
    await client.end().catch(() => undefined);
  }
}

async function redisProbe(url) {
  const password = decodeURIComponent(url.password);
  const socket = await connectSocket({ host: normalizedHost(url.hostname), port: portOf(url) });
  try {
    const response = await redisExchange(socket, password);
    if (!response.includes("+OK\r\n") || !response.endsWith("+PONG\r\n")) throw new Error("authentication failed");
  } finally {
    socket.destroy();
  }
}

function redisExchange(socket, password) {
  // Build the two RESP commands explicitly so the password is length-bound and
  // never interpreted as command syntax.
  const auth = `*2\r\n$4\r\nAUTH\r\n$${Buffer.byteLength(password)}\r\n${password}\r\n`;
  const ping = "*1\r\n$4\r\nPING\r\n";
  return new Promise((resolveResponse, reject) => {
    let response = "";
    const onData = (chunk) => {
      response += chunk.toString("utf8");
      if (response.includes("-ERR") || response.includes("-NOAUTH")) finish(new Error("authentication failed"));
      else if (response.endsWith("+PONG\r\n")) finish(null, response);
    };
    const onError = (error) => finish(error);
    const onTimeout = () => finish(new Error("request timed out"));
    const finish = (error, value) => {
      socket.off("data", onData);
      socket.off("error", onError);
      socket.off("timeout", onTimeout);
      if (error) reject(error); else resolveResponse(value);
    };
    socket.on("data", onData);
    socket.once("error", onError);
    socket.once("timeout", onTimeout);
    socket.write(auth + ping);
  });
}

async function tcpProbe(address) {
  const socket = await connectSocket(address);
  socket.destroy();
}

function connectSocket(address) {
  const socket = createConnection(address);
  socket.setTimeout(DEFAULT_TIMEOUT_MS);
  return new Promise((resolveConnection, reject) => {
    const finish = (error) => {
      socket.off("connect", onConnect);
      socket.off("error", onError);
      socket.off("timeout", onTimeout);
      if (error) { socket.destroy(); reject(error); }
      else resolveConnection(socket);
    };
    const onConnect = () => finish();
    const onError = () => finish(new Error("connection unavailable"));
    const onTimeout = () => finish(new Error("connection timed out"));
    socket.once("connect", onConnect);
    socket.once("error", onError);
    socket.once("timeout", onTimeout);
  });
}

async function httpProbe(url) {
  const response = await fetch(url, { redirect: "error", signal: AbortSignal.timeout(DEFAULT_TIMEOUT_MS) });
  await response.body?.cancel();
  if (!response.ok) throw new Error(`health endpoint returned ${response.status}`);
}

function localUrl(value, protocols) {
  const url = new URL(value);
  if (!protocols.includes(url.protocol) || !LOOPBACK_HOSTS.has(url.hostname)
    || url.search || url.hash || (url.protocol === "http:" && (url.username || url.password))) {
    throw new Error("local integration endpoint must use an approved loopback origin");
  }
  return url;
}

function localAddress(value) {
  const match = /^(127\.0\.0\.1|localhost|\[::1\]):(\d{1,5})$/.exec(value);
  const port = Number(match?.[2]);
  if (!match || !Number.isSafeInteger(port) || port < 1 || port > 65_535) {
    throw new Error("TEMPORAL_ADDRESS must be a loopback host and valid port");
  }
  return Object.freeze({ host: normalizedHost(match[1]), port });
}

function portOf(url) {
  if (url.port) return Number(url.port);
  if (url.protocol === "postgres:" || url.protocol === "postgresql:") return 5432;
  if (url.protocol === "redis:") return 6379;
  return url.protocol === "http:" ? 80 : 443;
}

function normalizedHost(host) {
  return host === "[::1]" ? "::1" : host;
}

function safeFailure(error) {
  const message = error instanceof Error ? error.message : "unavailable";
  if (message.includes("migration is missing")) return "migration is missing";
  if (message.includes("authentication failed")) return "authentication failed";
  if (message.includes("connection timed out")) return "connection timed out";
  if (message.includes("request timed out")) return "request timed out";
  const status = /health endpoint returned (\d{3})/.exec(message);
  if (status) return `health endpoint returned ${status[1]}`;
  return "unavailable";
}

function loadLocalDotEnv() {
  const path = resolve(process.cwd(), ".env");
  if (existsSync(path)) loadEnvFile(path);
}

async function main() {
  let results;
  try {
    loadLocalDotEnv();
    results = await inspectLocalIntegration();
  } catch (error) {
    console.error(`[infra:status] ${safeFailure(error)}`);
    process.exitCode = 1;
    return;
  }
  for (const result of results) console.log(`${result.ready ? "✓" : "✗"} ${result.name}: ${result.detail}`);
  if (results.some((result) => !result.ready)) process.exitCode = 1;
}

if (process.argv[1] && import.meta.url === pathToFileURL(process.argv[1]).href) await main();
