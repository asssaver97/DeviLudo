import assert from "node:assert/strict";
import test from "node:test";
import type { AgentModelOverrides } from "../lib/product/contracts";
import {
  generateProductConversationReply,
  generateProductConversationGroupReply,
  streamProductConversationReply,
} from "../services/core/src/product-conversation";

const project = Object.freeze({
  name: "星港维修队",
  concept: "双人合作修理太空站",
  workflowState: "DRAFT",
  analysisStatus: "READY" as const,
  discovery: null,
  specification: Object.freeze({ coreLoop: Object.freeze(["发现故障", "协作维修"]) }),
  document: Object.freeze({
    introduction: "玩家共同维护一座太空站。",
    gameplay: "分工处理火灾、电力和导航故障。",
    categories: Object.freeze(["合作", "动作"]),
    features: Object.freeze(["十分钟一局"]),
  }),
});

function claudeSettings(revision = 1, overrides: AgentModelOverrides = Object.freeze({
  design: null,
  development: null,
  test: null,
  image: null,
})) {
  return Object.freeze({
    agentRuntime: "CLAUDE_CODE" as const,
    baseUrl: "https://provider.example/v1",
    primaryModel: "claude-primary",
    modelOverrides: overrides,
    revision,
  });
}

test("project group chat invokes design, development, and test Agents with independent models", async () => {
  const models: string[] = [];
  const prompts: string[] = [];
  const histories: string[] = [];
  const replies = await generateProductConversationGroupReply({
    userContent: "增加一个合作维修任务",
    history: Object.freeze([]),
    project,
    allowDraftMutation: true,
    settings: claudeSettings(9, Object.freeze({
        design: "design-model",
        development: "development-model",
        test: "test-model",
        image: null,
      })),
    apiKey: "sk-test-secret",
    fetchImpl: async (_url, init) => {
      const body = JSON.parse(String(init?.body)) as Record<string, unknown>;
      models.push(String(body.model));
      prompts.push(String(body.system));
      histories.push(JSON.stringify(body.messages));
      return new Response(JSON.stringify({
        content: [{ type: "text", text: JSON.stringify({
          reply: `来自 ${String(body.model)} 的意见`,
          options: [],
          applyToDraft: false,
          readyForDevelopment: true,
          projectDocumentPatch: null,
        }) }],
      }), { status: 200, headers: { "content-type": "application/json" } });
    },
  });

  assert.deepEqual(models, ["design-model", "development-model", "test-model"]);
  assert.deepEqual(replies.map(reply => reply.agentRole), ["DESIGN", "DEVELOPMENT", "TEST"]);
  assert.match(prompts[0], /Design Agent/);
  assert.match(prompts[1], /Development Agent/);
  assert.match(prompts[2], /Test Agent/);
  assert.ok(prompts.every(prompt => !prompt.includes("请用中文回答")));
  assert.match(histories[1], /design-model 的意见/);
  assert.match(histories[2], /development-model 的意见/);
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
    responseLanguage: "zh",
    settings: claudeSettings(7, Object.freeze({ design: "claude-sonnet", development: null, test: null, image: null })),
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
  assert.equal(requestedBody.model, "claude-sonnet");
  assert.equal(requestedBody.max_tokens, 4_000);
  assert.match(String(requestedBody.system), /星港维修队/);
  assert.match(String(requestedBody.system), /十分钟一局/);
  assert.match(String(requestedBody.system), /projectDocumentPatch/);
  assert.match(String(requestedBody.system), /请用中文回答/);
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
    projectDocumentPatch: {
      gameplay: "两名玩家分工处理故障，每局十分钟。",
      features: ["十分钟一局", "实时分工"],
    },
    runtime: "CLAUDE_CODE",
    model: "claude-sonnet",
    settingsRevision: 7,
    e2eGoalDelta: { add: [], replace: [], retire: [] },
  });
});

test("conversation images are sent to Claude as vision content", async () => {
  let latestContent: unknown;
  await generateProductConversationReply({
    userContent: "检查这个界面截图",
    images: Object.freeze([{ contentType: "image/png" as const, dataBase64: "iVBORw0KGgo=" }]),
    history: Object.freeze([]),
    project,
    allowDraftMutation: false,
    settings: claudeSettings(),
    apiKey: "sk-test-secret",
    fetchImpl: async (_url, init) => {
      const body = JSON.parse(String(init?.body)) as { messages: readonly { content: unknown }[] };
      latestContent = body.messages.at(-1)?.content;
      return new Response(JSON.stringify({
        content: [{ type: "text", text: JSON.stringify({ reply: "界面截图已收到。", projectDocumentPatch: null }) }],
      }), { status: 200, headers: { "content-type": "application/json" } });
    },
  });
  assert.deepEqual(latestContent, [
    { type: "text", text: "检查这个界面截图" },
    { type: "image", source: { type: "base64", media_type: "image/png", data: "iVBORw0KGgo=" } },
  ]);
});

test("Codex design Agent uses the official CLI session and cannot mutate a locked workflow", async () => {
  let requestedPrompt = "";
  const result = await generateProductConversationReply({
    userContent: "把所有关卡缩短一半",
    history: Object.freeze([]),
    project: Object.freeze({ ...project, workflowState: "E2E_TESTING" }),
    allowDraftMutation: false,
    settings: Object.freeze({
      agentRuntime: "CODEX_CLI" as const,
      baseUrl: "https://openai.example",
      primaryModel: "account-default",
      modelOverrides: Object.freeze({ design: null, development: null, test: null }),
      imageModel: null,
      revision: 3,
    }),
    apiKey: JSON.stringify({ tokens: { access_token: "test" } }),
    codexRunner: async input => {
      requestedPrompt = input.prompt;
      return JSON.stringify({ reply: "当前交付已锁定，我会把它作为下一轮建议。", applyToDraft: true });
    },
  });

  assert.match(requestedPrompt, /applyToDraft must be false/);
  assert.equal(result.applyToDraft, false);
  assert.equal(result.content, "当前交付已锁定，我会把它作为下一轮建议。");
  assert.deepEqual(result.options, []);
  assert.equal(result.runtime, "CODEX_CLI");
});

test("conversation images are attached to Codex prompts", async () => {
  let images: unknown;
  await generateProductConversationReply({
    userContent: "检查参考图",
    images: Object.freeze([{ contentType: "image/jpeg" as const, dataBase64: "/9j/2Q==" }]),
    history: Object.freeze([]),
    project,
    allowDraftMutation: false,
    settings: Object.freeze({
      agentRuntime: "CODEX_CLI" as const,
      baseUrl: "https://openai.example",
      primaryModel: "account-default",
      modelOverrides: Object.freeze({ design: null, development: null, test: null, image: null }),
      revision: 3,
    }),
    apiKey: JSON.stringify({ tokens: { access_token: "test" } }),
    codexRunner: async input => {
      images = input.images;
      return JSON.stringify({ reply: "参考图已收到。", projectDocumentPatch: null });
    },
  });
  assert.deepEqual(images, [{ dataBase64: "/9j/2Q==", extension: "jpg" }]);
});

test("draft conversations allow exploratory replies without repeating the project document", async () => {
  const result = await generateProductConversationReply({
    userContent: "给我三个玩法方向",
    history: Object.freeze([]),
    project,
    allowDraftMutation: true,
    settings: claudeSettings(),
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
    settings: claudeSettings(),
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
    settings: claudeSettings(),
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
    settings: claudeSettings(),
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
    settings: claudeSettings(),
    apiKey: "sk-test-secret",
    providerIdleTimeoutMs: 20,
    fetchImpl: async (_url, init) => await new Promise<Response>((_resolve, reject) => {
      const signal = init?.signal;
      if (!signal) return reject(new Error("missing request signal"));
      if (signal.aborted) return reject(signal.reason);
      signal.addEventListener("abort", () => reject(signal.reason), { once: true });
    }),
  }), /Agent 超过 1 秒未返回数据，请重试/);
});

test("malformed JSON newlines never leak the reply envelope into chat", async () => {
  const result = await generateProductConversationReply({
    userContent: "总结当前玩法",
    history: Object.freeze([]),
    project,
    allowDraftMutation: true,
    settings: claudeSettings(),
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
    settings: claudeSettings(2),
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
