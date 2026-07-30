import type { AgentProgressEvent, AgentProgressEventKind } from "./contracts";

export type AgentProgressDisplayRow = Readonly<{
  sequence: number;
  kind: AgentProgressEventKind;
  content: string;
}>;

/**
 * Executor text deltas are transport fragments, not paragraphs. Keep phase and
 * status events distinct, but render adjacent Agent deltas as one continuous
 * stream so an arbitrary transport boundary never becomes visible to players.
 */
export function agentProgressDisplayRows(
  events: readonly AgentProgressEvent[],
): readonly AgentProgressDisplayRow[] {
  const rows: AgentProgressDisplayRow[] = [];
  for (const event of events) {
    const previous = rows.at(-1);
    if (event.kind === "AGENT_OUTPUT" && previous?.kind === "AGENT_OUTPUT") {
      rows[rows.length - 1] = Object.freeze({
        ...previous,
        content: previous.content + event.content,
      });
      continue;
    }
    rows.push(Object.freeze({
      sequence: event.sequence,
      kind: event.kind,
      content: event.content,
    }));
  }
  return Object.freeze(rows);
}
