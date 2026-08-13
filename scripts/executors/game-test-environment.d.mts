export type GameTestEnvironmentOptions = Readonly<{
  pid: number | null;
  runId: string;
  workspace: string;
  driver(command: string, arguments_: string[], timeoutMs?: number): Promise<unknown>;
  gamepadDriver?: string;
  useGamepad?: boolean;
}>;

export class GameTestEnvironment {
  constructor(options: GameTestEnvironmentOptions);
  readonly pid: number | null;
  readonly runId: string;
  prepareInputDevices(): Promise<void>;
  attach(pid: number): void;
  prepare(): Promise<void>;
  sequence(events: readonly Readonly<Record<string, unknown>>[], timeoutMs: number): Promise<void>;
  capture(outputPath: string): Promise<unknown>;
  close(): Promise<Readonly<{ id: string; path: string; frameCount: number }> | null>;
}

export function gamepadEventCount(events: readonly Readonly<Record<string, unknown>>[]): number;
