const SAFE_ID = /^[A-Za-z0-9][A-Za-z0-9._:-]{0,159}$/;

export class AgentExecutionCancelledError extends Error {
  constructor(
    readonly runId: string,
    readonly providerRevisionId: string,
  ) {
    super("Agent execution was cancelled by the authoritative delivery workflow");
    this.name = "AgentExecutionCancelledError";
    if (!SAFE_ID.test(runId) || !SAFE_ID.test(providerRevisionId)) {
      throw new Error("Agent execution cancellation binding is invalid");
    }
  }
}
