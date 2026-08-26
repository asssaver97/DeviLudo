#!/usr/bin/env node
import { randomUUID } from "node:crypto";
import { cp, mkdir, readFile, writeFile } from "node:fs/promises";

process.umask(0o002);

const request = JSON.parse((await readStdin()).toString("utf8"));
validateRequest(request);

const startedAt = new Date().toISOString();
const toolCalls = [];
const contextResult = request.role === "INTENT" || request.mode === "COMPACT"
  ? null
  : await callTool("context.read", {});
const context = contextResult?.context ?? null;

let content;
let structured;
if (request.mode === "COMPACT") {
  content = `${request.role} fixture session compacted.`;
  structured = { summary: content };
} else if (request.role === "INTENT") {
  structured = classifyIntent(request.prompt);
  content = JSON.stringify(structured);
} else if (request.mode === "READ_ONLY_BRANCH") {
  structured = specialistReply(request.role, /[\u3400-\u9fff]/.test(request.prompt) ? "zh" : request.responseLanguage);
  content = JSON.stringify(structured);
} else if (request.role === "ANALYSIS") {
  const projectName = String(context?.workflow?.projectName ?? "Imported game");
  structured = analysisReport(projectName, request.responseLanguage);
  await callTool("context.update_analysis", { analysis: structured });
  content = JSON.stringify(structured);
} else if (request.role === "DESIGN") {
  const goals = Array.isArray(context?.e2e?.goals) ? context.e2e.goals : [];
  await callTool("requirements.update", {
    requirements: context?.requirements?.length
      ? context.requirements
      : [{ id: "initial-concept", text: "Deliver the approved playable game loop." }],
  });
  await callTool("project_document.update", {
    document: Object.keys(context?.projectDocument ?? {}).length
      ? context.projectDocument
      : {
          introduction: "A playable game generated from the approved requirements.",
          gameplay: "Start a session, perform the primary action, and complete the core loop.",
          categories: ["gameplay"],
          features: ["real input", "complete loop"],
        },
  });
  await callTool("e2e_goals.update", { goals });
  await callTool("handoff.create", {
    toRole: "DEVELOPMENT",
    summary: "Implement the complete approved requirement and E2E goal snapshot.",
  });
  structured = { handoff: { toRole: "DEVELOPMENT", goalCount: goals.length } };
  content = JSON.stringify(structured);
} else if (request.role === "DEVELOPMENT") {
  const sourceDirectory = process.env.DEVILUDO_PROJECT_SOURCE_DIR ?? "/workspace/project";
  await mkdir(sourceDirectory, { recursive: true });
  await cp("/opt/deviludo-fixture", sourceDirectory, { recursive: true, force: true });
  if (/素材回收|回收废弃|asset cleanup|retire obsolete/i.test(JSON.stringify(context))) {
    const firstDevelopment = !Array.isArray(context?.assetPlan) || context.assetPlan.length === 0;
    if (firstDevelopment) {
      const assetDirectory = `${sourceDirectory}/assets/generated`;
      await mkdir(assetDirectory, { recursive: true });
      await Promise.all([
        writeFile(`${assetDirectory}/obsolete-panel.svg`, "<svg xmlns=\"http://www.w3.org/2000/svg\" width=\"8\" height=\"8\"><rect width=\"8\" height=\"8\" fill=\"#0cf\"/></svg>\n"),
        writeFile(`${assetDirectory}/user-banner.svg`, "<svg xmlns=\"http://www.w3.org/2000/svg\" width=\"8\" height=\"8\"><rect width=\"8\" height=\"8\" fill=\"#fc0\"/></svg>\n"),
      ]);
      await callTool("assets.plan", { assets: fixtureAssets(request.workspaceId, request.projectId) });
    } else {
      await callTool("assets.plan", { assets: [] });
    }
  }
  const checkpoint = await callTool("source.checkpoint", {});
  await callTool("build.request", {});
  await callTool("handoff.create", {
    toRole: "TEST",
    summary: "Source checkpoint is ready for the controlled build and complete test planning.",
    sourceRevision: checkpoint.revision,
  });
  structured = {
    content: request.responseLanguage === "zh"
      ? "游戏生成已完成，新的源码版本已经提交，现已进入受控构建与测试流程。"
      : "Game generation is complete. The new source revision is ready for controlled build and testing.",
    sourceRevision: checkpoint.revision,
    handoff: { toRole: "TEST", sourceRevision: checkpoint.revision },
  };
  content = JSON.stringify(structured);
} else if (request.role === "TEST" && request.prompt.includes("current source and plan revisions")) {
  const evidence = await callTool("evidence.read", {});
  const failed = Array.isArray(evidence.runs)
    && evidence.runs.some(run => String(run?.verdict ?? "") !== "PASS");
  structured = failed
    ? { verdict: "FAIL", handoff: { toRole: "DEVELOPMENT", summary: "Repair the failed platform evidence and rebuild." } }
    : { verdict: "PASS", handoff: null };
  await callTool("test.verdict", structured);
  content = JSON.stringify(structured);
} else if (request.role === "TEST") {
  const goals = normalizeGoals(context?.e2e?.goals, context?.requirements);
  const assets = Array.isArray(context?.assetPlan) ? context.assetPlan : [];
  const plan = {
    testManifest: testManifest(goals),
    assetPlacementPlan: assetPlacementPlan(assets),
  };
  const stored = await callTool("test_plan.replace", { plan });
  await callTool("e2e.start", {});
  structured = { planRevision: stored.planRevision, planId: stored.planId };
  content = JSON.stringify(structured);
} else {
  throw new Error(`Fixture Runtime does not implement ${request.role}/${request.mode}`);
}

emitContent(typeof structured.content === "string" ? structured.content : content);
process.stdout.write(`${JSON.stringify({
  schemaVersion: "deviludo.project-runtime.v2",
  turnId: request.turnId,
  role: request.role,
  mode: request.mode,
  content,
  structured,
  toolCalls,
  sessionId: `${request.role.toLowerCase()}-${request.projectId}`,
  branchId: request.mode === "READ_ONLY_BRANCH" ? randomUUID() : null,
  sourceRevision: request.sourceRevision,
  startedAt,
  completedAt: new Date().toISOString(),
})}\n`);

async function callTool(name, arguments_) {
  const calledAt = new Date().toISOString();
  const tokenFile = process.env.DEVILUDO_MCP_TOKEN_FILE ?? "/run/deviludo/mcp-token";
  const gateway = process.env.DEVILUDO_MCP_GATEWAY ?? "";
  const token = (await readFile(tokenFile, "utf8")).trim();
  const response = await fetch(new URL("/v2/runtime/tools/call", gateway), {
    method: "POST",
    headers: { authorization: `Bearer ${token}`, "content-type": "application/json" },
    body: JSON.stringify({
      workspaceId: request.workspaceId,
      projectId: request.projectId,
      role: request.role,
      turnId: request.turnId,
      name,
      arguments: arguments_,
    }),
    signal: AbortSignal.timeout(120_000),
  });
  const result = await response.json();
  if (!response.ok) throw new Error(typeof result?.message === "string"
    ? result.message
    : `Fixture MCP call ${name} returned ${response.status}`);
  toolCalls.push({ name, arguments: arguments_, result, startedAt: calledAt, completedAt: new Date().toISOString() });
  return result;
}

function classifyIntent(prompt) {
  const message = latestMessage(prompt);
  const pending = /Pending proposal: yes/.test(prompt);
  if (pending && /^(确认|同意|按这个|执行这个|confirm\b)/i.test(message.trim())) {
    return decision("CONFIRM_CHANGE", "DESIGN", false, false, "Confirm the pending implementation change.");
  }
  if (pending && /^(取消|拒绝|放弃|不要改|reject\b)/i.test(message.trim())) {
    return decision("REJECT_CHANGE", "DESIGN", false, false, "Reject the pending implementation change.");
  }
  if (/^(停止|停下|stop\b)/i.test(message.trim())) return decision("STOP", "DEVELOPMENT", false, false, "Stop the active workflow.");
  if (/^(继续|恢复|resume\b|continue\b)/i.test(message.trim())) return decision("CONTINUE", "DEVELOPMENT", false, false, "Continue the stopped workflow.");

  const question = /[?？]|为什么|是什么|如何|什么情况|会发生什么|进度|正在做什么|不要修改|只(?:回答|分析|说明)|请(?:说明|解释|分析|回答)|请先给出.*建议|先讨论/.test(message);
  const tentative = /能不能|可不可以|如果|是否可以|请确认.*(?:可以|是否)|判断是否|建议(?:改|调整)|待专业 Agent 判断/.test(message);
  const testRole = /(?:E2E|测试|证据|用例|报告)/i.test(message) && !/(?:修复|修改|增加|删除|实现)/.test(message);
  const developmentRole = /(?:代码|源码|输入|无法操作|bug|错误|修复|生成游戏|实现)/i.test(message);
  const role = testRole ? "TEST" : developmentRole ? "DEVELOPMENT" : "DESIGN";
  // A mutation verb can describe the subject of a question (for example,
  // "why does this increase pressure?").  Question syntax wins unless the
  // player is explicitly discussing a hypothetical implementation change.
  if (question && !tentative) {
    return decision("QUESTION", role, false, false, "Answer the player's question from the current project context.");
  }
  const explicit = !tentative && /(?:修复|修改|增加|删除|实现|改成|调整|开始开发|重新生成|我想做|希望|请.*(?:开发|同步))/.test(message);
  return decision(
    "CHANGE_REQUEST",
    role,
    explicit,
    true,
    "Update the implementation according to the player's request.",
  );
}

function decision(intent, targetRole, explicitExecution, actionable, summary) {
  return { intent, targetRole, explicitExecution, actionable, summary, workflowAction: intent === "CHANGE_REQUEST"
    ? explicitExecution ? "START_DEVELOPMENT" : "AWAITING_CONFIRMATION"
    : intent === "STOP" ? "STOP" : intent === "CONTINUE" ? "CONTINUE" : "NONE" };
}

function specialistReply(role, language) {
  const names = language === "zh"
    ? { DESIGN: "测试设计 Agent", DEVELOPMENT: "测试开发 Agent", TEST: "测试测试 Agent" }
    : { DESIGN: "Fixture Design Agent", DEVELOPMENT: "Fixture Development Agent", TEST: "Fixture Test Agent" };
  return {
    content: language === "zh"
      ? `${names[role]} 已结合项目上下文生成回复。`
      : `${names[role]} answered from the current project context.`,
    readyForDevelopment: true,
    options: language === "zh"
      ? [
          { label: "采用强化资源管理方案（推荐）", description: "强调资源来源、消耗与风险之间的持续取舍。" },
          { label: "采用随机事件驱动方案", description: "用可读的随机事件推动局势变化与临场决策。" },
        ]
      : [
          { label: "Use resource management (Recommended)", description: "Emphasize ongoing tradeoffs between resource income, costs, and risk." },
          { label: "Use random events", description: "Use readable random events to drive state changes and tactical decisions." },
        ],
    implementationBrief: language === "zh" ? "按玩家请求更新完整实现并保留全部验收目标。" : "Update the complete implementation while preserving every acceptance goal.",
    projectDocumentPatch: {
      introduction: language === "zh" ? "测试设计 Agent 已整理当前游戏需求。" : "The Design Agent organized the current game requirements.",
      gameplay: language === "zh" ? "围绕玩家确认的核心循环进行操作、反馈与结算。" : "Play, feedback, and resolution follow the confirmed core loop.",
      categories: language === "zh" ? ["自动化测试", "游戏设计"] : ["automated testing", "game design"],
      features: language === "zh" ? ["需求对话实时同步", "可执行的核心循环"] : ["live requirement conversation", "playable core loop"],
    },
    e2eGoalDelta: { add: [], replace: [], retire: [] },
  };
}

function analysisReport(projectName, language) {
  if (language === "zh") return {
    name: projectName,
    introduction: "项目分析 Agent 已检查导入的可玩游戏。",
    gameplay: "启动游戏，使用真实玩家输入，并完成现有核心交互循环。",
    categories: ["解谜", "冒险"],
    features: ["真实输入", "持久化项目上下文"],
    coreLoop: ["启动项目", "执行主要玩家操作", "观察游戏状态变化"],
    playerExperience: "玩家可以启动当前构建、理解可用操作并获得可见反馈。",
    acceptanceCriteria: ["项目成功启动", "主要交互响应真实输入"],
    gameContent: "导入源码包含一个小型可玩游戏及其启动配置。",
    currentDevelopmentState: "源码已可用于设计审查和后续开发。",
    completedWork: ["项目结构和启动入口已存在"],
    remainingWork: ["在每个目标平台验证完整的已批准需求"],
    startupFlow: "打开项目入口，加载首个场景并开始主要交互。",
    startupIssues: [],
    risks: ["平台特定的输入行为仍需 E2E 证据"],
  };
  return {
    name: projectName,
    introduction: "An imported playable game inspected by the project Analysis Agent.",
    gameplay: "Launch the game, use real player input, and complete the existing core interaction loop.",
    categories: ["puzzle", "adventure"],
    features: ["real input", "persistent project context"],
    coreLoop: ["Launch the project", "Perform the primary player action", "Observe the resulting game state"],
    playerExperience: "The player can launch the current build, understand the available action, and receive visible feedback.",
    acceptanceCriteria: ["The project starts successfully", "The primary interaction responds to real input"],
    gameContent: "The imported source contains a small playable game fixture and its startup configuration.",
    currentDevelopmentState: "The source is available for design review and continued development.",
    completedWork: ["Project structure and startup entry point are present"],
    remainingWork: ["Validate the full approved requirement set on every target platform"],
    startupFlow: "Open the project entry point, load the first scene, and begin the primary interaction.",
    startupIssues: [],
    risks: ["Platform-specific input behavior still requires E2E evidence"],
  };
}

function normalizeGoals(value, requirements) {
  const source = Array.isArray(value) && value.length
    ? value
    : Array.isArray(requirements) && requirements.length
      ? requirements.map((item, index) => ({
          id: stableId(String(item?.id ?? `requirement-${index + 1}`), index),
          description: String(item?.text ?? item?.description ?? "Complete the playable core loop."),
          source: index === 0 ? "CORE_LOOP" : "ACCEPTANCE",
        }))
      : [{ id: "initial-core-loop", description: "Complete the playable core loop.", source: "CORE_LOOP" }];
  return source.map((goal, index) => ({
    id: stableId(String(goal?.id ?? `goal-${index + 1}`), index),
    description: String(goal?.description ?? goal?.text ?? "Complete the playable core loop.").slice(0, 2_000),
    source: goal?.source === "ACCEPTANCE" ? "ACCEPTANCE" : "CORE_LOOP",
  }));
}

function stableId(value, index) {
  const normalized = value.toLowerCase().replace(/[^a-z0-9-]+/g, "-").replace(/^-+|-+$/g, "").slice(0, 100);
  return normalized && /^[a-z0-9]/.test(normalized) ? normalized : `fixture-requirement-${index + 1}`;
}

function testManifest(goals) {
  const requirements = goals.map(goal => ({
    requirementId: goal.id,
    description: goal.description,
    source: goal.source,
    verificationClass: "PLAYER_INTERACTION",
  }));
  const requirementIds = requirements.map(item => item.requirementId);
  const menu = [
    { source: "STATE", key: "screen_mode", operator: "EQUALS", value: "MENU" },
    { source: "STATE", key: "session_active", operator: "EQUALS", value: false },
    { source: "STATE", key: "gameplay_input_enabled", operator: "EQUALS", value: false },
    { source: "STATE", key: "blocking_layer_count", operator: "EQUALS", value: 0 },
  ];
  const playing = [
    { source: "STATE", key: "screen_mode", operator: "EQUALS", value: "PLAYING" },
    { source: "STATE", key: "session_active", operator: "EQUALS", value: true },
    { source: "STATE", key: "gameplay_input_enabled", operator: "EQUALS", value: true },
    { source: "STATE", key: "blocking_layer_count", operator: "EQUALS", value: 0 },
  ];
  const changed = [{ source: "PROGRESS", key: "loop", operator: "CHANGED" }];
  return {
    schema: "deviludo.test-manifest",
    inputProfiles: ["KEYBOARD_MOUSE"],
    primaryInputProfile: "KEYBOARD_MOUSE",
    adaptivePlayer: {
      goal: "Start the game and complete the full playable core loop using real native input.",
      requirementIds,
      allowedActions: ["KEYBOARD", "POINTER"],
      successAssertions: changed,
      failureAssertions: [{ source: "STATE", key: "crashed", operator: "EQUALS", value: true }],
      rolloutTimeoutMs: 240_000,
      maxDecisions: 20,
      seedStrategy: "STABLE_PROJECT_PLATFORM",
    },
    requirements,
    features: [{
      id: "complete-core-loop",
      requirementIds,
      category: "core-loop",
      description: "Exercise every current requirement through the complete core journey.",
      verificationMethod: "interactive",
      coreJourney: true,
      launchProfile: { type: "FRESH" },
      timeoutMs: 300_000,
      interactionScript: { events: [
        { type: "checkpoint", id: "game-start", role: "START", assertions: menu, visualMode: "STABLE_REPLAY" },
        { type: "click", stepId: "start-session", intent: "START_SESSION", targetId: "new-game", coversRequirementIds: requirementIds, postconditions: playing },
        { type: "checkpoint", id: "game-ready", role: "READY", assertions: playing, visualMode: "STABLE_REPLAY" },
        { type: "click", stepId: "primary-action", intent: "PRIMARY_ACTION", targetId: "primary-control", coversRequirementIds: requirementIds, postconditions: changed },
        { type: "checkpoint", id: "loop-progress", role: "PROGRESS", assertions: changed, visualMode: "DYNAMIC", changeTargetId: "game-viewport" },
        { type: "click", stepId: "complete-loop", intent: "COMPLETE_LOOP", targetId: "end-turn", coversRequirementIds: requirementIds, postconditions: changed },
        { type: "checkpoint", id: "loop-complete", role: "COMPLETION", assertions: changed, visualMode: "DYNAMIC", changeTargetId: "game-viewport" },
      ] },
    }],
  };
}

function assetPlacementPlan(assets) {
  const plannedAssetKeys = assets.map(item => String(item?.key ?? item?.assetKey ?? "")).filter(Boolean).sort();
  return {
    schema: "deviludo.asset-placement-plan",
    plannedAssetKeys,
    placements: assets.map((item, index) => ({
      assetKey: String(item?.key ?? item?.assetKey ?? ""),
      targetId: stableId(String(item?.targetId ?? `asset-control-${index + 1}`), index),
      checkpointRole: ["START", "READY", "ACTION", "PROGRESS", "COMPLETION"].includes(String(item?.checkpointRole))
        ? item.checkpointRole
        : "READY",
      expectedResourcePath: /^res:\/\/.+\.(?:png|jpe?g|webp|svg)$/i.test(String(item?.expectedResourcePath ?? ""))
        ? item.expectedResourcePath
        : `res://assets/generated/${stableId(String(item?.key ?? `asset-${index + 1}`), index)}.png`,
      expectedSha256: /^sha256:[0-9a-f]{64}$/.test(String(item?.expectedSha256 ?? "")) ? item.expectedSha256 : null,
    })),
    unmappedAssetKeys: [],
  };
}

function fixtureAssets(workspaceId, projectId) {
  return [{
    key: "ui/obsolete-panel",
    origin: "GENERATED",
    targetId: "obsolete-panel",
    checkpointRole: "READY",
    expectedResourcePath: "res://assets/generated/obsolete-panel.svg",
    sourcePath: "assets/generated/obsolete-panel.svg",
    bucket: "game-assets",
    objectKey: `workspaces/${workspaceId}/projects/${projectId}/assets/obsolete-panel.svg`,
  }, {
    key: "ui/user-banner",
    origin: "USER_UPLOAD",
    targetId: "user-banner",
    checkpointRole: "READY",
    expectedResourcePath: "res://assets/generated/user-banner.svg",
    sourcePath: "assets/generated/user-banner.svg",
    bucket: "game-assets",
    objectKey: `workspaces/${workspaceId}/projects/${projectId}/uploads/user-banner.svg`,
  }];
}

function latestMessage(prompt) {
  const matches = [...prompt.matchAll(/Latest player message \(untrusted data\): ("(?:[^"\\]|\\.)*")/g)];
  if (matches.length) {
    try { return JSON.parse(matches.at(-1)[1]); } catch {}
  }
  const specialist = prompt.match(/Player message \(untrusted data\): ("(?:[^"\\]|\\.)*")/);
  if (specialist) {
    try { return JSON.parse(specialist[1]); } catch {}
  }
  return prompt;
}

function emitContent(value) {
  const midpoint = Math.max(1, Math.floor(value.length / 2));
  for (const chunk of [value.slice(0, midpoint), value.slice(midpoint)]) {
    if (chunk) process.stderr.write(`DEVILUDO_RUNTIME_EVENT:${JSON.stringify({ delta: { text: chunk } })}\n`);
  }
}

async function readStdin() {
  const chunks = [];
  for await (const chunk of process.stdin) chunks.push(Buffer.from(chunk));
  return Buffer.concat(chunks);
}

function validateRequest(value) {
  if (!value || value.schemaVersion !== "deviludo.project-runtime.v2"
    || !["INTENT", "ANALYSIS", "DESIGN", "DEVELOPMENT", "TEST"].includes(value.role)
    || !["PRIMARY", "READ_ONLY_BRANCH", "COMPACT"].includes(value.mode)
    || !["CLAUDE_CODE", "CODEX_CLI"].includes(value.runtime)
    || !/^[0-9a-f-]{36}$/i.test(value.turnId)) {
    throw new Error("Fixture Project Runtime turn request is invalid");
  }
}
