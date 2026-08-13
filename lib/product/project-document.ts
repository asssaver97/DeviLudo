export type ProjectDocumentContent = Readonly<{
  introduction: string;
  gameplay: string;
  categories: readonly string[];
  features: readonly string[];
}>;

const MAX_TEXT_LENGTH = 20_000;
const MAX_LIST_ITEMS = 32;
const MAX_LIST_ITEM_LENGTH = 300;

export function createInitialProjectDocument(
  projectName: string,
  concept: string,
  specification: Readonly<Record<string, unknown>>,
): ProjectDocumentContent {
  const coreLoop = stringList(specification.coreLoop);
  const acceptance = stringList(specification.acceptanceCriteria);
  return Object.freeze({
    introduction: concept,
    gameplay: coreLoop.length > 0 ? coreLoop.join("\n") : "待 Agent 根据项目实现补充玩法说明。",
    categories: Object.freeze(["待 Agent 分类"]),
    features: Object.freeze(acceptance.length > 0 ? acceptance : [`完成《${projectName}》的核心游戏循环`]),
  });
}

export function parseProjectDocumentContent(value: unknown): ProjectDocumentContent {
  if (!value || typeof value !== "object" || Array.isArray(value)) {
    throw new Error("项目说明文档必须是对象");
  }
  const input = value as Record<string, unknown>;
  const introduction = requiredText(input.introduction, "游戏介绍");
  const gameplay = requiredText(input.gameplay, "玩法");
  const categories = requiredList(input.categories, "游戏分类");
  const features = requiredList(input.features, "主要特性");
  return Object.freeze({
    introduction,
    gameplay,
    categories: Object.freeze(categories),
    features: Object.freeze(features),
  });
}

/**
 * Provider output is untrusted and occasionally exceeds the persisted document
 * contract even when the prompt states the limits. Keep the public/storage
 * parser strict, but repair otherwise valid Agent prose before it reaches that
 * boundary so one verbose list item cannot discard the whole conversation.
 */
export function normalizeAgentProjectDocumentContent(value: unknown): ProjectDocumentContent {
  if (!value || typeof value !== "object" || Array.isArray(value)) {
    throw new Error("项目说明文档必须是对象");
  }
  const input = value as Record<string, unknown>;
  return Object.freeze({
    introduction: agentText(input.introduction, "游戏介绍"),
    gameplay: agentText(input.gameplay, "玩法"),
    categories: Object.freeze(agentList(input.categories, "游戏分类")),
    features: Object.freeze(agentList(input.features, "主要特性")),
  });
}

export function projectDocumentMarkdown(projectName: string, content: ProjectDocumentContent): string {
  return [
    `# ${projectName}`,
    "",
    "## 游戏介绍",
    "",
    content.introduction,
    "",
    "## 玩法",
    "",
    content.gameplay,
    "",
    "## 游戏分类",
    "",
    ...content.categories.map(category => `- ${category}`),
    "",
    "## 主要特性",
    "",
    ...content.features.map(feature => `- ${feature}`),
    "",
  ].join("\n");
}

function requiredText(value: unknown, label: string): string {
  if (typeof value !== "string") throw new Error(`${label}必须是文本`);
  const normalized = value.trim();
  if (normalized.length < 1 || normalized.length > MAX_TEXT_LENGTH) {
    throw new Error(`${label}长度无效`);
  }
  return normalized;
}

function requiredList(value: unknown, label: string): string[] {
  if (!Array.isArray(value) || value.length < 1 || value.length > MAX_LIST_ITEMS) {
    throw new Error(`${label}必须包含 1 至 ${MAX_LIST_ITEMS} 项`);
  }
  return value.map(item => {
    if (typeof item !== "string") throw new Error(`${label}只能包含文本`);
    const normalized = item.trim();
    if (normalized.length < 1 || normalized.length > MAX_LIST_ITEM_LENGTH) {
      throw new Error(`${label}条目长度无效`);
    }
    return normalized;
  });
}

function agentText(value: unknown, label: string): string {
  if (typeof value !== "string") throw new Error(`${label}必须是文本`);
  const normalized = value.trim();
  if (!normalized) throw new Error(`${label}长度无效`);
  return normalized.length <= MAX_TEXT_LENGTH
    ? normalized
    : `${normalized.slice(0, MAX_TEXT_LENGTH - 1)}…`;
}

function agentList(value: unknown, label: string): string[] {
  if (!Array.isArray(value) || value.length < 1) {
    throw new Error(`${label}必须包含 1 至 ${MAX_LIST_ITEMS} 项`);
  }
  const chunks: string[] = [];
  for (const item of value) {
    if (typeof item !== "string") throw new Error(`${label}只能包含文本`);
    const normalized = item.trim();
    if (!normalized) throw new Error(`${label}条目长度无效`);
    chunks.push(...splitListItem(normalized));
  }
  if (chunks.length <= MAX_LIST_ITEMS) return chunks;
  const retained = chunks.slice(0, MAX_LIST_ITEMS - 1);
  const overflow = chunks.slice(MAX_LIST_ITEMS - 1).join(" ");
  retained.push(overflow.length <= MAX_LIST_ITEM_LENGTH
    ? overflow
    : `${overflow.slice(0, MAX_LIST_ITEM_LENGTH - 1)}…`);
  return retained;
}

function splitListItem(value: string): string[] {
  const chunks: string[] = [];
  let remaining = value;
  while (remaining.length > MAX_LIST_ITEM_LENGTH) {
    let boundary = MAX_LIST_ITEM_LENGTH;
    const preferredMinimum = Math.floor(MAX_LIST_ITEM_LENGTH * 0.6);
    for (let index = MAX_LIST_ITEM_LENGTH; index >= preferredMinimum; index -= 1) {
      if (/[\s，。；：、,.!！?？;:]/u.test(remaining[index - 1] ?? "")) {
        boundary = index;
        break;
      }
    }
    const chunk = remaining.slice(0, boundary).trim();
    if (chunk) chunks.push(chunk);
    remaining = remaining.slice(boundary).trim();
  }
  if (remaining) chunks.push(remaining);
  return chunks;
}

function stringList(value: unknown): string[] {
  return Array.isArray(value)
    ? value.filter((item): item is string => typeof item === "string" && item.trim().length > 0)
    : [];
}
