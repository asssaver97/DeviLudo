// Visual testing protocol for screenshot-based E2E verification

export const VISUAL_TEST_VERSION = "1" as const;

export type VisualTestSpec = Readonly<{
  version: typeof VISUAL_TEST_VERSION;
  referenceImage: string; // relative path to reference PNG
  threshold?: number; // pixel difference threshold (0-1, default 0.01)
  captureDelay?: number; // ms to wait before capture (default 1000)
}>;

export type VisualComparisonResult = Readonly<{
  passed: boolean;
  diffPixels: number;
  totalPixels: number;
  diffPercentage: number;
  diffImagePath?: string; // path to diff output if failed
}>;

export function validateVisualTestSpec(value: unknown): value is VisualTestSpec {
  if (!value || typeof value !== "object" || Array.isArray(value)) return false;
  const spec = value as Record<string, unknown>;

  if (spec.version !== VISUAL_TEST_VERSION) return false;
  if (typeof spec.referenceImage !== "string" || spec.referenceImage.length < 5 || spec.referenceImage.length > 240
    || !spec.referenceImage.toLowerCase().endsWith(".png") || spec.referenceImage.startsWith("/")
    || spec.referenceImage.startsWith("res://") || /(^|\/)\.{1,2}(\/|$)|\/\//.test(spec.referenceImage)
    || !/^[A-Za-z0-9][A-Za-z0-9._/-]*\.png$/i.test(spec.referenceImage)) return false;
  if (spec.threshold !== undefined && (typeof spec.threshold !== "number" || !Number.isFinite(spec.threshold) || spec.threshold < 0 || spec.threshold > 1)) return false;
  if (spec.captureDelay !== undefined && (!Number.isInteger(spec.captureDelay) || Number(spec.captureDelay) < 0 || Number(spec.captureDelay) > 300_000)) return false;

  return true;
}
