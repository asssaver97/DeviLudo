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
  const serverSentEvents = response.headers.get("content-type")?.toLowerCase().includes("text/event-stream") === true;
  const reader = response.body.getReader();
  const decoder = new TextDecoder();
  let buffer = "";
  let cursor = after;
  const consumePayload = (payload: string) => {
    if (!payload.trim()) return;
    const value: unknown = JSON.parse(payload);
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
  const consumeFrame = (frame: string) => {
    const lines = frame.split(/\r?\n/);
    const data = lines
      .filter(line => line.startsWith("data:"))
      .map(line => line.slice(5).trimStart());
    if (data.length) {
      consumePayload(data.join("\n"));
      return;
    }
    if (serverSentEvents) return;
    // Keep the reader compatible with an older Core while a self-hosted
    // instance is being upgraded from the former NDJSON stream.
    for (const line of lines) consumePayload(line);
  };
  while (!signal.aborted) {
    const { done, value } = await reader.read();
    buffer += decoder.decode(value, { stream: !done });
    const frames = buffer.split(serverSentEvents ? /\r?\n\r?\n/ : /\r?\n/);
    buffer = frames.pop() ?? "";
    for (const frame of frames) consumeFrame(frame);
    if (done) break;
  }
  if (buffer.trim()) consumeFrame(buffer);
  return cursor;
}
