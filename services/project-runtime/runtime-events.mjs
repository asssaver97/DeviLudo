export function runtimeEventText(value) {
  if (!value || typeof value !== "object" || Array.isArray(value)) return null;
  const event = value;
  const nestedEvent = event.event && typeof event.event === "object" && !Array.isArray(event.event)
    ? event.event
    : null;
  const item = event.item && typeof event.item === "object" && !Array.isArray(event.item)
    ? event.item
    : null;
  const message = event.message && typeof event.message === "object" && !Array.isArray(event.message)
    ? event.message
    : null;
  const deltaValue = event.delta ?? nestedEvent?.delta;
  const delta = deltaValue && typeof deltaValue === "object" && !Array.isArray(deltaValue)
    ? deltaValue
    : null;
  if (item?.type === "agent_message" && typeof item.text === "string") return item.text;
  if (typeof event.result === "string") return event.result;
  if (typeof delta?.text === "string") return delta.text;
  const content = Array.isArray(message?.content)
    ? message.content
    : Array.isArray(item?.content) ? item.content : [];
  const text = content.map(part => part && typeof part === "object" && typeof part.text === "string"
    ? part.text
    : "").join("");
  return text || null;
}

export function createRuntimeEventLineBuffer(onLine) {
  let buffer = "";
  return Object.freeze({
    push(chunk) {
      buffer += chunk;
      const lines = buffer.split(/\r?\n/);
      buffer = lines.pop() ?? "";
      for (const line of lines) if (line) onLine(line);
    },
    flush() {
      if (buffer) onLine(buffer);
      buffer = "";
    },
  });
}

export function finalRuntimeContent(stdout) {
  let content = null;
  for (const line of stdout.split(/\r?\n/).filter(Boolean)) {
    let event;
    try { event = JSON.parse(line); } catch { continue; }
    const text = runtimeEventText(event);
    if (text) content = text;
  }
  return content ?? stdout.trim();
}

export function structuredRuntimeOutput(content) {
  const match = content.match(/```json\s*([\s\S]*?)```/i);
  const candidate = match?.[1] ?? content;
  try {
    const value = JSON.parse(candidate.trim());
    return value && typeof value === "object" && !Array.isArray(value) ? value : {};
  } catch { return {}; }
}
