import assert from "node:assert/strict";
import test from "node:test";
import {
  generateProductConversationReply,
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
  assert.match(String(requestedBody.system), /星港维修队/);
  assert.match(String(requestedBody.system), /十分钟一局/);
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

test("draft conversations reject replies that omit the synchronized project document", async () => {
  await assert.rejects(() => generateProductConversationReply({
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
  }), /未返回完整项目说明/);
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
