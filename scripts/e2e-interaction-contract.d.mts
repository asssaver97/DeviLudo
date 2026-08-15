export function validateGuestInteractionScript(
  value: unknown,
  journeyRequirements: readonly string[],
  playerRequirements: ReadonlySet<string>,
): boolean;
export function validateProbeAssertion(value: unknown): boolean;
export function validLaunchProfile(value: unknown): boolean;
export function isInteractionAction(value: unknown): boolean;
export function checkpointOutputMarker(id: unknown): string;
export function isStableId(value: unknown): boolean;
export function isSafeProjectPngPath(value: unknown): boolean;
