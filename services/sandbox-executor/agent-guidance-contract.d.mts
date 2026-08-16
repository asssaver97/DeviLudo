export type AgentGuidanceSnapshot = Readonly<{
  digest: string;
  byteLength: number;
  entries: readonly Readonly<{ content: string; receivedAt: string | null }>[];
}>;

export function readAgentGuidanceSnapshot(path?: string): Promise<AgentGuidanceSnapshot>;
export function agentGuidanceArrivedDuringRun(
  before: AgentGuidanceSnapshot,
  after: AgentGuidanceSnapshot,
): readonly string[];
export function waitForAgentGuidanceQuiescence(
  initial: AgentGuidanceSnapshot,
  path?: string,
  options?: Readonly<{ quiescenceMs?: number; pollMs?: number }>,
): Promise<AgentGuidanceSnapshot>;
export function snapshotAgentProjectTurn(projectRoot: string, snapshotRoot: string): Promise<void>;
export function restoreAgentProjectTurn(projectRoot: string, snapshotRoot: string): Promise<void>;
export function discardAgentProjectTurnSnapshot(snapshotRoot: string): Promise<void>;
