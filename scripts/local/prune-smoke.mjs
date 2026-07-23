#!/usr/bin/env node

import { createHash, createHmac, randomBytes } from "node:crypto";
import { readFile, readdir } from "node:fs/promises";

const HOST = "127.0.0.1";
const WEB_PORT = port("DEVILUDO_LOCAL_PORT", 3000);
const RUNTIME_PORT = port("DEVILUDO_LOCAL_RUNTIME_PORT", 4311);
const SPEC_PORT = port("DEVILUDO_LOCAL_SPEC_RUNTIME_PORT", 4313);
const GENERATED = /^smoke-(?:spec|validation|feedback|release-gates|codex-release)-[1-9][0-9]{0,9}-[a-z0-9]{6,16}$/;
const CHUNK_SIZE = 20;

const [runtimeKey, specKey] = await Promise.all([
  key("local-runtime"),
  key("local-spec-runtime"),
]);
const projects = new Set();
try {
  const entries = await readdir(new URL("../../.deviludo/local-runtime/", import.meta.url), { withFileTypes: true });
  for (const entry of entries) if (GENERATED.test(entry.name)) projects.add(entry.name);
} catch (error) {
  if (error?.code !== "ENOENT") throw error;
}
const [catalogResponse, adminResponse] = await Promise.all([
  fetch(`http://${HOST}:${WEB_PORT}/api/projects`, {
    headers: { accept: "application/json" },
    signal: AbortSignal.timeout(30_000),
  }),
  fetch(`http://${HOST}:${WEB_PORT}/api/admin/agents`, {
    headers: { accept: "application/json", "x-deviludo-role": "PlatformAgentAdmin" },
    signal: AbortSignal.timeout(30_000),
  }),
]);
if (!catalogResponse.ok) throw new Error(`Local project catalog returned HTTP ${catalogResponse.status}`);
if (!adminResponse.ok) throw new Error(`Local Agent administrator state returned HTTP ${adminResponse.status}`);
const catalog = await catalogResponse.json();
for (const project of catalog.data ?? []) {
  if (GENERATED.test(project?.projectId)) projects.add(project.projectId);
}
const admin = await adminResponse.json();
for (const scope of Object.keys(admin.meta?.defaults ?? {})) {
  const projectId = scope.startsWith("project:") ? scope.slice("project:".length) : "";
  if (GENERATED.test(projectId) || projectId === "smoke-local-project") projects.add(projectId);
}
if ((admin.meta?.credentials ?? []).some((credential) =>
  credential?.label === "Smoke tenant Provider" || credential?.label?.startsWith("Smoke tenant Provider / ")
  || credential?.label === "local-sidecar-live-check")) {
  projects.add("smoke-local-project");
}

const projectIds = [...projects].sort();
if (!projectIds.length) {
  console.log("[local:prune-smoke] No generated smoke projects need cleanup.");
  process.exit();
}
console.log(`[local:prune-smoke] Reclaiming ${projectIds.length} strictly identified generated smoke projects.`);
for (let offset = 0; offset < projectIds.length; offset += CHUNK_SIZE) {
  const chunk = projectIds.slice(offset, offset + CHUNK_SIZE);
  const body = JSON.stringify({ projectIds: chunk });
  const operations = [
    call(`http://${HOST}:${WEB_PORT}`, "/api/local/smoke-cleanup", "smoke-maintenance", body, runtimeKey),
    call(`http://${HOST}:${RUNTIME_PORT}`, "/v1/smoke-cleanup", "godot-runtime", body, runtimeKey),
    call(`http://${HOST}:${SPEC_PORT}`, "/v1/smoke-cleanup", "spec-runtime", body, specKey),
  ];
  await Promise.all(operations);
  console.log(`[local:prune-smoke] Reclaimed ${Math.min(offset + chunk.length, projectIds.length)}/${projectIds.length}.`);
}
console.log("[local:prune-smoke] Generated smoke artifacts and durable state were reclaimed; user projects were not eligible.");

async function call(origin, route, audience, body, signingKey) {
  const response = await fetch(`${origin}${route}`, {
    method: "POST",
    headers: { "content-type": "application/json", ...headers(audience, route, body, signingKey) },
    body,
    signal: AbortSignal.timeout(120_000),
  });
  const payload = await response.text();
  if (!response.ok) throw new Error(`${origin}${route} returned HTTP ${response.status}: ${payload.slice(0, 300)}`);
}

function headers(audience, route, body, signingKey) {
  const issuedAt = new Date().toISOString();
  const nonce = randomBytes(18).toString("base64url");
  const bodyDigest = createHash("sha256").update(body).digest("hex");
  const signature = createHmac("sha256", signingKey)
    .update(["deviludo.local-sidecar.v1", audience, "POST", route, bodyDigest, issuedAt, nonce].join("\n"))
    .digest("base64url");
  return {
    "x-deviludo-local-sidecar": "v1",
    "x-deviludo-local-sidecar-audience": audience,
    "x-deviludo-local-sidecar-issued-at": issuedAt,
    "x-deviludo-local-sidecar-nonce": nonce,
    "x-deviludo-local-sidecar-body-sha256": bodyDigest,
    "x-deviludo-local-sidecar-signature": signature,
  };
}

async function key(name) {
  const encoded = (await readFile(new URL(`../../.deviludo/${name}.hmac`, import.meta.url), "utf8")).trim();
  if (!/^[A-Za-z0-9_-]{43,86}$/.test(encoded)) throw new Error("Local sidecar key is invalid");
  const decoded = Buffer.from(encoded, "base64url");
  if (decoded.byteLength < 32 || decoded.byteLength > 64 || decoded.toString("base64url") !== encoded) {
    throw new Error("Local sidecar key is invalid");
  }
  return decoded;
}

function port(name, fallback) {
  const raw = process.env[name] ?? String(fallback);
  if (!/^\d+$/.test(raw)) throw new Error(`${name} is invalid`);
  const parsed = Number(raw);
  if (!Number.isSafeInteger(parsed) || parsed < 1 || parsed > 65_535) throw new Error(`${name} is invalid`);
  return parsed;
}
