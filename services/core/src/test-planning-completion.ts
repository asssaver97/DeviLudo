import type { ProjectRuntimeTurnResult } from "@/lib/product/project-runtime";

const CONTINUATION_PROMPT = [
  "Continue the unfinished TEST_PLAN work in this same turn. Your previous final reply did not satisfy the durable completion contract.",
  "Read the current source and finish the complete test_plan_replace payload, correct validation errors, and call e2e_start after acceptance. A plan describes production inputs and expected observations; it does not claim those observations already passed. Keep every goal and asset obligation, and let actual execution establish the result.",
  "e2e_observe only reads existing run history; it cannot launch exploration. An empty history does not prevent authoring a plan from published source. Do not repeat an unavailable exploratory request or finish with another progress-only reply.",
  "Only an actually missing source Probe/control/transition permits the durable SOURCE_PROBE_CONTRACT_MISSING Development handoff. Do not invent coverage, evidence, or a product defect to end this turn.",
].join("\n");

/** Resume premature final replies while retaining the original turn, lease and session. */
export async function completeTestPlanning(input: Readonly<{
  run: (continuation: string | null) => Promise<ProjectRuntimeTurnResult>;
  isComplete: (result: ProjectRuntimeTurnResult) => Promise<boolean>;
  signal?: AbortSignal;
  onContinue?: () => void;
}>): Promise<ProjectRuntimeTurnResult> {
  const toolCalls: ProjectRuntimeTurnResult["toolCalls"][number][] = [];
  for (let attempt = 0; attempt < 3; attempt += 1) {
    input.signal?.throwIfAborted();
    const result = await input.run(attempt === 0 ? null : CONTINUATION_PROMPT);
    toolCalls.push(...result.toolCalls);
    input.signal?.throwIfAborted();
    if (await input.isComplete(result)) return Object.freeze({ ...result, toolCalls: Object.freeze(toolCalls) });
    if (attempt < 2) input.onContinue?.();
    else throw new Error(`Test Agent completed without persisting a complete current-turn test plan after bounded continuation: ${result.content.slice(0, 2_000)}`);
  }
  throw new Error("Test planning continuation exhausted");
}
