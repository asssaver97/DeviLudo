import { createHash } from "node:crypto";
import { constants } from "node:fs";
import { open, realpath, writeFile } from "node:fs/promises";
import { dirname, isAbsolute, resolve, sep } from "node:path";
import { pathToFileURL } from "node:url";
import type { AgentSupplyChainTerminalFailureReceipt } from "../../control-plane/src/agent-supply-chain";
import { canonicalJson, sha256Canonical } from "../../runner-control/src/canonical";
import type { AgentSupplyChainRequest, AgentSupplyChainResponse } from "./contracts";
import { NativeAgentSupplyChainController } from "./native-policy-controller";
import { parseNativeAgentSupplyChainPolicy } from "./native-policy-config";
import { LockedNativeSupplyChainTools, NativePolicyViolation } from "./native-policy-tools";
import { OfficialNpmAgentRegistry } from "./official-npm-registry";
import {
  agentSupplyChainOperationKind,
  parseAgentSupplyChainRequest,
  validateAgentSupplyChainOperationResult,
} from "./request-contract";

const MAX_CONFIG_BYTES = 1024 * 1024;
const MAX_REQUEST_BYTES = 256 * 1024;

export async function runNativeAgentSupplyChainPolicy(args: readonly string[]): Promise<number> {
  const parsed = parseArguments(args);
  const config = await readImmutableJson(parsed.configFile, MAX_CONFIG_BYTES);
  const policy = parseNativeAgentSupplyChainPolicy(config.value);
  const controller = new NativeAgentSupplyChainController(
    policy,
    new OfficialNpmAgentRegistry(policy),
    new LockedNativeSupplyChainTools(policy),
  );
  if (parsed.command === "probe") {
    await controller.probe();
    process.stdout.write(canonicalJson({
      schemaVersion: "deviludo.native-agent-supply-chain-probe.v1",
      status: "READY",
      configDigest: config.digest,
    }));
    return 0;
  }
  const requestFile = await readImmutableJson(parsed.requestFile, MAX_REQUEST_BYTES);
  const request = parseAgentSupplyChainRequest(requestFile.value);
  if (commandFor(request) !== parsed.command) invalid();
  const root = await responseBoundary(parsed.requestFile, parsed.responseFile);
  let response: AgentSupplyChainResponse | AgentSupplyChainTerminalFailureReceipt;
  let exitCode = 0;
  try {
    response = await controller.execute(request, root);
  } catch (error) {
    if (!(error instanceof NativePolicyViolation) || agentSupplyChainOperationKind(request) === "DISCOVER") throw error;
    response = terminalFailure(request, error);
    exitCode = 42;
  }
  validateAgentSupplyChainOperationResult(response, request);
  await writeFile(parsed.responseFile, canonicalJson(response), { flag: "wx", mode: 0o400 });
  return exitCode;
}

type ParsedArguments =
  | Readonly<{ command: "probe"; configFile: string }>
  | Readonly<{
    command: "discover-version" | "validate-version" | "build-installation" | "rollout-installation";
    configFile: string; requestFile: string; responseFile: string;
  }>;

function parseArguments(args: readonly string[]): ParsedArguments {
  if (args[0] === "probe") {
    if (args.length !== 4 || args[1] !== "--config-file" || args[3] !== "--json") invalid();
    return Object.freeze({ command: "probe", configFile: absolute(args[2]) });
  }
  const command = args[0];
  if (command !== "discover-version" && command !== "validate-version"
    && command !== "build-installation" && command !== "rollout-installation") invalid();
  if (args.length !== 7 || args[1] !== "--config-file" || args[3] !== "--request-file" || args[5] !== "--response-file") invalid();
  const configFile = absolute(args[2]);
  const requestFile = absolute(args[4]);
  const responseFile = absolute(args[6]);
  if (new Set([configFile, requestFile, responseFile]).size !== 3) invalid();
  return Object.freeze({ command, configFile, requestFile, responseFile });
}

async function readImmutableJson(path: string, maximum: number): Promise<Readonly<{ value: unknown; digest: string }>> {
  const file = await open(path, constants.O_RDONLY | constants.O_NOFOLLOW);
  try {
    const before = await file.stat();
    if (!before.isFile() || before.size < 2 || before.size > maximum) invalid();
    const contents = await file.readFile();
    const after = await file.stat();
    if (after.size !== before.size || after.mtimeMs !== before.mtimeMs) invalid();
    let value: unknown;
    try { value = JSON.parse(contents.toString("utf8")) as unknown; } catch { invalid(); }
    return Object.freeze({ value, digest: createHash("sha256").update(contents).digest("hex") });
  } finally { await file.close(); }
}

async function responseBoundary(requestFile: string, responseFile: string): Promise<string> {
  const [requestRoot, responseRoot] = await Promise.all([realpath(dirname(requestFile)), realpath(dirname(responseFile))]);
  if (requestRoot !== responseRoot || !requestFile.startsWith(`${requestRoot}${sep}`) || !responseFile.startsWith(`${responseRoot}${sep}`)) invalid();
  return responseRoot;
}

function terminalFailure(request: AgentSupplyChainRequest, error: NativePolicyViolation): AgentSupplyChainTerminalFailureReceipt {
  const operationKind = agentSupplyChainOperationKind(request);
  if (operationKind === "DISCOVER") invalid();
  const failedAt = new Date().toISOString();
  const core = Object.freeze({
    schemaVersion: "deviludo.agent-supply-chain-terminal-failure.v1" as const,
    operationKey: request.operationKey,
    requestDigest: request.requestDigest,
    operationKind,
    disposition: operationKind === "VALIDATE" ? "REJECTED" as const : "QUARANTINED" as const,
    failureCode: error.failureCode,
    evidenceDigest: error.evidenceDigest,
    failureReceiptId: `failure-${operationKind.toLowerCase()}-${request.operationKey.slice(0, 32)}`,
    failedAt,
  });
  return Object.freeze({ ...core, failureReceiptDigest: sha256Canonical(core) });
}

function commandFor(request: AgentSupplyChainRequest): ParsedArguments["command"] {
  switch (request.schemaVersion) {
    case "deviludo.agent-version-discovery-request.v1": return "discover-version";
    case "deviludo.agent-version-validation-request.v1": return "validate-version";
    case "deviludo.agent-installation-build-request.v1": return "build-installation";
    case "deviludo.agent-installation-rollout-request.v1": return "rollout-installation";
  }
}
function absolute(value: string | undefined): string { if (!value || !isAbsolute(value) || resolve(value) !== value || value.length > 4096 || /\0/.test(value)) invalid(); return value; }
function invalid(): never { throw new Error("Native Agent supply-chain invocation is invalid"); }

if (process.argv[1] && import.meta.url === pathToFileURL(process.argv[1]).href) {
  void runNativeAgentSupplyChainPolicy(process.argv.slice(2))
    .then((code) => { process.exitCode = code; })
    .catch(() => { process.exitCode = 1; });
}
