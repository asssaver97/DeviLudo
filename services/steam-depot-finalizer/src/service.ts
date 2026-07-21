import { randomUUID } from "node:crypto";
import {
  parseSteamDepotFinalizationRequest,
  steamDepotFinalizationReceiptDigest,
  validateSteamDepotFinalizationReceipt,
} from "./contract";
import type {
  SteamDepotFinalizationOperationStore,
  SteamDepotFinalizationReceipt,
  SteamDepotNativeFinalizer,
} from "./contracts";

const UUID = /^[a-f0-9]{8}-[a-f0-9]{4}-[1-5][a-f0-9]{3}-[89ab][a-f0-9]{3}-[a-f0-9]{12}$/i;
const DEFAULT_LEASE_MS = 55 * 60_000;

export class SteamDepotFinalizationBusyError extends Error {
  constructor() {
    super("Steam depot finalization operation is already running");
    this.name = "SteamDepotFinalizationBusyError";
  }
}

/** Durable fenced authority around the platform-native signing executable. */
export class DurableSteamDepotFinalizerService {
  readonly #now: () => Date;
  readonly #claimToken: () => string;
  readonly #leaseMs: number;

  constructor(
    private readonly operations: SteamDepotFinalizationOperationStore,
    private readonly native: SteamDepotNativeFinalizer,
    options: Readonly<{ now?: () => Date; claimToken?: () => string; leaseMs?: number }> = {},
  ) {
    this.#now = options.now ?? (() => new Date());
    this.#claimToken = options.claimToken ?? randomUUID;
    this.#leaseMs = integer(options.leaseMs ?? DEFAULT_LEASE_MS, 60_000, 60 * 60_000);
  }

  async finalize(value: unknown): Promise<SteamDepotFinalizationReceipt> {
    const request = parseSteamDepotFinalizationRequest(value);
    const claimToken = this.#claimToken();
    if (!UUID.test(claimToken)) invalid("claim token");
    const claimedAt = validDate(this.#now());
    const claim = await this.operations.claim({
      request,
      claimToken,
      claimedAt: claimedAt.toISOString(),
      claimExpiresAt: new Date(claimedAt.getTime() + this.#leaseMs).toISOString(),
    });
    if (claim.kind === "BUSY") throw new SteamDepotFinalizationBusyError();
    if (claim.kind === "REPLAY") return validateSteamDepotFinalizationReceipt(claim.receipt, request);
    try {
      const receipt = validateSteamDepotFinalizationReceipt(await this.native.finalize(request), request);
      await this.operations.complete({
        request,
        claimToken,
        receipt,
        receiptDigest: steamDepotFinalizationReceiptDigest(receipt),
        completedAt: validDate(this.#now()).toISOString(),
      });
      return receipt;
    } catch (error) {
      await this.operations.release({
        request,
        claimToken,
        releasedAt: validDate(this.#now()).toISOString(),
      }).catch(() => undefined);
      throw error;
    }
  }

  async probe(): Promise<void> {
    await Promise.all([this.operations.probe(), this.native.probe()]);
  }
}

function validDate(value: Date): Date {
  if (!(value instanceof Date) || !Number.isFinite(value.getTime())) invalid("clock");
  return value;
}

function integer(value: number, minimum: number, maximum: number): number {
  if (!Number.isSafeInteger(value) || value < minimum || value > maximum) invalid("lease");
  return value;
}

function invalid(label: string): never {
  throw new Error(`Steam depot finalizer service ${label} is invalid`);
}
