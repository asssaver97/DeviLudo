import type { AgentProgressEvent } from "./contracts";

export async function readAgentProgressStream(
  projectId: string,
  after: number,
  signal: AbortSignal,
  onEvent: (event: AgentProgressEvent) => void,
): Promise<number> {
  const response = await fetch(
    `/api/projects/${encodeURIComponent(projectId)}/agent-progress/stream?after=${after}`,
    { cache: "no-store", signal },
  );
  if (!response.ok) throw new Error(`Agent progress stream failed (${response.status})`);
  if (!response.body) throw new Error("Agent progress stream is empty");
  const reader = response.body.getReader();
  const decoder = new TextDecoder();
  let buffer = "";
  let cursor = after;
  const consume = (line: string) => {
    if (!line.trim()) return;
    const value: unknown = JSON.parse(line);
    if (!value || typeof value !== "object" || Array.isArray(value)) return;
    const message = value as Record<string, unknown>;
    if (message.type === "cursor" && Number.isSafeInteger(message.after)) {
      cursor = Math.max(cursor, Number(message.after));
      return;
    }
    if (message.type !== "progress" || !message.event || typeof message.event !== "object") return;
    const event = message.event as AgentProgressEvent;
    if (!Number.isSafeInteger(event.sequence) || event.sequence <= cursor) return;
    cursor = event.sequence;
    onEvent(event);
  };
  while (!signal.aborted) {
    const { done, value } = await reader.read();
    buffer += decoder.decode(value, { stream: !done });
    const lines = buffer.split(/\r?\n/);
    buffer = lines.pop() ?? "";
    for (const line of lines) consume(line);
    if (done) break;
  }
  if (buffer.trim()) consume(buffer);
  return cursor;
}
