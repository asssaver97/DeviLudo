import type { ChildProcess } from "node:child_process";
import type { Interface } from "node:readline";

export function readCliArgument(arguments_: readonly string[], name: string): string;
export function closeLineInput(reader: Interface | null | undefined, input: NodeJS.ReadStream | null | undefined): void;
export function terminateChildProcess(child: ChildProcess, signal?: NodeJS.Signals, killProcessGroup?: boolean): boolean;
export function waitForChildWithHardTimeout(
  child: ChildProcess,
  options: Readonly<{ timeoutMs: number; terminateGraceMs?: number; killProcessGroup?: boolean }>,
): Promise<Readonly<{ code: number | null; signal: NodeJS.Signals | "SIGKILL" | null; timedOut: boolean }>>;
