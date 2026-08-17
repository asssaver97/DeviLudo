export function validateGuestInteractionScript(
  value: unknown,
  journeyRequirements: readonly string[],
  playerRequirements: ReadonlySet<string>,
): boolean;
export function validateProbeAssertion(value: unknown): boolean;
export function validLaunchProfile(value: unknown): boolean;
export function isInteractionAction(value: unknown): boolean;
export const CORE_START_ASSERTIONS: readonly Readonly<Record<string, unknown>>[];
export const CORE_READY_ASSERTIONS: readonly Readonly<Record<string, unknown>>[];
export function validateCoreJourneyLifecycle(events: readonly unknown[]): boolean;
export function checkpointOutputMarker(id: unknown): string;
export function isStableId(value: unknown): boolean;
export function isSafeProjectPngPath(value: unknown): boolean;
