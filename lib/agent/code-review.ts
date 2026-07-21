import { createHash } from "node:crypto";
import { assertPinnedModelId } from "./providers";

export const AGENT_CODE_REVIEW_OUTPUT_PATH = ".deviludo-agent-code-review.json";

export type AgentCodeReviewSeverity = "BLOCKING" | "WARNING" | "INFO";

export interface AgentCodeReviewOutput {
  readonly schemaVersion: "deviludo.agent-code-review-output.v1";
  readonly verdict: "PASSED" | "FAILED";
  readonly summary: string;
  readonly findings: readonly Readonly<{
    severity: AgentCodeReviewSeverity;
    code: string;
    path: string | null;
    message: string;
  }>[];
}

export interface AgentCodeReviewReceipt {
  readonly schemaVersion: "deviludo.agent-code-review-receipt.v1";
  readonly receiptId: string;
  readonly runId: string;
  readonly attemptId: string;
  readonly profileRevisionId: string;
  readonly installationId: string;
  readonly imageDigest: string;
  readonly model: string;
  readonly specRevisionId: string;
  readonly testPlanRevisionId: string;
  readonly sourceDigest: string;
  readonly verdict: "PASSED";
  readonly reviewDigest: string;
  readonly findingCount: number;
  readonly warningCount: number;
  readonly reviewedAt: string;
}

const SAFE_ID = /^[A-Za-z0-9][A-Za-z0-9._:-]{0,159}$/;
const SHA256 = /^[a-f0-9]{64}$/;
const IMAGE = /^sha256:[a-f0-9]{64}$/;
const REVIEW_CODE = /^[A-Z][A-Z0-9_]{1,63}$/;

export function parseAgentCodeReviewOutput(value: unknown): AgentCodeReviewOutput {
  const body = record(value);
  exactKeys(body, ["schemaVersion", "verdict", "summary", "findings"]);
  if (body.schemaVersion !== "deviludo.agent-code-review-output.v1"
    || (body.verdict !== "PASSED" && body.verdict !== "FAILED")
    || typeof body.summary !== "string" || !body.summary.trim()
    || Buffer.byteLength(body.summary) > 4_000
    || !Array.isArray(body.findings) || body.findings.length > 200) invalid();
  const findings = body.findings.map((value) => {
    const finding = record(value);
    exactKeys(finding, ["severity", "code", "path", "message"]);
    if ((finding.severity !== "BLOCKING" && finding.severity !== "WARNING" && finding.severity !== "INFO")
      || typeof finding.code !== "string" || !REVIEW_CODE.test(finding.code)
      || finding.path !== null && (typeof finding.path !== "string" || !safePath(finding.path))
      || typeof finding.message !== "string" || !finding.message.trim()
      || Buffer.byteLength(finding.message) > 1_000) invalid();
    return Object.freeze({
      severity: finding.severity,
      code: finding.code,
      path: finding.path as string | null,
      message: finding.message,
    });
  });
  const blocking = findings.some((finding) => finding.severity === "BLOCKING");
  if ((body.verdict === "PASSED") !== !blocking) invalid();
  return Object.freeze({
    schemaVersion: "deviludo.agent-code-review-output.v1",
    verdict: body.verdict,
    summary: body.summary,
    findings: Object.freeze(findings),
  });
}

export function createAgentCodeReviewReceipt(input: Readonly<{
  output: AgentCodeReviewOutput;
  runId: string;
  attemptId: string;
  profileRevisionId: string;
  installationId: string;
  imageDigest: string;
  model: string;
  specRevisionId: string;
  testPlanRevisionId: string;
  sourceDigest: string;
  reviewedAt: string;
}>): AgentCodeReviewReceipt {
  const output = parseAgentCodeReviewOutput(input.output);
  if (output.verdict !== "PASSED") throw new Error("Agent code review contains blocking findings");
  return validateAgentCodeReviewReceipt({
    schemaVersion: "deviludo.agent-code-review-receipt.v1",
    receiptId: `review-${input.attemptId}`,
    runId: input.runId,
    attemptId: input.attemptId,
    profileRevisionId: input.profileRevisionId,
    installationId: input.installationId,
    imageDigest: input.imageDigest,
    model: input.model,
    specRevisionId: input.specRevisionId,
    testPlanRevisionId: input.testPlanRevisionId,
    sourceDigest: input.sourceDigest,
    verdict: "PASSED",
    reviewDigest: digest(output),
    findingCount: output.findings.length,
    warningCount: output.findings.filter((finding) => finding.severity === "WARNING").length,
    reviewedAt: input.reviewedAt,
  });
}

export function validateAgentCodeReviewReceipt(value: unknown): AgentCodeReviewReceipt {
  const body = record(value);
  exactKeys(body, ["schemaVersion", "receiptId", "runId", "attemptId", "profileRevisionId",
    "installationId", "imageDigest", "model", "specRevisionId", "testPlanRevisionId",
    "sourceDigest", "verdict", "reviewDigest", "findingCount", "warningCount", "reviewedAt"]);
  if (body.schemaVersion !== "deviludo.agent-code-review-receipt.v1"
    || body.verdict !== "PASSED"
    || ![body.receiptId, body.runId, body.attemptId, body.profileRevisionId, body.installationId,
      body.specRevisionId, body.testPlanRevisionId].every((item) => typeof item === "string" && SAFE_ID.test(item))
    || body.receiptId !== `review-${body.attemptId}`
    || typeof body.imageDigest !== "string" || !IMAGE.test(body.imageDigest)
    || typeof body.model !== "string" || !pinnedModel(body.model)
    || typeof body.sourceDigest !== "string" || !SHA256.test(body.sourceDigest)
    || typeof body.reviewDigest !== "string" || !SHA256.test(body.reviewDigest)
    || !Number.isSafeInteger(body.findingCount) || (body.findingCount as number) < 0 || (body.findingCount as number) > 200
    || !Number.isSafeInteger(body.warningCount) || (body.warningCount as number) < 0
    || (body.warningCount as number) > (body.findingCount as number)
    || typeof body.reviewedAt !== "string" || !Number.isFinite(Date.parse(body.reviewedAt))
    || new Date(body.reviewedAt).toISOString() !== body.reviewedAt) invalid();
  return Object.freeze({ ...body }) as unknown as AgentCodeReviewReceipt;
}

function safePath(value: string): boolean {
  const parts = value.split("/");
  return value.length <= 500 && !value.startsWith("/") && !value.includes("\\")
    && !/[\u0000-\u001f\u007f]/.test(value)
    && parts.every((part) => Boolean(part) && part !== "." && part !== ".." && part !== ".git");
}

function pinnedModel(value: string): boolean {
  try { assertPinnedModelId(value); return true; }
  catch { return false; }
}

function digest(value: unknown): string {
  return createHash("sha256").update(canonicalJson(value)).digest("hex");
}

function canonicalJson(value: unknown): string {
  if (value === null || typeof value !== "object") return JSON.stringify(value);
  if (Array.isArray(value)) return `[${value.map(canonicalJson).join(",")}]`;
  return `{${Object.entries(value as Record<string, unknown>)
    .sort(([left], [right]) => left.localeCompare(right))
    .map(([key, child]) => `${JSON.stringify(key)}:${canonicalJson(child)}`).join(",")}}`;
}

function record(value: unknown): Record<string, unknown> {
  if (!value || typeof value !== "object" || Array.isArray(value)) invalid();
  return value as Record<string, unknown>;
}

function exactKeys(value: Record<string, unknown>, expected: readonly string[]): void {
  if (JSON.stringify(Object.keys(value).sort()) !== JSON.stringify([...expected].sort())) invalid();
}

function invalid(): never {
  throw new Error("Agent code review contract is invalid");
}
