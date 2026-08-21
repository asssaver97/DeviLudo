export type GodotFpsSample = Readonly<{ fps: number; mspf: number | null }>;
export type E2eFrameRateRun = Readonly<{
  runId: string;
  samples?: readonly (GodotFpsSample | number)[];
  log?: string | Buffer;
  softwareRenderer?: boolean;
}>;
export type E2eInputResponseSample = Readonly<{
  runId: string;
  stepId: string;
  source?: string;
  latencyMs: number;
}>;
export type E2ePerformanceFailure = Readonly<{
  code: "PERFORMANCE_EVIDENCE_MISSING" | "GAME_STUTTER_DETECTED";
  message: string;
}>;
export type E2ePerformanceSummary = Readonly<{
  schema: "deviludo.e2e-performance.v1";
  passed: boolean;
  thresholds: typeof E2E_PERFORMANCE_THRESHOLDS;
  environment: Readonly<{
    softwareRenderer: boolean;
    softwareRendererRunCount: number;
    frameRateEnforced: boolean;
    inputResponseThresholds: Readonly<{
      maximumP95Ms: number;
      maximumMs: number;
    }>;
  }>;
  frameRate: Readonly<{
    sampleCount: number;
    minimumFps: number | null;
    p10Fps: number | null;
    medianFps: number | null;
    slowSampleCount: number;
    slowSampleRatio: number | null;
    runs: readonly Readonly<{
      runId: string;
      softwareRenderer: boolean;
      warmupSampleDiscarded: boolean;
      sampleCount: number;
      minimumFps: number | null;
      p10Fps: number | null;
      medianFps: number | null;
      samples: readonly number[];
    }>[];
  }>;
  inputResponse: Readonly<{
    sampleCount: number;
    p95Ms: number | null;
    maximumMs: number | null;
    samples: readonly Readonly<{
      runId: string;
      stepId: string;
      source: string;
      latencyMs: number;
    }>[];
  }>;
  failures: readonly E2ePerformanceFailure[];
}>;

export const E2E_PERFORMANCE_THRESHOLDS: Readonly<{
  minimumFrameRateSamples: number;
  minimumInputResponseSamples: number;
  minimumMedianFps: number;
  minimumP10Fps: number;
  criticalMinimumFps: number;
  maximumSlowFrameRateRatio: number;
  slowFrameRateFps: number;
  maximumP95InputResponseMs: number;
  maximumInputResponseMs: number;
  softwareRendererMaximumP95InputResponseMs: number;
  softwareRendererMaximumInputResponseMs: number;
}>;
export function parseGodotFpsSamples(...logs: readonly (string | Buffer | null | undefined)[]): readonly GodotFpsSample[];
export function detectSoftwareRenderer(...logs: readonly (string | Buffer | null | undefined)[]): boolean;
export function summarizeE2ePerformance(input?: Readonly<{
  frameRateRuns?: readonly E2eFrameRateRun[];
  inputResponses?: readonly E2eInputResponseSample[];
}>): E2ePerformanceSummary;
