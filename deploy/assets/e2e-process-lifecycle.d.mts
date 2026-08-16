import type { ChildProcess } from "node:child_process";
import type { Interface } from "node:readline";

export function readCliArgument(arguments_: readonly string[], name: string): string;
export function closeLineInput(reader: Interface | null | undefined, input: NodeJS.ReadStream | null | undefined): void;
export function terminateChildProcess(child: ChildProcess, signal?: NodeJS.Signals, killProcessGroup?: boolean): boolean;
export function forwardTerminationSignals(child: ChildProcess, killProcessGroup?: boolean): () => void;
export function closeChildPipesAfterExit(child: ChildProcess, graceMs?: number): () => void;
export function settleChildAfterProtocolResult(
  child: ChildProcess,
  childClosed: Promise<{ code: number | null; signal: NodeJS.Signals | null; timedOut: boolean }>,
  options?: { graceMs?: number; killProcessGroup?: boolean },
): Promise<{
  result: { code: number | null; signal: NodeJS.Signals | null; timedOut: boolean };
  transportTerminated: boolean;
}>;
export function startChildProtocolWatchdog(
  child: ChildProcess,
  options: { idleMs: number; checkMs?: number; terminateGraceMs?: number; killProcessGroup?: boolean },
): Readonly<{ touch(): void; expired(): boolean; stop(): void }>;
export function readProtocolLineWithTimeout<T>(
  iterator: AsyncIterator<T>,
  childClosed: Promise<unknown>,
  timeoutMs: number,
): Promise<IteratorResult<T>>;
export function waitForChildWithHardTimeout(
  child: ChildProcess,
  options: Readonly<{ timeoutMs: number; terminateGraceMs?: number; killProcessGroup?: boolean }>,
): Promise<Readonly<{ code: number | null; signal: NodeJS.Signals | "SIGKILL" | null; timedOut: boolean }>>;
