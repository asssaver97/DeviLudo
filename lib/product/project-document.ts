export type ProjectDocumentContent = Readonly<{
  introduction: string;
  gameplay: string;
  uiDesign: string;
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
  responseLanguage: "en" | "zh" = "en",
): ProjectDocumentContent {
  const coreLoop = stringList(specification.coreLoop);
  const acceptance = stringList(specification.acceptanceCriteria);
  return Object.freeze({
    introduction: concept,
    gameplay: coreLoop.length > 0
      ? coreLoop.join("\n")
      : responseLanguage === "zh" ? "待 Agent 根据项目实现补充玩法说明。" : "The Agent will complete the gameplay description from the implementation.",
    uiDesign: responseLanguage === "zh"
      ? "待 UI 设计 Agent 根据已确认的玩法完成界面与交互规格。"
      : "The UI Design Agent will complete the interface and interaction specification from the approved gameplay.",
    categories: Object.freeze([responseLanguage === "zh" ? "待 Agent 分类" : "Pending Agent classification"]),
    features: Object.freeze(acceptance.length > 0
      ? acceptance
      : [responseLanguage === "zh" ? `完成《${projectName}》的核心游戏循环` : `Complete the core gameplay loop of “${projectName}”`]),
  });
}

export function parseProjectDocumentContent(value: unknown): ProjectDocumentContent {
  if (!value || typeof value !== "object" || Array.isArray(value)) {
    throw new Error("项目说明文档必须是对象");
  }
  const input = value as Record<string, unknown>;
  const introduction = requiredText(input.introduction, "游戏介绍");
  const gameplay = requiredText(input.gameplay, "玩法");
  const uiDesign = requiredText(input.uiDesign, "UI 设计");
  const categories = requiredList(input.categories, "游戏分类");
  const features = requiredList(input.features, "主要特性");
  return Object.freeze({
    introduction,
    gameplay,
    uiDesign,
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
    uiDesign: agentText(input.uiDesign, "UI 设计"),
    categories: Object.freeze(agentList(input.categories, "游戏分类")),
    features: Object.freeze(agentList(input.features, "主要特性")),
  });
}

/**
 * Specialist Agents may use nested objects to preserve an implementable design
 * (chapters, causal rules, screen blueprints, and so on), while the public
 * project document intentionally stores human-readable prose. Convert only the
 * five declared document fields at this trust boundary instead of shallowly
 * merging provider JSON into the strict persisted schema.
 */
export function applyAgentProjectDocumentPatch(
  current: ProjectDocumentContent,
  patch: Readonly<Record<string, unknown>>,
): ProjectDocumentContent {
  return normalizeAgentProjectDocumentContent({
    introduction: patchedText(current.introduction, patch.introduction),
    gameplay: patchedText(current.gameplay, patch.gameplay),
    uiDesign: patchedText(current.uiDesign, patch.uiDesign),
    categories: patchedList(current.categories, patch.categories),
    features: patchedList(current.features, patch.features),
  });
}

export function projectDocumentMarkdown(
  projectName: string,
  content: ProjectDocumentContent,
  responseLanguage: "en" | "zh" = "en",
): string {
  const headings = responseLanguage === "zh"
    ? ["游戏介绍", "玩法", "UI 设计", "游戏分类", "主要特性"]
    : ["Game overview", "Gameplay", "UI design", "Categories", "Key features"];
  return [
    `# ${projectName}`,
    "",
    `## ${headings[0]}`,
    "",
    content.introduction,
    "",
    `## ${headings[1]}`,
    "",
    content.gameplay,
    "",
    `## ${headings[2]}`,
    "",
    content.uiDesign,
    "",
    `## ${headings[3]}`,
    "",
    ...content.categories.map(category => `- ${category}`),
    "",
    `## ${headings[4]}`,
    "",
    ...content.features.map(feature => `- ${feature}`),
    "",
  ].join("\n");
}

/**
 * The project document is the human-readable source of truth for the next
 * delivery. Freeze its current gameplay and feature list into the executable
 * specification immediately before approval so E2E cannot keep validating an
 * obsolete import analysis after the user has changed the game requirements.
 */
export function synchronizeSpecificationWithProjectDocument(
  specification: Readonly<Record<string, unknown>>,
  document: ProjectDocumentContent,
): Readonly<Record<string, unknown>> {
  return Object.freeze({
    ...specification,
    vision: document.introduction,
    playerExperience: document.gameplay,
    coreLoop: Object.freeze(gameplaySteps(document.gameplay)),
    acceptanceCriteria: Object.freeze([...document.features]),
  });
}

function gameplaySteps(gameplay: string): string[] {
  const clauses = gameplay
    .split(/[\r\n。！？!?；;]+/u)
    .map(value => value.trim())
    .filter(Boolean);
  const steps: string[] = [];
  for (const clause of clauses.length > 0 ? clauses : [gameplay.trim()]) {
    let remaining = clause;
    while (remaining.length > MAX_LIST_ITEM_LENGTH && steps.length < MAX_LIST_ITEMS) {
      const candidate = remaining.slice(0, MAX_LIST_ITEM_LENGTH);
      const boundary = Math.max(candidate.lastIndexOf("，"), candidate.lastIndexOf(","), candidate.lastIndexOf(" "));
      const end = boundary >= Math.floor(MAX_LIST_ITEM_LENGTH / 2) ? boundary : MAX_LIST_ITEM_LENGTH;
      steps.push(remaining.slice(0, end).trim());
      remaining = remaining.slice(end).replace(/^[，,\s]+/u, "").trim();
    }
    if (remaining && steps.length < MAX_LIST_ITEMS) steps.push(remaining);
    if (steps.length >= MAX_LIST_ITEMS) break;
  }
  return steps.length > 0 ? steps : ["完成当前项目说明定义的核心游戏循环"];
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

function patchedText(current: string, value: unknown): string {
  if (value === undefined || value === null) return current;
  return typeof value === "string" ? value : structuredDocumentText(value);
}

function patchedList(current: readonly string[], value: unknown): readonly string[] {
  if (value === undefined || value === null) return current;
  if (Array.isArray(value)) return value.map(item => typeof item === "string" ? item : structuredDocumentText(item));
  if (value && typeof value === "object") {
    return Object.entries(value as Record<string, unknown>)
      .map(([key, item]) => `${key}：${structuredDocumentText(item)}`);
  }
  return [String(value)];
}

function structuredDocumentText(value: unknown, depth = 0): string {
  if (typeof value === "string") return value.trim();
  if (typeof value === "number" || typeof value === "boolean") return String(value);
  if (value === null || value === undefined) return "";
  if (Array.isArray(value)) {
    return value
      .map((item, index) => `${index + 1}. ${structuredDocumentText(item, depth + 1)}`)
      .filter(item => !/^\d+\.\s*$/u.test(item))
      .join("\n");
  }
  if (typeof value === "object") {
    const indent = "  ".repeat(depth);
    return Object.entries(value as Record<string, unknown>)
      .map(([key, item]) => {
        const rendered = structuredDocumentText(item, depth + 1);
        if (!rendered) return "";
        const multiline = rendered.includes("\n");
        return multiline
          ? `${indent}${key}：\n${rendered.split("\n").map(line => `${indent}  ${line}`).join("\n")}`
          : `${indent}${key}：${rendered}`;
      })
      .filter(Boolean)
      .join("\n");
  }
  return String(value);
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
