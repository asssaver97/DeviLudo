export type SpecDialogueRole = "assistant" | "user";
export type SpecTargetPlatform = "windows" | "linux" | "macos";

export interface SpecDialogueMessage {
  readonly id: string;
  readonly sequence: number;
  readonly role: SpecDialogueRole;
  readonly text: string;
  readonly createdAt: string;
}

export interface SpecAcceptanceCriterion {
  readonly id: string;
  readonly description: string;
  readonly required: boolean;
}

export interface GeneratedGameSpec {
  readonly title: string;
  readonly elevatorPitch: string;
  readonly genre: string;
  readonly godotVersion: string;
  readonly targetPlatforms: readonly SpecTargetPlatform[];
  readonly features: readonly string[];
  readonly acceptanceCriteria: readonly SpecAcceptanceCriterion[];
}

export interface GeneratedTestPlan {
  readonly version: string;
  readonly scenarios: readonly string[];
  readonly minimumFps: number;
  readonly maxCrashCount: 0;
}

export interface SpecModelResult {
  readonly assistantMessage: string;
  readonly completeness: number;
  readonly openQuestions: readonly string[];
  readonly spec: GeneratedGameSpec;
  readonly testPlan: GeneratedTestPlan;
}

export interface SpecDialogueSnapshot {
  readonly tenantId: string;
  readonly projectId: string;
  readonly conversationId: string;
  readonly revision: number;
  readonly state: "DRAFT" | "APPROVED";
  readonly specRevisionId: string | null;
  readonly specDigest: string | null;
  readonly testPlanRevisionId: string | null;
  readonly testPlanDigest: string | null;
  readonly messages: readonly SpecDialogueMessage[];
  readonly result: SpecModelResult | null;
}

export interface SpecDialogueCommand {
  readonly operationKey: string;
  readonly tenantId: string;
  readonly projectId: string;
  readonly conversationId: string;
  readonly actorId: string;
  readonly expectedRevision: number;
  readonly message: string;
}

export interface SpecDialogueLookup {
  readonly tenantId: string;
  readonly projectId: string;
  readonly conversationId: string;
}

export interface SpecApprovalCommand {
  readonly operationKey: string;
  readonly tenantId: string;
  readonly projectId: string;
  readonly conversationId: string;
  readonly actorId: string;
  readonly expectedRevision: number;
  readonly specRevisionId: string;
  readonly testPlanRevisionId: string;
}

export interface SpecApprovalReceipt {
  readonly operationKey: string;
  readonly tenantId: string;
  readonly projectId: string;
  readonly conversationId: string;
  readonly revision: number;
  readonly state: "APPROVED";
  readonly specRevisionId: string;
  readonly specDigest: string;
  readonly testPlanRevisionId: string;
  readonly testPlanDigest: string;
  readonly targetMatrix: readonly SpecTargetPlatform[];
  readonly godotVersion: string;
  readonly approvedAt: string;
}

const SHA256 = /^[a-f0-9]{64}$/;
const SAFE_ID = /^[A-Za-z0-9][A-Za-z0-9._:-]{0,199}$/;
const GODOT_VERSION = /^4\.[0-9]+\.[0-9]+(?:[.-][A-Za-z0-9]+)*$/;
const TESTKIT_VERSION = /^godot-testkit-[0-9]+\.[0-9]+\.[0-9]+(?:-[0-9A-Za-z.-]+)?$/;
const PLATFORM_ORDER: readonly SpecTargetPlatform[] = Object.freeze(["linux", "macos", "windows"]);

export function parseSpecDialogueCommand(value: unknown): SpecDialogueCommand {
  const body = exactObject(value, ["actorId", "conversationId", "expectedRevision", "message", "operationKey", "projectId", "tenantId"]);
  const operationKey = requiredString(body.operationKey, 64);
  const tenantId = requiredId(body.tenantId);
  const projectId = requiredId(body.projectId);
  const conversationId = requiredId(body.conversationId);
  const actorId = requiredId(body.actorId);
  const message = requiredText(body.message, 1, 4_000);
  if (!SHA256.test(operationKey) || !Number.isSafeInteger(body.expectedRevision)
    || (body.expectedRevision as number) < 0 || (body.expectedRevision as number) > 1_000_000) invalid();
  return Object.freeze({
    operationKey, tenantId, projectId, conversationId, actorId,
    expectedRevision: body.expectedRevision as number,
    message,
  });
}

export function parseSpecDialogueLookup(value: unknown): SpecDialogueLookup {
  const body = exactObject(value, ["conversationId", "projectId", "tenantId"]);
  return Object.freeze({
    tenantId: requiredId(body.tenantId),
    projectId: requiredId(body.projectId),
    conversationId: requiredId(body.conversationId),
  });
}

export function parseSpecApprovalCommand(value: unknown): SpecApprovalCommand {
  const body = exactObject(value, ["actorId", "conversationId", "expectedRevision", "operationKey", "projectId", "specRevisionId", "tenantId", "testPlanRevisionId"]);
  const operationKey = requiredString(body.operationKey, 64);
  if (!SHA256.test(operationKey) || !Number.isSafeInteger(body.expectedRevision)
    || (body.expectedRevision as number) < 1 || (body.expectedRevision as number) > 1_000_000) invalid();
  return Object.freeze({
    operationKey,
    tenantId: requiredId(body.tenantId),
    projectId: requiredId(body.projectId),
    conversationId: requiredId(body.conversationId),
    actorId: requiredId(body.actorId),
    expectedRevision: body.expectedRevision as number,
    specRevisionId: requiredId(body.specRevisionId),
    testPlanRevisionId: requiredId(body.testPlanRevisionId),
  });
}

export function parseSpecModelResult(value: unknown): SpecModelResult {
  const body = exactObject(value, ["assistantMessage", "completeness", "openQuestions", "spec", "testPlan"]);
  if (!Number.isSafeInteger(body.completeness) || (body.completeness as number) < 0 || (body.completeness as number) > 100) invalid();
  const specBody = exactObject(body.spec, ["acceptanceCriteria", "elevatorPitch", "features", "genre", "godotVersion", "targetPlatforms", "title"]);
  const planBody = exactObject(body.testPlan, ["maxCrashCount", "minimumFps", "scenarios", "version"]);
  const platforms = uniqueStrings(specBody.targetPlatforms, 1, 3, 16).map((item) => {
    if (item !== "windows" && item !== "linux" && item !== "macos") invalid();
    return item;
  }).sort((left, right) => PLATFORM_ORDER.indexOf(left) - PLATFORM_ORDER.indexOf(right));
  const acceptance = array(specBody.acceptanceCriteria, 1, 24).map((item) => {
    const criterion = exactObject(item, ["description", "id", "required"]);
    const id = requiredString(criterion.id, 80);
    if (!/^[A-Za-z0-9][A-Za-z0-9._:-]{0,79}$/.test(id) || typeof criterion.required !== "boolean") invalid();
    return Object.freeze({ id, description: requiredText(criterion.description, 1, 500), required: criterion.required });
  });
  if (new Set(acceptance.map((item) => item.id)).size !== acceptance.length) invalid();
  const godotVersion = requiredString(specBody.godotVersion, 80);
  const testVersion = requiredString(planBody.version, 100);
  if (!GODOT_VERSION.test(godotVersion) || !TESTKIT_VERSION.test(testVersion)
    || !Number.isSafeInteger(planBody.minimumFps) || (planBody.minimumFps as number) < 30 || (planBody.minimumFps as number) > 240
    || planBody.maxCrashCount !== 0) invalid();
  return Object.freeze({
    assistantMessage: requiredText(body.assistantMessage, 1, 4_000),
    completeness: body.completeness as number,
    openQuestions: Object.freeze(uniqueStrings(body.openQuestions, 0, 12, 500)),
    spec: Object.freeze({
      title: requiredText(specBody.title, 1, 160),
      elevatorPitch: requiredText(specBody.elevatorPitch, 1, 1_000),
      genre: requiredText(specBody.genre, 1, 160),
      godotVersion,
      targetPlatforms: Object.freeze(platforms),
      features: Object.freeze(uniqueStrings(specBody.features, 1, 32, 240)),
      acceptanceCriteria: Object.freeze(acceptance),
    }),
    testPlan: Object.freeze({
      version: testVersion,
      scenarios: Object.freeze(uniqueStrings(planBody.scenarios, 1, 32, 240)),
      minimumFps: planBody.minimumFps as number,
      maxCrashCount: 0,
    }),
  });
}

function exactObject(value: unknown, expectedKeys: readonly string[]): Record<string, unknown> {
  if (!value || typeof value !== "object" || Array.isArray(value)) invalid();
  const body = value as Record<string, unknown>;
  if (JSON.stringify(Object.keys(body).sort()) !== JSON.stringify([...expectedKeys].sort())) invalid();
  return body;
}

function array(value: unknown, minimum: number, maximum: number): readonly unknown[] {
  if (!Array.isArray(value) || value.length < minimum || value.length > maximum) invalid();
  return value;
}

function uniqueStrings(value: unknown, minimum: number, maximum: number, maxLength: number): string[] {
  const values = array(value, minimum, maximum).map((item) => requiredText(item, 1, maxLength));
  if (new Set(values).size !== values.length) invalid();
  return values;
}

function requiredId(value: unknown): string {
  const result = requiredString(value, 200);
  if (!SAFE_ID.test(result)) invalid();
  return result;
}

function requiredString(value: unknown, maximum: number): string {
  if (typeof value !== "string" || value.length < 1 || value.length > maximum || /[\u0000-\u001f\u007f]/.test(value)) invalid();
  return value;
}

function requiredText(value: unknown, minimum: number, maximum: number): string {
  if (typeof value !== "string") invalid();
  const result = value.trim();
  if (result.length < minimum || result.length > maximum || /\u0000/.test(result)) invalid();
  return result;
}

function invalid(): never { throw new SpecDialogueRequestError(); }

export class SpecDialogueRequestError extends Error {
  readonly code = "INVALID_SPEC_DIALOGUE_REQUEST";
  constructor() { super("Specification dialogue request is invalid"); }
}
