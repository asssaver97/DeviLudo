import assert from "node:assert/strict";
import test from "node:test";
import {
  generateProductConversationReply,
  isDevelopmentApprovalRequest,
  streamProductConversationReply,
} from "../services/core/src/product-conversation";

const project = Object.freeze({
  name: "星港维修队",
  concept: "双人合作修理太空站",
  workflowState: "DRAFT",
  specification: Object.freeze({ coreLoop: Object.freeze(["发现故障", "协作维修"]) }),
  document: Object.freeze({
    introduction: "玩家共同维护一座太空站。",
    gameplay: "分工处理火灾、电力和导航故障。",
    categories: Object.freeze(["合作", "动作"]),
    features: Object.freeze(["十分钟一局"]),
  }),
});

test("explicit development commands approve while discussions and negative commands do not", () => {
  for (const command of [
    "执行",
    "开始开发",
    "继续开发",
    "按照当前需求开发",
    "帮我实现这个需求",
    "让 Agent 按照当前需求执行",
    "先做新手引导与前 10 回合反馈层次",
    "需求没问题，就按这个方案开始开发",
    "增加 H 键隐藏提示并补回归测试。按照当前需求开发。",
    "同步更新项目说明，删除过时状态，并立即按照当前需求开始开发。",
    "Go ahead and implement it",
    "Let's start building",
    "Have the agent implement the current requirements",
  ]) assert.equal(isDevelopmentApprovalRequest(command), true, command);

  for (const discussion of [
    "我想做一款合作游戏",
    "不要开始开发",
    "先别执行，继续讨论",
    "如果现在开始开发，会发生什么？",
    "可以开始执行吗？",
    "What happens if we start building?",
    "Do not implement this yet",
  ]) assert.equal(isDevelopmentApprovalRequest(discussion), false, discussion);
});

test("Claude design Agent receives project context and conversation history", async () => {
  let requestedUrl = "";
  let requestedBody: Record<string, unknown> = {};
  const result = await generateProductConversationReply({
    userContent: "把每局时间调整为十分钟",
    history: Object.freeze([
      Object.freeze({ role: "USER" as const, content: "先讨论局长" }),
      Object.freeze({ role: "ASSISTANT" as const, content: "你希望一局多长？" }),
    ]),
    project,
    allowDraftMutation: true,
    settings: Object.freeze({
      agentRuntime: "CLAUDE_CODE" as const,
      baseUrl: "https://provider.example/v1",
      models: Object.freeze({
        primary: "claude-primary",
        opus: "claude-opus",
        sonnet: "claude-sonnet",
        haiku: "claude-haiku",
        subagent: "claude-subagent",
      }),
      revision: 7,
    }),
    apiKey: "sk-test-secret",
    fetchImpl: async (url, init) => {
      requestedUrl = String(url);
      requestedBody = JSON.parse(String(init?.body)) as Record<string, unknown>;
      return new Response(JSON.stringify({
        content: [{ type: "text", text: JSON.stringify({
          reply: "可以。十分钟会让故障决策更紧凑。",
          options: ["保留十分钟", "改为十五分钟"],
          applyToDraft: true,
          readyForDevelopment: true,
          projectDocument: {
            introduction: "玩家共同维护一座太空站。",
            gameplay: "两名玩家分工处理故障，每局十分钟。",
            categories: ["合作", "动作"],
            features: ["十分钟一局", "实时分工"],
          },
        }) }],
      }), { status: 200, headers: { "content-type": "application/json" } });
    },
  });

  assert.equal(requestedUrl, "https://provider.example/v1/messages");
  assert.equal(requestedBody.model, "claude-primary");
  assert.equal(requestedBody.max_tokens, 4_000);
  assert.match(String(requestedBody.system), /星港维修队/);
  assert.match(String(requestedBody.system), /十分钟一局/);
  assert.match(String(requestedBody.system), /projectDocumentPatch/);
  assert.deepEqual((requestedBody.messages as { role: string; content: string }[]).map(message => message.role), [
    "user", "assistant", "user",
  ]);
  assert.equal(JSON.stringify(requestedBody).includes("sk-test-secret"), false);
  assert.deepEqual(result, {
    content: "可以。十分钟会让故障决策更紧凑。",
    options: ["保留十分钟", "改为十五分钟"],
    applyToDraft: true,
    readyForDevelopment: true,
    projectDocument: {
      introduction: "玩家共同维护一座太空站。",
      gameplay: "两名玩家分工处理故障，每局十分钟。",
      categories: ["合作", "动作"],
      features: ["十分钟一局", "实时分工"],
    },
    runtime: "CLAUDE_CODE",
    model: "claude-primary",
    settingsRevision: 7,
  });
});

test("Codex design Agent uses Responses API and cannot mutate a locked workflow", async () => {
  let requestedBody: Record<string, unknown> = {};
  const result = await generateProductConversationReply({
    userContent: "把所有关卡缩短一半",
    history: Object.freeze([]),
    project: Object.freeze({ ...project, workflowState: "E2E_TESTING" }),
    allowDraftMutation: false,
    settings: Object.freeze({
      agentRuntime: "CODEX_CLI" as const,
      baseUrl: "https://openai.example",
      models: null,
      revision: 3,
    }),
    apiKey: "codex-test-secret",
    fetchImpl: async (_url, init) => {
      requestedBody = JSON.parse(String(init?.body)) as Record<string, unknown>;
      return new Response(JSON.stringify({
        output_text: JSON.stringify({ reply: "当前交付已锁定，我会把它作为下一轮建议。", applyToDraft: true }),
      }), { status: 200, headers: { "content-type": "application/json" } });
    },
  });

  assert.match(String(requestedBody.instructions), /applyToDraft 必须为 false/);
  assert.equal(result.applyToDraft, false);
  assert.equal(result.content, "当前交付已锁定，我会把它作为下一轮建议。");
  assert.deepEqual(result.options, []);
  assert.equal(result.runtime, "CODEX_CLI");
});

test("draft conversations allow exploratory replies without repeating the project document", async () => {
  const result = await generateProductConversationReply({
    userContent: "给我三个玩法方向",
    history: Object.freeze([]),
    project,
    allowDraftMutation: true,
    settings: Object.freeze({
      agentRuntime: "CLAUDE_CODE" as const,
      baseUrl: "https://provider.example",
      models: Object.freeze({
        primary: "claude-primary",
        opus: "claude-opus",
        sonnet: "claude-sonnet",
        haiku: "claude-haiku",
        subagent: "claude-subagent",
      }),
      revision: 1,
    }),
    apiKey: "sk-test-secret",
    fetchImpl: async () => new Response(JSON.stringify({
      content: [{ type: "text", text: "可以从分工、资源冲突和限时事件三个方向探索。" }],
    }), { status: 200, headers: { "content-type": "application/json" } }),
  });
  assert.equal(result.content, "可以从分工、资源冲突和限时事件三个方向探索。");
  assert.equal(result.applyToDraft, false);
  assert.equal(result.projectDocument, null);
});

test("draft conversations merge a project document patch with the current document", async () => {
  const result = await generateProductConversationReply({
    userContent: "把每局时间调整为十五分钟",
    history: Object.freeze([]),
    project,
    allowDraftMutation: true,
    settings: Object.freeze({
      agentRuntime: "CLAUDE_CODE" as const,
      baseUrl: "https://provider.example",
      models: Object.freeze({
        primary: "claude-primary",
        opus: "claude-opus",
        sonnet: "claude-sonnet",
        haiku: "claude-haiku",
        subagent: "claude-subagent",
      }),
      revision: 1,
    }),
    apiKey: "sk-test-secret",
    fetchImpl: async () => new Response(JSON.stringify({
      content: [{ type: "text", text: JSON.stringify({
        reply: "已将单局时长调整为十五分钟，并同步到项目说明。",
        options: [],
        applyToDraft: true,
        readyForDevelopment: true,
        projectDocumentPatch: {
          gameplay: "分工处理火灾、电力和导航故障，每局十五分钟。",
          features: ["十五分钟一局"],
        },
      }) }],
    }), { status: 200, headers: { "content-type": "application/json" } }),
  });
  assert.equal(result.applyToDraft, true);
  assert.deepEqual(result.projectDocument, {
    introduction: project.document.introduction,
    gameplay: "分工处理火灾、电力和导航故障，每局十五分钟。",
    categories: project.document.categories,
    features: ["十五分钟一局"],
  });
});

test("draft conversations normalize an overlong Agent feature before applying the patch", async () => {
  const verboseFeature = `字体与真实输入验收：${"中文可读并通过 H 键切换提示。".repeat(30)}`;
  const result = await generateProductConversationReply({
    userContent: "修复中文字体并更新真实按键 E2E",
    history: Object.freeze([]),
    project,
    allowDraftMutation: true,
    settings: Object.freeze({
      agentRuntime: "CLAUDE_CODE" as const,
      baseUrl: "https://provider.example",
      models: Object.freeze({
        primary: "claude-primary",
        opus: "claude-opus",
        sonnet: "claude-sonnet",
        haiku: "claude-haiku",
        subagent: "claude-subagent",
      }),
      revision: 1,
    }),
    apiKey: "sk-test-secret",
    fetchImpl: async () => new Response(JSON.stringify({
      content: [{ type: "text", text: JSON.stringify({
        reply: "需求已同步。",
        options: [],
        applyToDraft: true,
        readyForDevelopment: true,
        projectDocumentPatch: { features: [verboseFeature] },
      }) }],
    }), { status: 200, headers: { "content-type": "application/json" } }),
  });
  assert.equal(result.applyToDraft, true);
  assert.ok((result.projectDocument?.features.length ?? 0) > 1);
  assert.ok(result.projectDocument?.features.every(feature => feature.length <= 300));
  assert.equal(result.projectDocument?.features.join(""), verboseFeature);
});

test("draft conversations reject an asserted mutation without a document patch", async () => {
  await assert.rejects(() => generateProductConversationReply({
    userContent: "把每局时间调整为十五分钟",
    history: Object.freeze([]),
    project,
    allowDraftMutation: true,
    settings: Object.freeze({
      agentRuntime: "CLAUDE_CODE" as const,
      baseUrl: "https://provider.example",
      models: Object.freeze({
        primary: "claude-primary",
        opus: "claude-opus",
        sonnet: "claude-sonnet",
        haiku: "claude-haiku",
        subagent: "claude-subagent",
      }),
      revision: 1,
    }),
    apiKey: "sk-test-secret",
    fetchImpl: async () => new Response(JSON.stringify({
      content: [{ type: "text", text: JSON.stringify({
        reply: "已调整。",
        applyToDraft: true,
        readyForDevelopment: true,
        projectDocumentPatch: null,
      }) }],
    }), { status: 200, headers: { "content-type": "application/json" } }),
  }), /未返回有效的项目说明增量/);
});

test("design Agent provider failures use a resettable idle timeout with a clear error", async () => {
  await assert.rejects(() => generateProductConversationReply({
    userContent: "继续完善新手引导",
    history: Object.freeze([]),
    project,
    allowDraftMutation: true,
    settings: Object.freeze({
      agentRuntime: "CLAUDE_CODE" as const,
      baseUrl: "https://provider.example",
      models: Object.freeze({
        primary: "claude-primary",
        opus: "claude-opus",
        sonnet: "claude-sonnet",
        haiku: "claude-haiku",
        subagent: "claude-subagent",
      }),
      revision: 1,
    }),
    apiKey: "sk-test-secret",
    providerIdleTimeoutMs: 20,
    fetchImpl: async (_url, init) => await new Promise<Response>((_resolve, reject) => {
      const signal = init?.signal;
      if (!signal) return reject(new Error("missing request signal"));
      if (signal.aborted) return reject(signal.reason);
      signal.addEventListener("abort", () => reject(signal.reason), { once: true });
    }),
  }), /设计 Agent 超过 1 秒未返回数据，请重试/);
});

test("malformed JSON newlines never leak the reply envelope into chat", async () => {
  const result = await generateProductConversationReply({
    userContent: "总结当前玩法",
    history: Object.freeze([]),
    project,
    allowDraftMutation: true,
    settings: Object.freeze({
      agentRuntime: "CLAUDE_CODE" as const,
      baseUrl: "https://provider.example",
      models: Object.freeze({
        primary: "claude-primary",
        opus: "claude-opus",
        sonnet: "claude-sonnet",
        haiku: "claude-haiku",
        subagent: "claude-subagent",
      }),
      revision: 1,
    }),
    apiKey: "sk-test-secret",
    fetchImpl: async () => new Response(JSON.stringify({
      content: [{ type: "text", text: '```json\n{"reply":"第一段\n\n第二段","options":["方向一","方向二"],"applyToDraft":false,"readyForDevelopment":false,"projectDocument":{"introduction":"玩家共同维护一座太空站。","gameplay":"分工处理火灾、电力和导航故障。","categories":["合作","动作"],"features":["十分钟一局"]}}\n```' }],
    }), { status: 200, headers: { "content-type": "application/json" } }),
  });
  assert.equal(result.content, "第一段\n\n第二段");
  assert.deepEqual(result.options, ["方向一", "方向二"]);
  assert.doesNotMatch(result.content, /[{}]|\\n|"reply"/);
});

test("Claude design Agent streams only the visible reply text", async () => {
  const visible: string[] = [];
  let requestedBody: Record<string, unknown> = {};
  const providerDeltas = [
    '{"reply":"先确认核心循环',
    '，再收敛关卡节奏。',
    '","applyToDraft":false,"projectDocument":{"introduction":"玩家共同维护一座太空站。","gameplay":"分工处理火灾、电力和导航故障。","categories":["合作","动作"],"features":["十分钟一局"]}}',
  ];
  const result = await streamProductConversationReply({
    userContent: "下一步先做什么？",
    history: Object.freeze([]),
    project,
    allowDraftMutation: true,
    settings: Object.freeze({
      agentRuntime: "CLAUDE_CODE" as const,
      baseUrl: "https://provider.example",
      models: Object.freeze({
        primary: "claude-primary",
        opus: "claude-opus",
        sonnet: "claude-sonnet",
        haiku: "claude-haiku",
        subagent: "claude-subagent",
      }),
      revision: 2,
    }),
    apiKey: "sk-test-secret",
    fetchImpl: async (_url, init) => {
      requestedBody = JSON.parse(String(init?.body)) as Record<string, unknown>;
      const stream = providerDeltas.map(delta => `data: ${JSON.stringify({
        type: "content_block_delta",
        delta: { type: "text_delta", text: delta },
      })}\n\n`).join("");
      return new Response(stream, { headers: { "content-type": "text/event-stream" } });
    },
  }, delta => visible.push(delta));

  assert.equal(requestedBody.stream, true);
  assert.equal(visible.join(""), "先确认核心循环，再收敛关卡节奏。");
  assert.equal(result.content, visible.join(""));
  assert.equal(result.applyToDraft, false);
});
