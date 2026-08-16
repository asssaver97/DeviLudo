import { spawn } from "node:child_process";
import { execFile } from "node:child_process";
import { mkdir, rm, stat } from "node:fs/promises";
import { dirname, isAbsolute, join } from "node:path";
import { promisify } from "node:util";

const execute = promisify(execFile);
const FRAME_INTERVAL_MS = 200;
const MAX_VIDEO_BYTES = 768 * 1024 * 1024;

/**
 * Owns every operating-system interaction for one native game process. The
 * class deliberately has no access to Probe state: callers retain the Oracle,
 * while this environment only observes pixels and delivers physical input.
 */
export class GameTestEnvironment {
  constructor({ pid, runId, workspace, driver, gamepadDriver = "", useGamepad = false }) {
    if ((pid !== null && (!Number.isSafeInteger(pid) || pid <= 1)) || !/^[A-Za-z0-9._-]{1,200}$/.test(runId)
      || !isAbsolute(workspace) || typeof driver !== "function") throw new Error("GameTestEnvironment configuration is invalid");
    if (useGamepad && !isAbsolute(gamepadDriver)) throw new Error("INFRASTRUCTURE: fixed system gamepad driver is required");
    this.pid = pid;
    this.runId = runId;
    this.workspace = workspace;
    this.driver = driver;
    this.gamepadDriver = gamepadDriver;
    this.useGamepad = useGamepad;
    this.gamepad = null;
    this.pendingGamepad = new Map();
    this.gamepadSequence = 0;
    this.recording = false;
    this.recordingPromise = null;
    this.recordingFailure = null;
    this.frameCount = 0;
    this.desktopOperation = Promise.resolve();
    this.videoPath = join(workspace, "evidence-videos", `${runId}.mp4`);
    this.framesRoot = join(workspace, "video-frames", runId);
  }

  async prepareInputDevices() {
    if (this.useGamepad && !this.gamepad) await this.#startGamepad();
  }

  attach(pid) {
    if (this.pid !== null || !Number.isSafeInteger(pid) || pid <= 1) throw new Error("GameTestEnvironment PID attachment is invalid");
    this.pid = pid;
  }

  async prepare() {
    if (!Number.isSafeInteger(this.pid) || this.pid <= 1) throw new Error("GameTestEnvironment has no native game PID");
    if (this.useGamepad && !this.gamepad) throw new Error("INFRASTRUCTURE: virtual gamepad must exist before game launch");
    await this.#desktop("wait", ["--pid", String(this.pid), "--width", "1280", "--height", "720"]);
    await mkdir(this.framesRoot, { recursive: true });
    this.recording = true;
    this.recordingPromise = this.#captureLoop();
  }

  async sequence(events, timeoutMs) {
    if (!Array.isArray(events) || events.length < 1 || events.length > 200) throw new Error("Input sequence is invalid");
    const groups = [];
    for (const event of events) {
      const transport = String(event?.type ?? "").startsWith("gamepad_") ? "gamepad" : "desktop";
      const group = groups.at(-1);
      if (group?.transport === transport) group.events.push(event);
      else groups.push({ transport, events: [event] });
    }
    for (const group of groups) {
      if (group.transport === "gamepad") {
        if (!this.useGamepad) throw new Error("INFRASTRUCTURE: gamepad input was requested without a virtual device");
        await this.#gamepadRequest("sequence", { events: group.events }, timeoutMs);
      } else {
        await this.#desktop("sequence", ["--pid", String(this.pid), "--events", JSON.stringify(group.events)], timeoutMs);
      }
    }
  }

  capture(outputPath) {
    return this.#desktopCapture(outputPath);
  }

  async #desktopCapture(outputPath) {
    let lastError;
    for (let attempt = 1; attempt <= 3; attempt += 1) {
      try {
        return await this.#desktop("capture", ["--pid", String(this.pid), "--output", outputPath]);
      } catch (error) {
        lastError = error;
        if (attempt < 3) await new Promise(resolve => setTimeout(resolve, 100));
      }
    }
    throw lastError;
  }

  #desktop(command, arguments_, timeoutMs) {
    const operation = this.desktopOperation.then(() => this.driver(command, arguments_, timeoutMs));
    this.desktopOperation = operation.catch(() => undefined);
    return operation;
  }

  async close() {
    const failures = [];
    try {
      if (this.gamepad) await this.#gamepadRequest("release_all", {}, 5_000);
    } catch (error) { failures.push(error); }
    try { if (this.recordingPromise) await this.#stopRecording(); } catch (error) { failures.push(error); }
    try { await this.#stopGamepad(); } catch (error) { failures.push(error); }
    if (failures.length) throw new AggregateError(failures, "GameTestEnvironment cleanup failed");
    return this.frameCount > 0 ? Object.freeze({ id: this.runId, path: this.videoPath, frameCount: this.frameCount }) : null;
  }

  async #captureLoop() {
    while (this.recording) {
      const started = Date.now();
      const output = join(this.framesRoot, `frame-${String(this.frameCount + 1).padStart(8, "0")}.png`);
      try {
        await this.capture(output);
        this.frameCount += 1;
      } catch (error) {
        if (this.recording) this.recordingFailure = error;
      }
      const waitMs = Math.max(0, FRAME_INTERVAL_MS - (Date.now() - started));
      if (waitMs) await new Promise(resolve => setTimeout(resolve, waitMs));
    }
  }

  async #stopRecording() {
    this.recording = false;
    await this.recordingPromise;
    if (this.recordingFailure && this.frameCount < 2) throw this.recordingFailure;
    if (this.frameCount < 2) throw new Error("INFRASTRUCTURE: complete game video contains fewer than two frames");
    await mkdir(dirname(this.videoPath), { recursive: true });
    await execute("ffmpeg", [
      "-nostdin", "-loglevel", "error", "-framerate", "5", "-i", join(this.framesRoot, "frame-%08d.png"),
      "-c:v", "libx264", "-preset", "veryfast", "-crf", "30", "-maxrate", "1M", "-bufsize", "2M",
      "-pix_fmt", "yuv420p", "-movflags", "+faststart", "-y", this.videoPath,
    ], { timeout: 120_000, maxBuffer: 2 * 1024 * 1024 });
    const probe = await execute("ffprobe", [
      "-v", "error", "-select_streams", "v:0", "-show_entries", "stream=codec_name,width,height", "-of", "json", this.videoPath,
    ], { timeout: 30_000, maxBuffer: 1024 * 1024 });
    const metadata = JSON.parse(probe.stdout);
    const stream = metadata.streams?.[0];
    if (stream?.codec_name !== "h264" || stream.width !== 1280 || stream.height !== 720) {
      throw new Error("INFRASTRUCTURE: gameplay video does not match the H.264 1280x720 contract");
    }
    const { size } = await stat(this.videoPath);
    if (size < 1 || size > MAX_VIDEO_BYTES) throw new Error("INFRASTRUCTURE: gameplay video exceeds the evidence budget");
    await rm(this.framesRoot, { recursive: true, force: true });
  }

  async #startGamepad() {
    const child = spawn(this.gamepadDriver, ["serve", "--session", this.runId], {
      shell: false, stdio: ["pipe", "pipe", "pipe"],
      env: { PATH: process.env.PATH ?? "/usr/local/bin:/usr/bin:/bin", LANG: "C.UTF-8" },
    });
    this.gamepad = child;
    let buffer = "";
    child.stdout.setEncoding("utf8");
    child.stdout.on("data", chunk => {
      buffer += chunk;
      let newline;
      while ((newline = buffer.indexOf("\n")) >= 0) {
        const line = buffer.slice(0, newline); buffer = buffer.slice(newline + 1);
        if (!line.trim()) continue;
        try {
          const message = JSON.parse(line);
          const pending = this.pendingGamepad.get(message.id);
          if (pending) {
            this.pendingGamepad.delete(message.id);
            if (message.ok === true) pending.resolve(message);
            else pending.reject(new Error(message.error ?? "virtual gamepad rejected input"));
          }
        } catch { /* Invalid output is handled by the request timeout. */ }
      }
    });
    child.once("exit", code => {
      for (const pending of this.pendingGamepad.values()) pending.reject(new Error(`virtual gamepad exited ${code ?? 1}`));
      this.pendingGamepad.clear();
    });
    await this.#gamepadRequest("ready", {}, 15_000);
  }

  #gamepadRequest(command, payload, timeoutMs) {
    if (!this.gamepad?.stdin.writable) return Promise.reject(new Error("virtual gamepad is unavailable"));
    const id = `${this.runId}-${++this.gamepadSequence}`;
    return new Promise((resolve, reject) => {
      const timer = setTimeout(() => {
        this.pendingGamepad.delete(id);
        reject(new Error(`virtual gamepad ${command} timed out`));
      }, Math.min(Math.max(1, timeoutMs ?? 30_000), 300_000));
      this.pendingGamepad.set(id, {
        resolve: value => { clearTimeout(timer); resolve(value); },
        reject: error => { clearTimeout(timer); reject(error); },
      });
      this.gamepad.stdin.write(`${JSON.stringify({ id, command, ...payload })}\n`);
    });
  }

  async #stopGamepad() {
    if (!this.gamepad) return;
    try { await this.#gamepadRequest("destroy", {}, 5_000); } catch { /* kill remains mandatory */ }
    this.gamepad.kill("SIGTERM");
    this.gamepad = null;
  }
}

export function gamepadEventCount(events) {
  return events.filter(event => String(event?.type ?? "").startsWith("gamepad_")).length;
}
