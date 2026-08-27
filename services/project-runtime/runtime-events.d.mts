export function runtimeEventText(value: unknown): string | null;
export function runtimeEventDeltaText(value: unknown): string | null;
export function runtimeEventFinalText(value: unknown): string | null;
export function createStructuredContentDeltaExtractor(onDelta: (delta: string) => void): Readonly<{
  push(chunk: string): void;
}>;
export function createRuntimeEventLineBuffer(onLine: (line: string) => void): Readonly<{
  push(chunk: string): void;
  flush(): void;
}>;
export function finalRuntimeContent(stdout: string): string;
export function structuredRuntimeOutput(content: string): Record<string, unknown>;
