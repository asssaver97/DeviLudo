import type { AgentEvent } from "../../../lib/agent/types";

const STRUCTURAL_SECRET_PATTERNS = Object.freeze([
  /\b(?:sk|api|key|token)-[A-Za-z0-9_-]{8,}\b/gi,
  /(authorization\s*:\s*bearer\s+)[^\s,;]+/gi,
  /((?:api[_-]?key|access[_-]?token|token|secret|password)\s*[=:]\s*)[^\s,;]+/gi,
]);

export class SecretRedactor {
  readonly #knownSecrets: readonly string[];

  constructor(knownSecrets: readonly string[]) {
    this.#knownSecrets = Object.freeze(
      [...new Set(knownSecrets.filter((secret) => secret.length >= 4))].sort(
        (left, right) => right.length - left.length,
      ),
    );
  }

  redact(value: string, limit = 64_000): string {
    let output = value;
    for (const secret of this.#knownSecrets) {
      output = output.replaceAll(secret, redactionMarker(secret.length));
    }
    for (const pattern of STRUCTURAL_SECRET_PATTERNS) {
      pattern.lastIndex = 0;
      output = output.replace(pattern, (match, prefix?: unknown) => {
        if (typeof prefix !== "string") return redactionMarker(match.length);
        return `${prefix}${redactionMarker(match.length - prefix.length)}`;
      });
    }
    return output.slice(0, limit);
  }

  event(event: AgentEvent): AgentEvent {
    return Object.freeze({
      ...event,
      sessionId: redactOptional(this, event.sessionId, 500),
      message: redactOptional(this, event.message, 2_000),
      toolName: redactOptional(this, event.toolName, 500),
      path: redactOptional(this, event.path, 500),
      rawType: redactOptional(this, event.rawType, 500),
    });
  }
}

function redactionMarker(minimumLength: number): string {
  return "[REDACTED]".padEnd(minimumLength, "*");
}

function redactOptional(
  redactor: SecretRedactor,
  value: string | undefined,
  limit: number,
): string | undefined {
  return value === undefined ? undefined : redactor.redact(value, limit);
}
