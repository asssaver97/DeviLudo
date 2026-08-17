import { randomUUID } from "node:crypto";
import { mkdir, readFile, rename, writeFile } from "node:fs/promises";
import { arch, platform } from "node:os";
import { join } from "node:path";
import type { TelemetrySettings } from "@/lib/product/contracts";
import type { CoreConfig } from "./config";

const REPORT_INTERVAL_MS = 20 * 60 * 60 * 1_000;
const REQUEST_TIMEOUT_MS = 5_000;
const COLLECTED_FIELDS = Object.freeze([
  "installationId",
  "activeDay",
  "releaseVersion",
  "operatingSystem",
  "architecture",
] as const);

type TelemetryState = Readonly<{
  installationId: string;
  enabled: boolean;
  lastReportedAt: string | null;
}>;

/**
 * Privacy-minimal active-installation telemetry for self-hosted deployments.
 * A random installation identifier is created locally; no project, source,
 * prompt, path, credential, artifact, username, or hardware identifier enters
 * the payload. One successful heartbeat per active day is sufficient to derive
 * distinct daily/monthly active installation counts at the configured endpoint.
 */
export class UsageTelemetry {
  private state: TelemetryState | null = null;
  private inFlight: Promise<void> | null = null;
  private readonly stateFile: string;

  constructor(private readonly config: CoreConfig) {
    this.stateFile = join(config.projectsRoot, ".deviludo-telemetry.json");
  }

  async settings(): Promise<TelemetrySettings> {
    const state = await this.readState();
    return Object.freeze({
      enabled: state.enabled,
      endpointConfigured: this.config.telemetryEndpoint !== null,
      installationIdMask: `${state.installationId.slice(0, 8)}…`,
      lastReportedAt: state.lastReportedAt,
      collectedFields: COLLECTED_FIELDS,
    });
  }

  async setEnabled(enabled: boolean): Promise<TelemetrySettings> {
    // Do not let a heartbeat that started just before an opt-out restore the
    // previous enabled state when it records its completion timestamp.
    if (this.inFlight) await this.inFlight;
    const current = await this.readState();
    await this.saveState(Object.freeze({ ...current, enabled }));
    return this.settings();
  }

  recordActivity(): void {
    if (this.inFlight) return;
    this.inFlight = this.reportIfDue().finally(() => { this.inFlight = null; });
  }

  private async reportIfDue(): Promise<void> {
    const endpoint = this.config.telemetryEndpoint;
    if (!endpoint) return;
    const state = await this.readState();
    if (!state.enabled || !reportDue(state.lastReportedAt)) return;
    const controller = new AbortController();
    const timeout = setTimeout(() => controller.abort(), REQUEST_TIMEOUT_MS);
    try {
      const response = await fetch(endpoint, {
        method: "POST",
        headers: {
          "content-type": "application/json",
          "user-agent": `DeviLudo/${this.config.releaseVersion}`,
        },
        body: JSON.stringify({
          event: "ACTIVE_INSTALLATION",
          installationId: state.installationId,
          activeDay: new Date().toISOString().slice(0, 10),
          releaseVersion: this.config.releaseVersion,
          operatingSystem: platform(),
          architecture: arch(),
        }),
        signal: controller.signal,
      });
      if (!response.ok) return;
      await this.saveState(Object.freeze({ ...state, lastReportedAt: new Date().toISOString() }));
    } catch {
      // Telemetry is best effort and must never affect the development chain.
    } finally {
      clearTimeout(timeout);
    }
  }

  private async readState(): Promise<TelemetryState> {
    if (this.state) return this.state;
    try {
      const parsed = JSON.parse(await readFile(this.stateFile, "utf8")) as Record<string, unknown>;
      if (typeof parsed.installationId !== "string" || !UUID.test(parsed.installationId)
        || typeof parsed.enabled !== "boolean"
        || (parsed.lastReportedAt !== null && typeof parsed.lastReportedAt !== "string")) {
        throw new Error("invalid telemetry state");
      }
      this.state = Object.freeze({
        installationId: parsed.installationId,
        enabled: parsed.enabled,
        lastReportedAt: parsed.lastReportedAt as string | null,
      });
      return this.state;
    } catch {
      const created = Object.freeze({
        installationId: randomUUID(),
        enabled: this.config.telemetryEnabled,
        lastReportedAt: null,
      });
      await this.saveState(created);
      return created;
    }
  }

  private async saveState(state: TelemetryState): Promise<void> {
    await mkdir(this.config.projectsRoot, { recursive: true, mode: 0o700 });
    const temporary = `${this.stateFile}.${process.pid}.tmp`;
    await writeFile(temporary, `${JSON.stringify(state)}\n`, { encoding: "utf8", mode: 0o600 });
    await rename(temporary, this.stateFile);
    this.state = state;
  }
}

function reportDue(lastReportedAt: string | null): boolean {
  if (!lastReportedAt) return true;
  const timestamp = Date.parse(lastReportedAt);
  return !Number.isFinite(timestamp) || Date.now() - timestamp >= REPORT_INTERVAL_MS;
}

const UUID = /^[0-9a-f]{8}-[0-9a-f]{4}-[1-8][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/i;
