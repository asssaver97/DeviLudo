import type { ProbeAssertion } from "../lib/product/interaction-script.js";

export const E2E_UI_PROBE_SCHEMA: "deviludo.e2e-ui-probe";
export const E2E_CLIENT_WIDTH: 1280;
export const E2E_CLIENT_HEIGHT: 720;

export type E2EProbeValue = string | number | boolean | null;
export type E2EProbeRect = Readonly<{ x: number; y: number; width: number; height: number }>;
export type E2EProbeControl = Readonly<{
  id: string;
  scope: "NAVIGATION" | "GAMEPLAY" | "OVERLAY" | "STATUS";
  visible: boolean;
  enabled: boolean;
  rect: E2EProbeRect;
  text?: string;
  value?: E2EProbeValue;
}>;
export type E2EProbeAssetBinding = Readonly<{
  assetKey: string;
  targetId: string;
  resourcePath: string;
  sha256?: string;
  visible: boolean;
  rect: E2EProbeRect;
}>;
export type E2EProbeSnapshot = Readonly<{
  schema: typeof E2E_UI_PROBE_SCHEMA;
  sessionNonce: string;
  pid: number;
  sequence: number;
  sceneId: string;
  state: Readonly<Record<string, E2EProbeValue>>;
  progress: Readonly<Record<string, E2EProbeValue>>;
  controls: readonly E2EProbeControl[];
  assetBindings?: readonly E2EProbeAssetBinding[];
}>;
export type E2EProbeExpectation = Readonly<{
  sessionNonce?: string;
  pid?: number;
  afterSequence?: number;
}>;
export type E2EProbeAssertionResult = Readonly<{
  assertion: ProbeAssertion;
  previous: E2EProbeValue;
  actual: E2EProbeValue;
  passed: boolean;
}>;

export function validateProbeSnapshot(value: unknown, expected?: E2EProbeExpectation): value is E2EProbeSnapshot;
export function probeSnapshotValidationError(value: unknown, expected?: E2EProbeExpectation): string | null;
export function readProbeSnapshot(path: string, expected?: E2EProbeExpectation): Promise<E2EProbeSnapshot | null>;
export function waitForProbeSnapshot(path: string, expected: E2EProbeExpectation, timeoutMs?: number): Promise<E2EProbeSnapshot>;
export function waitForProbePostconditions(path: string, expected: E2EProbeExpectation, before: E2EProbeSnapshot, assertions: readonly ProbeAssertion[], timeoutMs?: number): Promise<Readonly<{
  snapshot: E2EProbeSnapshot;
  assertions: readonly E2EProbeAssertionResult[];
  stateChanged: boolean;
  passed: boolean;
}>>;
export function resolveProbeControl(snapshot: E2EProbeSnapshot, targetId: string, options?: Readonly<{ requireEnabled?: boolean }>): Readonly<{ control: E2EProbeControl; center: Readonly<{ x: number; y: number }> }>;
export function resolveProbeControlAtPoint(snapshot: E2EProbeSnapshot, x: number, y: number): E2EProbeControl | null;
export function resolveProbeAssetBinding(snapshot: E2EProbeSnapshot, assetKey: string, targetId: string): E2EProbeAssetBinding;
export function evaluateProbeAssertions(assertions: readonly ProbeAssertion[], before: E2EProbeSnapshot, after: E2EProbeSnapshot): readonly E2EProbeAssertionResult[];
export function probeStateDigest(snapshot: E2EProbeSnapshot): string;
