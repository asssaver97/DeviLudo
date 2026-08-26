export function runtimeEventText(value: unknown): string | null;
export function createRuntimeEventLineBuffer(onLine: (line: string) => void): Readonly<{
  push(chunk: string): void;
  flush(): void;
}>;
export function finalRuntimeContent(stdout: string): string;
export function structuredRuntimeOutput(content: string): Record<string, unknown>;
