export type DomainErrorCode =
  | "INVALID_STATE_TRANSITION"
  | "INVALID_CONFIGURATION"
  | "POLICY_ESCALATION"
  | "PROFILE_NOT_FOUND"
  | "PROFILE_NOT_ACTIVE"
  | "FLOATING_VERSION"
  | "E2E_RESULT_REJECTED"
  | "INVARIANT_VIOLATION";

/** A safe, structured error. Details must never contain credentials or prompts. */
export class DomainError extends Error {
  readonly code: DomainErrorCode;
  readonly details: Readonly<Record<string, string | number | boolean | null>>;

  constructor(
    code: DomainErrorCode,
    message: string,
    details: Record<string, string | number | boolean | null> = {},
  ) {
    super(message);
    this.name = "DomainError";
    this.code = code;
    this.details = Object.freeze({ ...details });
  }
}

export function invariant(
  condition: unknown,
  message: string,
  details: Record<string, string | number | boolean | null> = {},
): asserts condition {
  if (!condition) {
    throw new DomainError("INVARIANT_VIOLATION", message, details);
  }
}
