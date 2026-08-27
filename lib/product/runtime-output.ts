export type RuntimeOutputTextFragment = Readonly<{
  content: string;
  continuous: boolean;
}>;

/**
 * Convert provider JSONL into the text authored by the model or emitted by a
 * command. Transport metadata remains available in Core's durable event log,
 * but never leaks into the player-facing process view.
 */
export function runtimeOutputText(output: string): string {
  const rendered: string[] = [];
  const lines = output.split(/\r?\n/u);
  for (const [index, line] of lines.entries()) {
    if (!line) {
      if (index > 0 && index < lines.length - 1) rendered.push("\n");
      continue;
    }
    let value: unknown;
    try { value = JSON.parse(line); } catch {
      appendFragment(rendered, Object.freeze({
        content: `${line}${index < lines.length - 1 ? "\n" : ""}`,
        continuous: true,
      }));
      continue;
    }
    for (const fragment of runtimeOutputTextFragments(value)) appendFragment(rendered, fragment);
  }
  return rendered.join("");
}

export function runtimeOutputTextFragments(value: unknown): readonly RuntimeOutputTextFragment[] {
  const event = record(value);
  if (!event) return Object.freeze([]);
  const type = string(event.type);

  if (type === "deviludo.content_delta") {
    return fragments(string(event.delta), true);
  }

  if (type === "stream_event") {
    const nested = record(event.event);
    const delta = record(nested?.delta);
    const thinking = string(delta?.thinking);
    if (thinking) return fragments(thinking, true);
    // text_delta carries the role's structured JSON response. Core emits the
    // decoded `content` value separately as deviludo.content_delta.
    if (string(delta?.text)) return Object.freeze([]);
    const block = record(nested?.content_block);
    if (string(block?.type) === "tool_use") return toolFragment(block);
    return fragments(string(block?.text) || string(block?.thinking), false);
  }

  // Claude's complete assistant/result records repeat stream_event deltas.
  // Keeping only the deltas prevents the same paragraph appearing twice.
  if (type === "assistant" || type === "result") return Object.freeze([]);

  const item = record(event.item);
  const itemType = string(item?.type);
  if (itemType === "reasoning" || itemType === "thinking") {
    return fragments(textPayload(item?.text ?? item?.thinking ?? item?.summary), false);
  }
  if (itemType === "agent_message" || itemType === "message") {
    return fragments(visibleAgentText(item?.text ?? item?.content), false);
  }
  if (itemType === "command_execution" || itemType === "shell_command") {
    const outputText = textPayload(item?.aggregated_output ?? item?.output);
    if (outputText) return fragments(outputText, false);
    return type.endsWith(".started")
      ? fragments(safeCommand(string(item?.command)), false)
      : Object.freeze([]);
  }
  if (itemType === "mcp_tool_call" || itemType === "tool_use" || itemType === "tool_result") {
    const toolError = textPayload(item?.error);
    if (toolError) return fragments(toolError, false);
    return type.endsWith(".started") ? toolFragment(item) : Object.freeze([]);
  }

  const error = record(event.error);
  const errorText = string(error?.message) || string(event.message);
  if (type.includes("error") || type.includes("failed")) return fragments(errorText, false);

  const delta = record(event.delta);
  const directThinking = string(delta?.thinking);
  if (directThinking) return fragments(directThinking, true);
  if (!type && typeof event.content === "string") {
    return fragments(event.content, false);
  }
  return Object.freeze([]);
}

function appendFragment(target: string[], fragment: RuntimeOutputTextFragment): void {
  if (!fragment.content) return;
  if (fragment.continuous) {
    target.push(fragment.content);
    return;
  }
  const previous = target.at(-1) ?? "";
  if (target.length && previous && !previous.endsWith("\n")) target.push("\n");
  target.push(fragment.content);
  if (!fragment.content.endsWith("\n")) target.push("\n");
}

function fragments(content: string, continuous: boolean): readonly RuntimeOutputTextFragment[] {
  return content ? Object.freeze([Object.freeze({ content, continuous })]) : Object.freeze([]);
}

function visibleAgentText(value: unknown): string {
  const text = textPayload(value);
  if (!text) return "";
  const unwrapped = text.trim().replace(/^```(?:json)?\s*/iu, "").replace(/\s*```$/u, "");
  if (!unwrapped.startsWith("{") && !unwrapped.startsWith("[")) return text;
  try {
    JSON.parse(unwrapped);
    return "";
  } catch {
    return text;
  }
}

function textPayload(value: unknown): string {
  if (typeof value === "string") return value;
  if (Array.isArray(value)) return value.map(item => {
    if (typeof item === "string") return item;
    const object = record(item);
    return object ? string(object.text) || string(object.thinking) || textPayload(object.content) : "";
  }).join("");
  const object = record(value);
  if (!object) return "";
  return string(object.text) || string(object.thinking) || string(object.message)
    || textPayload(object.content) || textPayload(object.output);
}

function safeCommand(value: string): string {
  if (!value) return "";
  let command = value.trim().split(/\r?\n/u, 1)[0] ?? "";
  const shell = command.match(/^\/bin\/(?:ba|z)?sh\s+-lc\s+(.+)$/u)?.[1];
  if (shell) command = shell.replace(/^(['"])(.*)\1$/u, "$2");
  command = command
    .replace(/\b([A-Za-z_][A-Za-z0-9_]*=)(?:"[^"]*"|'[^']*'|\S+)/gu, "$1••••")
    .replace(/(--?(?:api[-_]?key|token|password|secret))(?:=|\s+)\S+/giu, "$1=••••")
    .slice(0, 500);
  return command ? `$ ${command}` : "";
}

function toolFragment(value: Record<string, unknown> | null): readonly RuntimeOutputTextFragment[] {
  const name = string(value?.tool) || string(value?.name);
  const server = string(value?.server);
  return fragments(name ? `› ${server ? `${server}.` : ""}${name}` : "", false);
}

function record(value: unknown): Record<string, unknown> | null {
  return value && typeof value === "object" && !Array.isArray(value)
    ? value as Record<string, unknown>
    : null;
}

function string(value: unknown): string {
  return typeof value === "string" ? value : "";
}
