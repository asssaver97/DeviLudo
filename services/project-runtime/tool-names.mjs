export const ROLE_TO_CANONICAL_TOOLS = Object.freeze({
  INTENT: Object.freeze(["context.read", "conversation.reply", "workflow.intent_decision", "workflow.stop", "workflow.continue"]),
  ANALYSIS: Object.freeze(["context.read", "source.list", "source.read", "diagnostics.run", "context.update_analysis", "conversation.reply"]),
  DESIGN: Object.freeze(["context.read", "requirements.update", "project_document.update", "e2e_goals.update", "conversation.reply", "handoff.create"]),
  UI_DESIGN: Object.freeze(["context.read", "project_document.update", "e2e_goals.update", "conversation.reply", "handoff.create"]),
  DEVELOPMENT: Object.freeze(["context.read", "source.list", "source.read", "source.checkpoint", "assets.plan", "assets.cleanup", "build.request", "conversation.reply", "handoff.create"]),
  TEST: Object.freeze(["context.read", "source.list", "source.read", "test_plan.replace", "e2e.start", "e2e.observe", "evidence.read", "test.verdict", "conversation.reply", "handoff.create"]),
});

export function nativeToolName(canonicalName) {
  if (typeof canonicalName !== "string" || !/^[a-z][a-z0-9_]*\.[a-z][a-z0-9_]*$/.test(canonicalName)) {
    throw new Error("Canonical project Runtime tool name is invalid");
  }
  return canonicalName.replace(".", "_");
}

export function canonicalToolName(role, nativeName) {
  const tools = ROLE_TO_CANONICAL_TOOLS[role];
  if (!tools || typeof nativeName !== "string") return null;
  return tools.find(name => nativeToolName(name) === nativeName) ?? null;
}

export function toolInputSchema(canonicalName) {
  nativeToolName(canonicalName);
  if (canonicalName === "context.read") {
    return Object.freeze({ type: "object", additionalProperties: false });
  }
  if (canonicalName === "project_document.update") {
    return Object.freeze({
      type: "object",
      additionalProperties: false,
      required: Object.freeze(["document"]),
      properties: Object.freeze({
        document: Object.freeze({ type: "object", additionalProperties: true }),
      }),
    });
  }
  if (canonicalName === "e2e_goals.update") {
    return Object.freeze({
      type: "object",
      additionalProperties: false,
      required: Object.freeze(["goals"]),
      properties: Object.freeze({
        goals: Object.freeze({
          type: "array",
          maxItems: 1_000,
          items: Object.freeze({ type: "object", additionalProperties: true }),
        }),
      }),
    });
  }
  if (canonicalName === "handoff.create") {
    return Object.freeze({
      type: "object",
      additionalProperties: false,
      required: Object.freeze(["toRole", "summary"]),
      properties: Object.freeze({
        toRole: Object.freeze({ enum: Object.freeze(["INTENT", "ANALYSIS", "DESIGN", "UI_DESIGN", "DEVELOPMENT", "TEST"]) }),
        summary: Object.freeze({ type: "string", minLength: 1, maxLength: 64_000 }),
      }),
    });
  }
  if (canonicalName === "source.read") {
    return Object.freeze({
      type: "object",
      additionalProperties: false,
      required: ["path"],
      properties: Object.freeze({
        path: { type: "string", minLength: 1, maxLength: 1000 },
        startLine: { type: "integer", minimum: 1, description: "Optional 1-based first line; provide together with endLine for files larger than 1 MiB." },
        endLine: { type: "integer", minimum: 1, description: "Optional inclusive final line; a range may span at most 1000 lines." },
      }),
    });
  }
  if (canonicalName === "test_plan.replace") return testPlanReplaceInputSchema();
  if (canonicalName !== "context.update_analysis") {
    return Object.freeze({ type: "object", additionalProperties: true });
  }
  const text = (maxLength, minLength = 1) => Object.freeze({ type: "string", minLength, maxLength });
  const list = (minItems, maxItems) => Object.freeze({
    type: "array",
    minItems,
    maxItems,
    items: text(300),
  });
  return Object.freeze({
    type: "object",
    additionalProperties: false,
    required: Object.freeze(["analysis"]),
    properties: Object.freeze({
      analysis: Object.freeze({
        type: "object",
        additionalProperties: false,
        required: Object.freeze([
          "name", "introduction", "gameplay", "categories", "features", "coreLoop",
          "playerExperience", "acceptanceCriteria", "gameContent", "currentDevelopmentState",
          "completedWork", "remainingWork", "startupFlow", "startupIssues", "risks",
        ]),
        properties: Object.freeze({
          name: text(200, 2),
          introduction: text(20_000),
          gameplay: text(20_000),
          categories: list(1, 32),
          features: list(1, 32),
          coreLoop: list(1, 32),
          playerExperience: text(4_000),
          acceptanceCriteria: list(1, 32),
          gameContent: text(4_000),
          currentDevelopmentState: text(4_000),
          completedWork: list(0, 32),
          remainingWork: list(0, 32),
          startupFlow: text(4_000),
          startupIssues: list(0, 32),
          risks: list(0, 32),
        }),
      }),
    }),
  });
}

function testPlanReplaceInputSchema() {
  const stableId = { type: "string", pattern: "^[a-z0-9][a-z0-9-]{0,119}$" };
  const assertion = {
    type: "object",
    additionalProperties: false,
    required: ["source", "operator"],
    properties: {
      source: { enum: ["STATE", "PROGRESS", "CONTROL", "SCENE"] },
      key: { type: "string", description: "Exact STATE or PROGRESS field path verified by reading the current source; placeholders are invalid." },
      targetId: stableId,
      property: { enum: ["visible", "enabled", "text", "value"] },
      operator: { enum: ["EQUALS", "NOT_EQUALS", "GREATER_THAN", "GREATER_THAN_OR_EQUALS", "LESS_THAN", "LESS_THAN_OR_EQUALS", "CONTAINS", "EXISTS", "CHANGED"] },
      value: { type: ["string", "number", "boolean"] },
    },
  };
  const interactionEvent = {
    type: "object",
    description: "Action events require unique stepId, intent, coversRequirementIds and non-empty postconditions. Except for START_SESSION, every action requires a CHANGED postcondition for the exact Probe value changed by that input. Checkpoints require id, role, assertions and visualMode. DYNAMIC ACTION/PROGRESS/COMPLETION checkpoints also require changeTargetId.",
    additionalProperties: true,
    required: ["type"],
    properties: {
      type: { enum: ["key_tap", "key_hold", "click", "double_click", "drag", "scroll", "text_input", "gamepad_button_tap", "gamepad_button_hold", "gamepad_axis", "gamepad_trigger", "gamepad_release_all", "wait", "checkpoint"] },
      stepId: stableId,
      intent: { enum: ["START_SESSION", "NAVIGATION", "PRIMARY_ACTION", "FEATURE_ACTION", "COMPLETE_LOOP"] },
      coversRequirementIds: { type: "array", items: stableId, uniqueItems: true },
      postconditions: { type: "array", minItems: 1, maxItems: 32, items: assertion },
      id: stableId,
      role: { enum: ["START", "READY", "ACTION", "PROGRESS", "COMPLETION"] },
      assertions: { type: "array", minItems: 1, maxItems: 32, items: assertion },
      visualMode: { enum: ["DYNAMIC", "STABLE_REPLAY"] },
      changeTargetId: stableId,
      targetId: stableId,
      fromTargetId: stableId,
      toTargetId: stableId,
      key: { type: "string" },
      button: { enum: ["LEFT", "RIGHT", "MIDDLE", "A", "B", "X", "Y", "BACK", "GUIDE", "START", "LEFT_STICK", "RIGHT_STICK", "LEFT_SHOULDER", "RIGHT_SHOULDER", "DPAD_UP", "DPAD_DOWN", "DPAD_LEFT", "DPAD_RIGHT"] },
      axis: { enum: ["LEFT_X", "LEFT_Y", "RIGHT_X", "RIGHT_Y"] },
      trigger: { enum: ["LEFT", "RIGHT"] },
      value: { type: "number", minimum: -1, maximum: 1 },
      deltaY: { type: "integer", minimum: -10000, maximum: 10000 },
      text: { type: "string", minLength: 1, maxLength: 1000 },
      delay_ms: { type: "integer", minimum: 0, maximum: 300000 },
      duration_ms: { type: "integer", minimum: 1, maximum: 300000 },
      referenceImage: { type: "string", pattern: "^res://.+\\.png$" },
      threshold: { type: "number", minimum: 0, maximum: 1 },
      expectedOutput: { type: "string" },
    },
  };
  const requirement = {
    type: "object",
    additionalProperties: false,
    required: ["requirementId", "description", "source", "verificationClass"],
    properties: {
      requirementId: stableId,
      description: { type: "string", minLength: 1, maxLength: 2000 },
      source: { enum: ["CORE_LOOP", "ACCEPTANCE"] },
      verificationClass: { enum: ["PLAYER_INTERACTION", "SYSTEM"] },
      systemCategory: { enum: ["DATA", "RUNTIME", "NETWORK"] },
      exemptionReason: { type: "string", minLength: 10, maxLength: 1000 },
    },
  };
  const feature = {
    type: "object",
    description: "interactive features additionally require interactionScript, timeoutMs and launchProfile; unit features require gdsTestPath, checkNames and timeoutMs.",
    additionalProperties: false,
    required: ["id", "requirementIds", "category", "description", "verificationMethod"],
    properties: {
      id: stableId,
      requirementIds: { type: "array", minItems: 1, items: stableId },
      category: { enum: ["core-loop", "player-control", "data-integrity", "runtime-quality", "ui", "audio", "network"] },
      description: { type: "string", minLength: 1, maxLength: 2000 },
      verificationMethod: { enum: ["unit", "interactive", "visual", "manual"] },
      gdsTestPath: { type: "string", pattern: "^res://.+\\.gd$" },
      checkNames: { type: "array", minItems: 1, items: stableId },
      interactionScript: {
        type: "object",
        additionalProperties: false,
        required: ["events"],
        properties: { events: { type: "array", minItems: 1, maxItems: 200, items: interactionEvent } },
      },
      timeoutMs: { type: "integer", minimum: 1, maximum: 300000 },
      coreJourney: { type: "boolean" },
      launchProfile: {
        type: "object",
        additionalProperties: false,
        required: ["type"],
        properties: { type: { enum: ["FRESH", "SCENARIO"] }, scenarioId: stableId },
      },
      expectedVisual: { type: "object" },
    },
  };
  return Object.freeze({
    type: "object",
    additionalProperties: false,
    required: ["plan"],
    properties: {
      plan: {
        type: "object",
        additionalProperties: false,
        required: ["testManifest", "assetPlacementPlan"],
        properties: {
          testManifest: {
            type: "object",
            description: "The current contract is authoritative; do not copy a project agent.json manifest or invent legacy top-level fields.",
            additionalProperties: false,
            required: ["schema", "inputProfiles", "primaryInputProfile", "adaptivePlayer", "requirements", "features"],
            properties: {
              schema: { const: "deviludo.test-manifest" },
              inputProfiles: { type: "array", minItems: 1, maxItems: 2, uniqueItems: true, items: { enum: ["KEYBOARD_MOUSE", "GAMEPAD"] } },
              primaryInputProfile: { enum: ["KEYBOARD_MOUSE", "GAMEPAD"] },
              adaptivePlayer: {
                type: "object",
                additionalProperties: false,
                required: ["goal", "requirementIds", "allowedActions", "successAssertions", "failureAssertions", "rolloutTimeoutMs", "maxDecisions", "seedStrategy"],
                properties: {
                  goal: { type: "string", minLength: 10, maxLength: 4000 },
                  requirementIds: { type: "array", minItems: 1, uniqueItems: true, items: stableId },
                  allowedActions: { type: "array", minItems: 1, uniqueItems: true, items: { enum: ["KEYBOARD", "POINTER", "GAMEPAD"] } },
                  successAssertions: { type: "array", minItems: 1, maxItems: 32, items: assertion },
                  failureAssertions: { type: "array", minItems: 1, maxItems: 32, items: assertion },
                  rolloutTimeoutMs: { type: "integer", minimum: 240000, maximum: 300000 },
                  maxDecisions: { type: "integer", minimum: 8, maximum: 40 },
                  seedStrategy: { const: "STABLE_PROJECT_PLATFORM" },
                },
              },
              requirements: { type: "array", minItems: 1, maxItems: 500, items: requirement },
              features: { type: "array", minItems: 1, maxItems: 500, items: feature },
            },
          },
          assetPlacementPlan: {
            type: "object",
            additionalProperties: false,
            required: ["schema", "plannedAssetKeys", "placements", "unmappedAssetKeys"],
            properties: {
              schema: { const: "deviludo.asset-placement-plan" },
              plannedAssetKeys: { type: "array", uniqueItems: true, items: { type: "string" } },
              placements: {
                type: "array",
                items: {
                  type: "object",
                  additionalProperties: false,
                  required: ["assetKey", "targetId", "checkpointRole", "expectedResourcePath", "expectedSha256"],
                  properties: {
                    assetKey: { type: "string" }, targetId: stableId,
                    checkpointRole: { enum: ["START", "READY", "ACTION", "PROGRESS", "COMPLETION"] },
                    expectedResourcePath: { type: "string", pattern: "^res://.+\\.(png|jpg|jpeg|webp|svg)$" },
                    expectedSha256: { type: ["string", "null"] },
                  },
                },
              },
              unmappedAssetKeys: { type: "array", maxItems: 0 },
            },
          },
        },
      },
    },
  });
}
