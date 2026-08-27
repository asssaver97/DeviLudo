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

export function runtimeEventDeltaText(value) {
  if (!value || typeof value !== "object" || Array.isArray(value)) return null;
  const event = value;
  const nestedEvent = event.event && typeof event.event === "object" && !Array.isArray(event.event)
    ? event.event
    : null;
  const deltaValue = event.delta ?? nestedEvent?.delta;
  const delta = deltaValue && typeof deltaValue === "object" && !Array.isArray(deltaValue)
    ? deltaValue
    : null;
  return typeof delta?.text === "string" ? delta.text : null;
}

export function runtimeEventFinalText(value) {
  if (!value || typeof value !== "object" || Array.isArray(value)) return null;
  const event = value;
  const item = event.item && typeof event.item === "object" && !Array.isArray(event.item)
    ? event.item
    : null;
  if (item?.type === "agent_message" && typeof item.text === "string") return item.text;
  return typeof event.result === "string" ? event.result : null;
}

/**
 * Extracts only the top-level JSON `content` string from an Agent's structured
 * response. Provider deltas can therefore be shown to the player without ever
 * forwarding reasoning, tool commentary, JSON syntax, or machine-only fields.
 */
export function createStructuredContentDeltaExtractor(onDelta) {
  let state = "SEEK_OBJECT";
  let depth = 0;
  let stringRole = null;
  let stringValue = "";
  let pendingKey = null;
  let escape = false;
  let unicode = "";
  let output = "";

  const emit = value => {
    if (value) output += value;
  };

  const resetString = role => {
    stringRole = role;
    stringValue = "";
    escape = false;
    unicode = "";
  };

  const decodedEscape = character => {
    if (character === "u") {
      unicode = "u";
      return;
    }
    const mapped = Object.freeze({
      '"': '"', "\\": "\\", "/": "/", b: "\b", f: "\f", n: "\n", r: "\r", t: "\t",
    })[character];
    if (mapped === undefined) {
      state = "DONE";
      return;
    }
    if (stringRole === "CONTENT") emit(mapped);
    else stringValue += mapped;
    escape = false;
  };

  const push = chunk => {
    if (state === "DONE" || typeof chunk !== "string" || !chunk) return;
    output = "";
    for (const character of chunk) {
      if (state === "DONE") break;
      if (stringRole) {
        if (unicode) {
          unicode += character;
          if (unicode.length === 5) {
            if (!/^u[0-9a-f]{4}$/i.test(unicode)) {
              state = "DONE";
              break;
            }
            const decoded = String.fromCharCode(Number.parseInt(unicode.slice(1), 16));
            if (stringRole === "CONTENT") emit(decoded);
            else stringValue += decoded;
            unicode = "";
            escape = false;
          }
          continue;
        }
        if (escape) {
          decodedEscape(character);
          continue;
        }
        if (character === "\\") {
          escape = true;
          continue;
        }
        if (character === '"') {
          const completedRole = stringRole;
          stringRole = null;
          if (completedRole === "CONTENT") {
            state = "DONE";
            break;
          }
          if (completedRole === "KEY") pendingKey = stringValue;
          continue;
        }
        if (stringRole === "CONTENT") emit(character);
        else stringValue += character;
        continue;
      }

      if (state === "SEEK_OBJECT") {
        if (character === "{") {
          state = "JSON";
          depth = 1;
        }
        continue;
      }
      if (state === "SEEK_CONTENT_VALUE") {
        if (/\s/u.test(character)) continue;
        if (character !== '"') {
          state = "DONE";
          break;
        }
        resetString("CONTENT");
        continue;
      }
      if (character === '"') {
        resetString(depth === 1 && pendingKey === null ? "KEY" : "OTHER");
        continue;
      }
      if (character === "{") {
        depth += 1;
        continue;
      }
      if (character === "[") {
        depth += 1;
        continue;
      }
      if (character === "}" || character === "]") {
        depth -= 1;
        if (depth <= 0) state = "DONE";
        continue;
      }
      if (character === ":" && depth === 1 && pendingKey !== null) {
        if (pendingKey === "content") state = "SEEK_CONTENT_VALUE";
        pendingKey = null;
        continue;
      }
      if (character === "," && depth === 1) pendingKey = null;
    }
    if (output) onDelta(output);
  };

  return Object.freeze({ push });
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
