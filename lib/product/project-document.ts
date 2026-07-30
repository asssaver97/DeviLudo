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

function stringList(value: unknown): string[] {
  return Array.isArray(value)
    ? value.filter((item): item is string => typeof item === "string" && item.trim().length > 0)
    : [];
}
