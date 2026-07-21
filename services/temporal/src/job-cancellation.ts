const SAFE_ID = /^[A-Za-z0-9][A-Za-z0-9._:-]{0,159}$/;

/**
 * The delivery cancellation transaction has already terminalized this exact
 * durable job. Consumers use the binding to distinguish an authoritative
 * cancellation from an unrelated lost lease or connector failure.
 */
export class WorkflowJobCancelledError extends Error {
  constructor(
    readonly tenantId: string,
    readonly jobId: string,
  ) {
    super("Workflow job was cancelled by the authoritative delivery transaction");
    this.name = "WorkflowJobCancelledError";
    if (!SAFE_ID.test(tenantId) || !SAFE_ID.test(jobId)) {
      throw new Error("Workflow job cancellation binding is invalid");
    }
  }
}
