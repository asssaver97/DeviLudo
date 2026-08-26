export const ROLE_TO_CANONICAL_TOOLS: Readonly<Record<string, readonly string[]>>;
export function nativeToolName(canonicalName: string): string;
export function canonicalToolName(role: string, nativeName: string): string | null;
export function toolInputSchema(canonicalName: string): Readonly<Record<string, unknown>>;
