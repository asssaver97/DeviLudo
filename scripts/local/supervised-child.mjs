#!/usr/bin/env node

import { closeSync, constants, fstatSync, openSync, readFileSync } from "node:fs";
import { spawn } from "node:child_process";
import { isAbsolute, resolve } from "node:path";
import { pathToFileURL } from "node:url";

const OWNER_SCHEMA = "deviludo.local-sidecar-session.v1";
const OWNER_FIELDS = Object.freeze(["createdAt", "deploymentId", "pid", "schema"]);
const CHECK_INTERVAL_MS = 500;
const FORCE_STOP_AFTER_MS = 5_000;

export function parseSupervisedChildArguments(argv) {
  const separator = argv.indexOf("--");
  if (separator < 6 || argv.length <= separator + 1) invalid();
  const options = new Map();
  for (let index = 0; index < separator; index += 2) {
    const name = argv[index];
    const value = argv[index + 1];
    if (!name?.startsWith("--") || value === undefined || options.has(name)) invalid();
    options.set(name, value);
  }
  if (options.size !== 3 || !options.has("--parent-pid") || !options.has("--owner-file") || !options.has("--deployment-id")) invalid();
  const parentPid = Number(options.get("--parent-pid"));
  const ownerFile = options.get("--owner-file");
  const deploymentId = options.get("--deployment-id");
  const childArguments = argv.slice(separator + 1);
  if (!Number.isSafeInteger(parentPid) || parentPid < 1 || typeof ownerFile !== "string" || !isAbsolute(ownerFile)
    || resolve(ownerFile) !== ownerFile || ownerFile.length > 4_096 || ownerFile.includes("\0")
    || typeof deploymentId !== "string" || !/^[A-Za-z0-9_-]{32}$/.test(deploymentId)
    || childArguments.length > 100 || childArguments.some((argument) => typeof argument !== "string"
      || argument.length > 4_096 || argument.includes("\0"))) invalid();
  return Object.freeze({ parentPid, ownerFile, deploymentId, childArguments: Object.freeze(childArguments) });
}

export function localDeploymentOwnerMatches(ownerFile, parentPid, deploymentId) {
  let descriptor;
  let metadata;
  let value;
  try {
    descriptor = openSync(ownerFile, constants.O_RDONLY | constants.O_NOFOLLOW);
    metadata = fstatSync(descriptor);
    if (!metadata.isFile() || metadata.size < 2 || metadata.size > 1_024
      || (process.platform !== "win32" && (metadata.mode & 0o777) !== 0o600)) return false;
    value = JSON.parse(readFileSync(descriptor, "utf8"));
    metadata = value && typeof value === "object" && !Array.isArray(value);
  } catch { return false; }
  finally { if (descriptor !== undefined) closeSync(descriptor); }
  return metadata && Object.keys(value).sort().join("\0") === [...OWNER_FIELDS].sort().join("\0")
    && value.schema === OWNER_SCHEMA && value.pid === parentPid && value.deploymentId === deploymentId
    && typeof value.createdAt === "string" && Number.isFinite(Date.parse(value.createdAt))
    && new Date(value.createdAt).toISOString() === value.createdAt;
}

function processIsAlive(pid) {
  try { process.kill(pid, 0); return true; }
  catch (error) { return error?.code !== "ESRCH"; }
}

function invalid() {
  throw new Error("Local supervised child configuration is invalid");
}

async function main() {
  let configuration;
  try { configuration = parseSupervisedChildArguments(process.argv.slice(2)); }
  catch (error) {
    console.error(`[local:child] ${error instanceof Error ? error.message : "configuration is invalid"}`);
    process.exitCode = 1;
    return;
  }
  const ownsDeployment = () => processIsAlive(configuration.parentPid)
    && localDeploymentOwnerMatches(configuration.ownerFile, configuration.parentPid, configuration.deploymentId);
  if (!ownsDeployment()) {
    console.error("[local:child] Launcher ownership is unavailable.");
    process.exitCode = 1;
    return;
  }

  const child = spawn(process.execPath, configuration.childArguments, {
    cwd: process.cwd(),
    env: process.env,
    stdio: "inherit",
  });
  let stopping = false;
  let ownershipLost = false;
  let requestedSignal;
  let forceStopTimer;

  const stop = (signal, lost = false) => {
    if (stopping) return;
    stopping = true;
    ownershipLost = lost;
    requestedSignal = signal;
    clearInterval(ownershipTimer);
    if (child.exitCode === null && child.signalCode === null) child.kill("SIGTERM");
    forceStopTimer = setTimeout(() => {
      if (child.exitCode === null && child.signalCode === null) child.kill("SIGKILL");
    }, FORCE_STOP_AFTER_MS);
  };
  const ownershipTimer = setInterval(() => {
    if (!ownsDeployment()) stop("SIGTERM", true);
  }, CHECK_INTERVAL_MS);

  for (const signal of ["SIGINT", "SIGTERM", "SIGHUP"]) {
    process.on(signal, () => stop(signal));
  }
  child.once("error", () => {
    clearInterval(ownershipTimer);
    clearTimeout(forceStopTimer);
    process.exitCode = 1;
  });
  child.once("exit", (code, signal) => {
    clearInterval(ownershipTimer);
    clearTimeout(forceStopTimer);
    if (ownershipLost) process.exitCode = 1;
    else if (requestedSignal) process.exitCode = signalExitCode(requestedSignal);
    else if (signal) process.exitCode = signalExitCode(signal);
    else process.exitCode = code ?? 1;
  });
  process.once("exit", () => {
    if (child.exitCode === null && child.signalCode === null) child.kill("SIGKILL");
  });
}

function signalExitCode(signal) {
  return signal === "SIGINT" ? 130 : signal === "SIGTERM" ? 143 : signal === "SIGHUP" ? 129 : 1;
}

if (process.argv[1] && import.meta.url === pathToFileURL(process.argv[1]).href) await main();
