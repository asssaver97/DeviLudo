import { createHash } from "node:crypto";
import { win32 } from "node:path";
import { sha256Canonical } from "./canonical";

const MAGIC = Buffer.from("DEVILUDO_SCM_V1\0", "ascii");
const SHA256 = /^[a-f0-9]{64}$/;
const MAX_REQUEST_BYTES = 256 * 1024;
const MAX_PATH_CHARS = 32_767;
const MAX_ENVIRONMENT_ENTRIES = 128;
const MAX_ENVIRONMENT_VALUE_CHARS = 8_192;
const INLINE_CREDENTIAL_NAME = /(?:API_KEY|PASSWORD|TOKEN|SECRET|SESSION|PRIVATE_KEY)$/;
const SAFE_CREDENTIAL_REFERENCE = /(?:_FILE|_KEY_ID|_PUBLIC_KEY|_DIGEST)$/;
const COMPONENT_IDS = Object.freeze({ "physical-runner": 1, "steam-client-connector": 2, "steam-depot-finalizer": 3 });
const COMPONENT_NAMES = Object.freeze({ 1: "physical-runner", 2: "steam-client-connector", 3: "steam-depot-finalizer" });
const SERVICE_NAMES = Object.freeze({
  "physical-runner": "DeviLudoPhysicalRunner",
  "steam-client-connector": "DeviLudoSteamConnector",
  "steam-depot-finalizer": "DeviLudoSteamDepotFinalizer",
});
const SERVICE_ACCOUNTS = Object.freeze({
  "physical-runner": "NT SERVICE\\DeviLudoPhysicalRunner",
  "steam-client-connector": "NT SERVICE\\DeviLudoSteamConnector",
  "steam-depot-finalizer": "NT SERVICE\\DeviLudoSteamDepotFinalizer",
});
const TARGET_FILES = Object.freeze({
  "physical-runner": "deviludo-physical-runner.exe",
  "steam-client-connector": "deviludo-steam-client-connector.exe",
  "steam-depot-finalizer": "node.exe",
});
const DESCRIPTOR_KEYS = Object.freeze([
  "account", "arguments", "binaryPathDigest", "binaryPathName", "bridgeContractVersion", "bridgeManifestDigest",
  "bridgeTrustPolicyDigest", "environment", "failureActions", "requiresServiceBridgeContractVersion", "schemaVersion",
  "serviceName", "startType", "targetDigest", "targetExecutable",
]);
const FINALIZER_DESCRIPTOR_KEYS = Object.freeze([
  "account", "arguments", "bridgeDigest", "bridgeExecutable", "environment", "failureActions", "interactive",
  "requiredPrivileges", "schemaVersion", "serviceId", "serviceSidType", "targetExecutable",
  "targetExecutableDigest", "workingDirectory",
]);

type WindowsScmComponent = keyof typeof COMPONENT_IDS;

export interface WindowsScmActuationRequest {
  readonly schemaVersion: "deviludo.windows-scm-actuation-request.v1";
  readonly transactionDigest: string;
  readonly bridgePath: string;
  readonly bridgeDigest: string;
  readonly services: readonly Readonly<{
    component: WindowsScmComponent;
    targetPath: string;
    targetDigest: string;
    descriptorDigest: string;
    environment: Readonly<Record<string, string>>;
  }>[];
}

export function encodeWindowsScmActuationRequest(value: unknown): Buffer {
  const request = normalizeRequest(value);
  const chunks: Buffer[] = [];
  chunks.push(MAGIC, u32(1), u32(0), digestBytes(request.transactionDigest), digestBytes(request.bridgeDigest),
    u16(request.bridgePath.length), Buffer.from([request.services.length, 0]), utf16(request.bridgePath));
  for (const service of request.services) {
    const entries = Object.entries(service.environment);
    chunks.push(Buffer.from([COMPONENT_IDS[service.component]]), digestBytes(service.targetDigest),
      digestBytes(service.descriptorDigest), u16(service.targetPath.length), u16(entries.length), utf16(service.targetPath));
    for (const [name, entryValue] of entries) {
      chunks.push(Buffer.from([name.length]), u16(entryValue.length), Buffer.from(name, "ascii"), utf16(entryValue));
    }
  }
  const body = Buffer.concat(chunks);
  if (body.length < 128 || body.length > MAX_REQUEST_BYTES) invalid();
  body.writeUInt32LE(body.length, MAGIC.length + 4);
  return body;
}

export function createWindowsScmActuationRequest(transactionValue: unknown): WindowsScmActuationRequest {
  const transaction = record(transactionValue);
  const core = { ...transaction }; delete core.transactionDigest;
  if (transaction.schemaVersion === "deviludo.steam-depot-finalizer-host-transaction.v1") {
    return createFinalizerRequest(transaction, core);
  }
  if (transaction.schemaVersion !== "deviludo.runner-native-service-transaction.v1" || transaction.status !== "READY"
    || transaction.platform !== "windows" || typeof transaction.transactionDigest !== "string"
    || transaction.transactionDigest !== sha256Canonical(core) || !Array.isArray(transaction.definitions)
    || !new Set([1, 2]).has(transaction.definitions.length)) invalid();
  const actuator = record(transaction.windowsActuator);
  if (actuator.verified !== true || actuator.component !== "deviludo-windows-scm-native-actuator"
    || actuator.requestContractVersion !== 1 || !SHA256.test(string(actuator.binaryDigest))
    || !SHA256.test(string(actuator.manifestDigest)) || !SHA256.test(string(actuator.trustPolicyDigest))
    || !canonicalWindowsPath(string(actuator.path), "deviludo-windows-scm-native-actuator.exe")
    || transaction.managerTool !== actuator.path) invalid();
  const services = transaction.definitions.map((candidate) => {
    const definition = record(candidate);
    if (typeof definition.component !== "string" || !Object.hasOwn(COMPONENT_IDS, definition.component)
      || typeof definition.rendered !== "string" || !SHA256.test(string(definition.renderedDigest))
      || createHash("sha256").update(definition.rendered).digest("hex") !== definition.renderedDigest) invalid();
    let descriptor: Record<string, unknown>;
    try { descriptor = record(JSON.parse(definition.rendered)); } catch { invalid(); }
    exactKeys(descriptor, DESCRIPTOR_KEYS);
    const component = definition.component as keyof typeof COMPONENT_IDS;
    const bridgePath = string(descriptor.binaryPathName);
    const targetPath = string(descriptor.targetExecutable);
    if (descriptor.schemaVersion !== "deviludo.windows-scm-service-descriptor.v1"
      || descriptor.serviceName !== SERVICE_NAMES[component] || definition.serviceId !== SERVICE_NAMES[component]
      || descriptor.account !== SERVICE_ACCOUNTS[component] || definition.account !== SERVICE_ACCOUNTS[component]
      || definition.manager !== "WINDOWS_SCM" || definition.format !== "WINDOWS_SCM_DESCRIPTOR"
      || definition.destination !== `SCM:${SERVICE_NAMES[component]}`
      || descriptor.bridgeContractVersion !== 1 || descriptor.requiresServiceBridgeContractVersion !== 1
      || descriptor.startType !== "AUTO_START" || JSON.stringify(descriptor.arguments) !== "[]"
      || !canonicalWindowsPath(bridgePath, "deviludo-windows-scm-service-bridge.exe")
      || !canonicalWindowsPath(targetPath, TARGET_FILES[component]) || !SHA256.test(string(descriptor.binaryPathDigest))
      || !SHA256.test(string(descriptor.targetDigest)) || descriptor.targetDigest !== definition.targetExecutableDigest
      || descriptor.binaryPathDigest !== definition.executableDigest || !SHA256.test(string(descriptor.bridgeManifestDigest))
      || !SHA256.test(string(descriptor.bridgeTrustPolicyDigest))
      || definition.executable !== bridgePath || definition.targetExecutable !== targetPath
      || !Array.isArray(descriptor.failureActions) || descriptor.failureActions.length !== 1
      || JSON.stringify(descriptor.failureActions[0]) !== JSON.stringify({ action: "RESTART", delaySeconds: 5 })) invalid();
    const environment = normalizeEnvironment(descriptor.environment);
    return Object.freeze({
      component,
      targetPath,
      targetDigest: descriptor.targetDigest as string,
      descriptorDigest: definition.renderedDigest as string,
      environment,
      bridgePath,
      bridgeDigest: descriptor.binaryPathDigest as string,
    });
  });
  const expected = services.length === 2
    ? ["steam-client-connector", "physical-runner"] : ["physical-runner"];
  if (JSON.stringify(services.map(({ component }) => component)) !== JSON.stringify(expected)
    || services.some(({ bridgePath, bridgeDigest }) =>
      bridgePath !== services[0]?.bridgePath || bridgeDigest !== services[0]?.bridgeDigest)) invalid();
  return deepFreeze({
    schemaVersion: "deviludo.windows-scm-actuation-request.v1",
    transactionDigest: transaction.transactionDigest,
    bridgePath: services[0]?.bridgePath,
    bridgeDigest: services[0]?.bridgeDigest,
    services: services.map((service) => ({
      component: service.component,
      targetPath: service.targetPath,
      targetDigest: service.targetDigest,
      descriptorDigest: service.descriptorDigest,
      environment: service.environment,
    })),
  }) as WindowsScmActuationRequest;
}

function createFinalizerRequest(
  transaction: Record<string, unknown>,
  core: Record<string, unknown>,
): WindowsScmActuationRequest {
  if (transaction.status !== "READY" || transaction.platform !== "windows"
    || typeof transaction.transactionDigest !== "string" || transaction.transactionDigest !== sha256Canonical(core)) invalid();
  const actuator = record(transaction.windowsActuator);
  const bridge = record(transaction.windowsBridge);
  if (actuator.verified !== true || actuator.component !== "deviludo-windows-scm-native-actuator"
    || actuator.requestContractVersion !== 1 || !atLeastVersion(actuator.actuatorVersion, 1, 1, 0)
    || !SHA256.test(string(actuator.binaryDigest)) || !SHA256.test(string(actuator.manifestDigest))
    || !SHA256.test(string(actuator.trustPolicyDigest))
    || !canonicalWindowsPath(string(actuator.path), "deviludo-windows-scm-native-actuator.exe")
    || transaction.managerTool !== actuator.path || transaction.manager !== "WINDOWS_SCM"
    || bridge.verified !== true || bridge.component !== "deviludo-windows-scm-service-bridge"
    || bridge.contractVersion !== 1 || !atLeastVersion(bridge.bridgeVersion, 1, 1, 0)
    || !SHA256.test(string(bridge.binaryDigest)) || !SHA256.test(string(bridge.manifestDigest))
    || !SHA256.test(string(bridge.trustPolicyDigest))
    || !canonicalWindowsPath(string(bridge.path), "deviludo-windows-scm-service-bridge.exe")) invalid();
  const definition = record(transaction.definition);
  if (typeof definition.rendered !== "string" || !SHA256.test(string(definition.renderedDigest))
    || createHash("sha256").update(definition.rendered).digest("hex") !== definition.renderedDigest) invalid();
  let descriptor: Record<string, unknown>;
  try { descriptor = record(JSON.parse(definition.rendered)); } catch { invalid(); }
  exactKeys(descriptor, FINALIZER_DESCRIPTOR_KEYS);
  const targetPath = string(descriptor.targetExecutable);
  const bridgePath = string(descriptor.bridgeExecutable);
  const argumentsValue = descriptor.arguments;
  const workingDirectory = string(descriptor.workingDirectory);
  if (descriptor.schemaVersion !== "deviludo.windows-scm-service-definition.v1"
    || descriptor.serviceId !== SERVICE_NAMES["steam-depot-finalizer"]
    || definition.serviceId !== SERVICE_NAMES["steam-depot-finalizer"]
    || descriptor.account !== SERVICE_ACCOUNTS["steam-depot-finalizer"]
    || definition.account !== SERVICE_ACCOUNTS["steam-depot-finalizer"]
    || descriptor.serviceSidType !== "RESTRICTED" || descriptor.interactive !== false
    || definition.manager !== "WINDOWS_SCM" || definition.format !== "WINDOWS_SCM_DESCRIPTOR"
    || definition.destination !== `SCM:${SERVICE_NAMES["steam-depot-finalizer"]}`
    || !canonicalWindowsPath(bridgePath, "deviludo-windows-scm-service-bridge.exe")
    || bridgePath !== bridge.path || descriptor.bridgeDigest !== bridge.binaryDigest
    || !canonicalWindowsPath(targetPath, TARGET_FILES["steam-depot-finalizer"])
    || !SHA256.test(string(descriptor.targetExecutableDigest))
    || descriptor.targetExecutableDigest !== definition.targetExecutableDigest
    || definition.executable !== bridgePath || definition.executableDigest !== bridge.binaryDigest
    || definition.targetExecutable !== targetPath || !Array.isArray(argumentsValue) || argumentsValue.length !== 1
    || !canonicalWindowsPath(string(argumentsValue[0]), "deviludo-steam-depot-finalizer-service.mjs")
    || win32.dirname(string(argumentsValue[0])).toLowerCase() !== workingDirectory.toLowerCase()
    || !canonicalWindowsDirectory(workingDirectory)
    || !Array.isArray(descriptor.requiredPrivileges) || descriptor.requiredPrivileges.length !== 0
    || !Array.isArray(descriptor.failureActions) || descriptor.failureActions.length !== 1
    || JSON.stringify(descriptor.failureActions[0]) !== JSON.stringify({ action: "RESTART", delayMs: 5_000 })) invalid();
  const environment = normalizeEnvironment(descriptor.environment);
  if (environment.DEVILUDO_STEAM_DEPOT_FINALIZER_SERVICE_ARTIFACT_FILE !== argumentsValue[0]) invalid();
  return deepFreeze({
    schemaVersion: "deviludo.windows-scm-actuation-request.v1",
    transactionDigest: transaction.transactionDigest,
    bridgePath,
    bridgeDigest: bridge.binaryDigest,
    services: [{
      component: "steam-depot-finalizer",
      targetPath,
      targetDigest: descriptor.targetExecutableDigest,
      descriptorDigest: definition.renderedDigest,
      environment,
    }],
  }) as WindowsScmActuationRequest;
}

export function decodeWindowsScmActuationRequest(bytes: Buffer): WindowsScmActuationRequest {
  if (!Buffer.isBuffer(bytes) || bytes.length < 128 || bytes.length > MAX_REQUEST_BYTES
    || !bytes.subarray(0, MAGIC.length).equals(MAGIC)) invalid();
  let offset = MAGIC.length;
  const version = readU32(bytes, offset); offset += 4;
  const totalLength = readU32(bytes, offset); offset += 4;
  if (version !== 1 || totalLength !== bytes.length) invalid();
  const transactionDigest = readDigest(bytes, offset); offset += 32;
  const bridgeDigest = readDigest(bytes, offset); offset += 32;
  const bridgePathChars = readU16(bytes, offset); offset += 2;
  const serviceCount = readU8(bytes, offset); offset += 1;
  if (readU8(bytes, offset) !== 0 || !new Set([1, 2]).has(serviceCount)) invalid();
  offset += 1;
  const bridge = readUtf16(bytes, offset, bridgePathChars); offset = bridge.offset;
  if (!canonicalWindowsPath(bridge.value, "deviludo-windows-scm-service-bridge.exe")) invalid();
  const services = [];
  for (let index = 0; index < serviceCount; index++) {
    const componentId = readU8(bytes, offset); offset += 1;
    const component = COMPONENT_NAMES[componentId as keyof typeof COMPONENT_NAMES];
    if (!component) invalid();
    const targetDigest = readDigest(bytes, offset); offset += 32;
    const descriptorDigest = readDigest(bytes, offset); offset += 32;
    const targetPathChars = readU16(bytes, offset); offset += 2;
    const environmentCount = readU16(bytes, offset); offset += 2;
    if (environmentCount > MAX_ENVIRONMENT_ENTRIES) invalid();
    const target = readUtf16(bytes, offset, targetPathChars); offset = target.offset;
    if (!canonicalWindowsPath(target.value, TARGET_FILES[component])) invalid();
    const environment: Record<string, string> = {};
    let previousName = "";
    for (let envIndex = 0; envIndex < environmentCount; envIndex++) {
      const nameLength = readU8(bytes, offset); offset += 1;
      const valueLength = readU16(bytes, offset); offset += 2;
      if (nameLength < 1 || nameLength > 255 || valueLength > MAX_ENVIRONMENT_VALUE_CHARS
        || offset + nameLength > bytes.length) invalid();
      const nameBytes = bytes.subarray(offset, offset + nameLength);
      if ([...nameBytes].some((character) => !(character >= 0x41 && character <= 0x5a)
        && !(character >= 0x30 && character <= 0x39) && character !== 0x5f)) invalid();
      const name = nameBytes.toString("ascii"); offset += nameLength;
      if (previousName && previousName >= name) invalid();
      const entry = readUtf16(bytes, offset, valueLength, MAX_ENVIRONMENT_VALUE_CHARS, true); offset = entry.offset;
      environment[name] = entry.value;
      previousName = name;
    }
    services.push(Object.freeze({ component, targetPath: target.value, targetDigest, descriptorDigest,
      environment: normalizeEnvironment(environment) }));
  }
  if (offset !== bytes.length) invalid();
  return normalizeRequest({ schemaVersion: "deviludo.windows-scm-actuation-request.v1", transactionDigest,
    bridgePath: bridge.value, bridgeDigest, services });
}

export function windowsScmActuationRequestDigest(bytes: Buffer): string {
  decodeWindowsScmActuationRequest(bytes);
  return createHash("sha256").update(bytes).digest("hex");
}

function normalizeRequest(value: unknown): WindowsScmActuationRequest {
  const request = record(value);
  exactKeys(request, ["bridgeDigest", "bridgePath", "schemaVersion", "services", "transactionDigest"]);
  if (request.schemaVersion !== "deviludo.windows-scm-actuation-request.v1"
    || !SHA256.test(string(request.transactionDigest)) || !SHA256.test(string(request.bridgeDigest))
    || !canonicalWindowsPath(string(request.bridgePath), "deviludo-windows-scm-service-bridge.exe")
    || !Array.isArray(request.services) || !new Set([1, 2]).has(request.services.length)) invalid();
  const services = request.services.map((candidate) => {
    const service = record(candidate);
    exactKeys(service, ["component", "descriptorDigest", "environment", "targetDigest", "targetPath"]);
    if (typeof service.component !== "string" || !Object.hasOwn(COMPONENT_IDS, service.component)
      || !SHA256.test(string(service.targetDigest)) || !SHA256.test(string(service.descriptorDigest))) invalid();
    const component = service.component as keyof typeof COMPONENT_IDS;
    if (!canonicalWindowsPath(string(service.targetPath), TARGET_FILES[component])) invalid();
    return Object.freeze({ component, targetPath: service.targetPath as string, targetDigest: service.targetDigest as string,
      descriptorDigest: service.descriptorDigest as string, environment: normalizeEnvironment(service.environment) });
  });
  const expected = services.length === 2 ? ["steam-client-connector", "physical-runner"]
    : services[0]?.component === "steam-depot-finalizer" ? ["steam-depot-finalizer"] : ["physical-runner"];
  if (JSON.stringify(services.map(({ component }) => component)) !== JSON.stringify(expected)) invalid();
  return deepFreeze({ ...request, services }) as unknown as WindowsScmActuationRequest;
}

function normalizeEnvironment(value: unknown): Readonly<Record<string, string>> {
  const environment = record(value);
  const names = Object.keys(environment);
  if (names.length < 2 || names.length > MAX_ENVIRONMENT_ENTRIES
    || JSON.stringify(names) !== JSON.stringify([...names].sort())) invalid();
  const normalized: Record<string, string> = {};
  for (const name of names) {
    const entry = environment[name];
    if (!/^[A-Z][A-Z0-9_]{0,254}$/.test(name) || typeof entry !== "string"
      || entry.length > MAX_ENVIRONMENT_VALUE_CHARS || /[\0\r\n]/.test(entry)
      || INLINE_CREDENTIAL_NAME.test(name) && !SAFE_CREDENTIAL_REFERENCE.test(name)) invalid();
    normalized[name] = entry;
  }
  return Object.freeze(normalized);
}

function canonicalWindowsPath(value: string, expectedFile: string): boolean {
  return value.length >= 4 && value.length <= MAX_PATH_CHARS && /^[A-Za-z]:\\[^:*?"<>|/]+$/.test(value)
    && !/(?:^|\\)\.\.?(?:\\|$)/.test(value)
    && value.slice(value.lastIndexOf("\\") + 1).toLowerCase() === expectedFile.toLowerCase();
}
function canonicalWindowsDirectory(value: string): boolean {
  return value.length >= 3 && value.length <= MAX_PATH_CHARS && /^[A-Za-z]:\\[^:*?"<>|/]*$/.test(value)
    && !/(?:^|\\)\.\.?(?:\\|$)/.test(value) && !value.endsWith("\\");
}
function atLeastVersion(value: unknown, major: number, minor: number, patch: number): boolean {
  if (typeof value !== "string") return false;
  const match = /^(\d+)\.(\d+)\.(\d+)(?:-[0-9A-Za-z.-]+)?$/.exec(value);
  if (!match || /(latest|stable|default)/i.test(value)) return false;
  const observed = match.slice(1, 4).map(Number);
  return observed[0] > major || observed[0] === major && (observed[1] > minor
    || observed[1] === minor && observed[2] >= patch);
}
function utf16(value: string): Buffer { const bytes = Buffer.from(value, "utf16le"); if (bytes.length !== value.length * 2) invalid(); return bytes; }
function digestBytes(value: string): Buffer { if (!SHA256.test(value)) invalid(); return Buffer.from(value, "hex"); }
function u16(value: number): Buffer { if (!Number.isSafeInteger(value) || value < 0 || value > 0xffff) invalid(); const out = Buffer.alloc(2); out.writeUInt16LE(value); return out; }
function u32(value: number): Buffer { if (!Number.isSafeInteger(value) || value < 0 || value > 0xffffffff) invalid(); const out = Buffer.alloc(4); out.writeUInt32LE(value); return out; }
function readU8(bytes: Buffer, offset: number): number { if (offset < 0 || offset >= bytes.length) invalid(); return bytes.readUInt8(offset); }
function readU16(bytes: Buffer, offset: number): number { if (offset < 0 || offset + 2 > bytes.length) invalid(); return bytes.readUInt16LE(offset); }
function readU32(bytes: Buffer, offset: number): number { if (offset < 0 || offset + 4 > bytes.length) invalid(); return bytes.readUInt32LE(offset); }
function readDigest(bytes: Buffer, offset: number): string { if (offset < 0 || offset + 32 > bytes.length) invalid(); return bytes.subarray(offset, offset + 32).toString("hex"); }
function readUtf16(
  bytes: Buffer,
  offset: number,
  chars: number,
  maximum = MAX_PATH_CHARS,
  allowEmpty = false,
): { value: string; offset: number } {
  const length = chars * 2;
  if (!Number.isSafeInteger(chars) || chars < (allowEmpty ? 0 : 1) || chars > maximum
    || offset < 0 || offset + length > bytes.length) invalid();
  const value = bytes.subarray(offset, offset + length).toString("utf16le");
  if (value.length !== chars || /[\0\r\n]/.test(value)
    || !Buffer.from(value, "utf16le").equals(bytes.subarray(offset, offset + length))) invalid();
  return { value, offset: offset + length };
}
function string(value: unknown): string { if (typeof value !== "string") invalid(); return value; }
function record(value: unknown): Record<string, unknown> {
  if (!value || typeof value !== "object" || Array.isArray(value)) invalid();
  const prototype = Object.getPrototypeOf(value);
  if (prototype !== Object.prototype && prototype !== null) invalid();
  return value as Record<string, unknown>;
}
function exactKeys(value: Record<string, unknown>, expected: readonly string[]): void { const actual = Object.keys(value).sort(); const sorted = [...expected].sort(); if (actual.length !== sorted.length || actual.some((key, index) => key !== sorted[index])) invalid(); }
function deepFreeze<T>(value: T): T { Object.freeze(value); for (const child of Object.values(value as Record<string, unknown>)) if (child && typeof child === "object" && !Object.isFrozen(child)) deepFreeze(child); return value; }
function invalid(): never { throw new Error("Windows SCM actuation request is invalid"); }
