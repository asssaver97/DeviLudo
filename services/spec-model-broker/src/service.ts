import { randomUUID } from "node:crypto";
import { parseSpecModelResult } from "../../spec-dialogue/src/contracts";
import { parseSpecGenerationRequest, requestDigest, validateOperationKey, validateUsage } from "./contract";
import type {
  SpecModelGenerator,
  SpecModelOperationLookup,
  SpecModelOperationStore,
  SpecModelProviderAuthority,
} from "./contracts";
import {
  SpecModelBusyError,
  SpecModelIndeterminateError,
  SpecModelUpstreamError,
} from "./contracts";

const DEFAULT_LEASE_SECONDS = 180;

export class SpecModelBrokerService {
  constructor(private readonly options: Readonly<{
    store: SpecModelOperationStore;
    authority: SpecModelProviderAuthority;
    generator: SpecModelGenerator;
    profileRevisionId: string;
    leaseSeconds?: number;
  }>) {
    const leaseSeconds = options.leaseSeconds ?? DEFAULT_LEASE_SECONDS;
    if (!Number.isInteger(leaseSeconds) || leaseSeconds < 30 || leaseSeconds > 600) {
      throw new Error("Specification model operation lease is invalid");
    }
  }

  async generate(value: unknown, operationKeyValue: unknown) {
    const request = parseSpecGenerationRequest(value);
    const operationKey = validateOperationKey(operationKeyValue);
    const digest = requestDigest(request);
    const scope = {
      tenantId: request.tenantId,
      projectId: request.projectId,
      conversationId: request.conversationId,
      operationKey,
      requestDigest: digest,
    };
    const existing = await this.options.store.lookup(scope);
    const replay = resultOrThrow(existing);
    if (replay) return replay;

    const provider = await this.options.authority.resolve(this.options.profileRevisionId);
    const claimToken = randomUUID();
    const claimed = await this.options.store.claim({
      ...scope,
      provider,
      claimToken,
      leaseSeconds: this.options.leaseSeconds ?? DEFAULT_LEASE_SECONDS,
    });
    if (claimed.kind === "COMPLETED") return parseSpecModelResult(claimed.result);
    if (claimed.kind === "BUSY") throw new SpecModelBusyError("Specification model operation is busy");
    if (claimed.kind === "INDETERMINATE") {
      throw new SpecModelIndeterminateError("Specification model operation needs reconciliation");
    }

    try {
      const generated = await this.options.generator.generate({ operationKey, request, provider });
      const result = parseSpecModelResult(generated.result);
      const usage = validateUsage(generated.usage);
      try {
        await this.options.store.complete({
          tenantId: request.tenantId,
          operationKey,
          claimToken,
          result,
          usage,
        });
      } catch (error) {
        await this.options.store.abandon({ tenantId: request.tenantId, operationKey, claimToken }).catch(() => undefined);
        throw error;
      }
      return result;
    } catch (error) {
      if (error instanceof SpecModelUpstreamError && error.dispatched) {
        await this.options.store.abandon({ tenantId: request.tenantId, operationKey, claimToken }).catch(() => undefined);
      } else {
        await this.options.store.release({ tenantId: request.tenantId, operationKey, claimToken }).catch(() => undefined);
      }
      throw error;
    }
  }

  async probe(): Promise<void> {
    await Promise.all([this.options.store.probe(), this.options.authority.probe(), this.options.generator.probe()]);
  }
}

function resultOrThrow(value: SpecModelOperationLookup) {
  if (value === null || value.kind === "RETRY") return null;
  if (value.kind === "COMPLETED") return parseSpecModelResult(value.result);
  if (value.kind === "BUSY") throw new SpecModelBusyError("Specification model operation is busy");
  throw new SpecModelIndeterminateError("Specification model operation needs reconciliation");
}
