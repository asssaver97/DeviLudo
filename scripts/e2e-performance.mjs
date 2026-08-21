export const E2E_PERFORMANCE_THRESHOLDS = Object.freeze({
  minimumFrameRateSamples: 5,
  minimumInputResponseSamples: 2,
  minimumMedianFps: 30,
  minimumP10Fps: 20,
  criticalMinimumFps: 5,
  maximumSlowFrameRateRatio: 0.2,
  slowFrameRateFps: 20,
  maximumP95InputResponseMs: 1_500,
  maximumInputResponseMs: 3_000,
  softwareRendererMaximumP95InputResponseMs: 4_000,
  softwareRendererMaximumInputResponseMs: 6_000,
});

const MAX_SAMPLES_PER_RUN = 3_600;
const MAX_INPUT_RESPONSE_SAMPLES = 2_000;
const SOFTWARE_RENDERER_PATTERNS = Object.freeze([
  /Apple Software Renderer/i,
  /Microsoft Basic Render Driver/i,
  /SwiftShader/i,
  /llvmpipe/i,
  /software rasterizer/i,
]);

export function parseGodotFpsSamples(...logs) {
  const samples = [];
  const pattern = /\b(?:Project\s+)?FPS:\s*(\d+(?:\.\d+)?)(?:\s*\(\s*(\d+(?:\.\d+)?)\s*mspf\s*\))?/gi;
  for (const log of logs) {
    pattern.lastIndex = 0;
    const text = Buffer.isBuffer(log) ? log.toString("utf8") : String(log ?? "");
    for (let match = pattern.exec(text); match && samples.length < MAX_SAMPLES_PER_RUN; match = pattern.exec(text)) {
      const fps = Number(match[1]);
      const mspf = match[2] === undefined ? null : Number(match[2]);
      if (!Number.isFinite(fps) || fps < 0 || fps > 10_000
        || (mspf !== null && (!Number.isFinite(mspf) || mspf < 0 || mspf > 60_000))) continue;
      samples.push(Object.freeze({ fps, mspf }));
    }
  }
  return Object.freeze(samples);
}

export function detectSoftwareRenderer(...logs) {
  return logs.some(log => {
    const text = Buffer.isBuffer(log) ? log.toString("utf8") : String(log ?? "");
    return SOFTWARE_RENDERER_PATTERNS.some(pattern => pattern.test(text));
  });
}

export function summarizeE2ePerformance({ frameRateRuns = [], inputResponses = [] } = {}) {
  const normalizedRuns = frameRateRuns
    .filter(run => run && typeof run === "object" && typeof run.runId === "string")
    .slice(0, 256)
    .map(run => {
      const parsed = Array.isArray(run.samples) ? run.samples : parseGodotFpsSamples(run.log ?? "");
      const valid = parsed
        .map(sample => Number(typeof sample === "object" ? sample?.fps : sample))
        .filter(fps => Number.isFinite(fps) && fps >= 0 && fps <= 10_000)
        .slice(0, MAX_SAMPLES_PER_RUN);
      const measured = valid.length >= 2 ? valid.slice(1) : valid;
      return Object.freeze({
        runId: run.runId.slice(0, 240),
        softwareRenderer: run.softwareRenderer === true || detectSoftwareRenderer(run.log ?? ""),
        warmupSampleDiscarded: valid.length >= 2,
        sampleCount: measured.length,
        minimumFps: measured.length ? round(Math.min(...measured)) : null,
        p10Fps: percentile(measured, 0.1),
        medianFps: percentile(measured, 0.5),
        samples: Object.freeze(measured.map(round)),
      });
    });
  const softwareRendererRunCount = normalizedRuns.filter(run => run.softwareRenderer).length;
  const softwareRenderer = normalizedRuns.length > 0 && softwareRendererRunCount === normalizedRuns.length;
  const frameRates = normalizedRuns.flatMap(run => run.samples);
  const normalizedResponses = inputResponses
    .filter(sample => sample && typeof sample === "object"
      && typeof sample.runId === "string" && typeof sample.stepId === "string"
      && Number.isFinite(Number(sample.latencyMs)) && Number(sample.latencyMs) >= 0)
    .slice(0, MAX_INPUT_RESPONSE_SAMPLES)
    .map(sample => Object.freeze({
      runId: sample.runId.slice(0, 240),
      stepId: sample.stepId.slice(0, 240),
      source: typeof sample.source === "string" ? sample.source.slice(0, 40) : "UNKNOWN",
      latencyMs: Math.round(Number(sample.latencyMs)),
    }));
  const responseTimes = normalizedResponses.map(sample => sample.latencyMs);
  const slowFrameRateCount = frameRates.filter(fps => fps < E2E_PERFORMANCE_THRESHOLDS.slowFrameRateFps).length;
  const frameRate = Object.freeze({
    sampleCount: frameRates.length,
    minimumFps: frameRates.length ? round(Math.min(...frameRates)) : null,
    p10Fps: percentile(frameRates, 0.1),
    medianFps: percentile(frameRates, 0.5),
    slowSampleCount: slowFrameRateCount,
    slowSampleRatio: frameRates.length ? round(slowFrameRateCount / frameRates.length, 4) : null,
    runs: Object.freeze(normalizedRuns),
  });
  const inputResponse = Object.freeze({
    sampleCount: responseTimes.length,
    p95Ms: percentile(responseTimes, 0.95, 0),
    maximumMs: responseTimes.length ? Math.max(...responseTimes) : null,
    samples: Object.freeze(normalizedResponses),
  });
  const environment = Object.freeze({
    softwareRenderer,
    softwareRendererRunCount,
    frameRateEnforced: !softwareRenderer,
    inputResponseThresholds: Object.freeze({
      maximumP95Ms: softwareRenderer
        ? E2E_PERFORMANCE_THRESHOLDS.softwareRendererMaximumP95InputResponseMs
        : E2E_PERFORMANCE_THRESHOLDS.maximumP95InputResponseMs,
      maximumMs: softwareRenderer
        ? E2E_PERFORMANCE_THRESHOLDS.softwareRendererMaximumInputResponseMs
        : E2E_PERFORMANCE_THRESHOLDS.maximumInputResponseMs,
    }),
  });
  const failures = [];
  if (frameRate.sampleCount < E2E_PERFORMANCE_THRESHOLDS.minimumFrameRateSamples
    || inputResponse.sampleCount < E2E_PERFORMANCE_THRESHOLDS.minimumInputResponseSamples) {
    failures.push(Object.freeze({
      code: "PERFORMANCE_EVIDENCE_MISSING",
      message: `性能证据不足：帧率 ${frameRate.sampleCount}/${E2E_PERFORMANCE_THRESHOLDS.minimumFrameRateSamples}，输入响应 ${inputResponse.sampleCount}/${E2E_PERFORMANCE_THRESHOLDS.minimumInputResponseSamples}`,
    }));
  }
  // Tart, SwiftShader and other software rasterizers have an execution-environment
  // frame-rate ceiling that product code cannot repair. Keep their real FPS in the
  // report, but gate them on bounded native-input response instead. Hardware-backed
  // runs retain the strict absolute FPS thresholds.
  const frameRateFailed = environment.frameRateEnforced
    && frameRate.sampleCount >= E2E_PERFORMANCE_THRESHOLDS.minimumFrameRateSamples
    && (frameRate.medianFps < E2E_PERFORMANCE_THRESHOLDS.minimumMedianFps
      || frameRate.p10Fps < E2E_PERFORMANCE_THRESHOLDS.minimumP10Fps
      || frameRate.minimumFps < E2E_PERFORMANCE_THRESHOLDS.criticalMinimumFps
      || frameRate.slowSampleRatio > E2E_PERFORMANCE_THRESHOLDS.maximumSlowFrameRateRatio);
  const inputResponseFailed = inputResponse.sampleCount >= E2E_PERFORMANCE_THRESHOLDS.minimumInputResponseSamples
    && (inputResponse.p95Ms > environment.inputResponseThresholds.maximumP95Ms
      || inputResponse.maximumMs > environment.inputResponseThresholds.maximumMs);
  if (frameRateFailed || inputResponseFailed) {
    failures.push(Object.freeze({
      code: "GAME_STUTTER_DETECTED",
      message: `检测到游戏卡顿：最低/P10/中位 FPS ${display(frameRate.minimumFps)}/${display(frameRate.p10Fps)}/${display(frameRate.medianFps)}，慢帧率样本 ${(Number(frameRate.slowSampleRatio ?? 0) * 100).toFixed(1)}%，输入响应 P95/最大 ${display(inputResponse.p95Ms)}/${display(inputResponse.maximumMs)}ms${softwareRenderer ? `（软件渲染环境，帧率仅记录，输入门槛 ${environment.inputResponseThresholds.maximumP95Ms}/${environment.inputResponseThresholds.maximumMs}ms）` : ""}`,
    }));
  }
  return Object.freeze({
    schema: "deviludo.e2e-performance.v1",
    passed: failures.length === 0,
    thresholds: E2E_PERFORMANCE_THRESHOLDS,
    environment,
    frameRate,
    inputResponse,
    failures: Object.freeze(failures),
  });
}

function percentile(values, ratio, digits = 2) {
  if (!values.length) return null;
  const sorted = [...values].sort((left, right) => left - right);
  const index = Math.max(0, Math.ceil(sorted.length * ratio) - 1);
  return round(sorted[index], digits);
}

function round(value, digits = 2) {
  const factor = 10 ** digits;
  return Math.round(value * factor) / factor;
}

function display(value) { return value === null ? "-" : value; }
