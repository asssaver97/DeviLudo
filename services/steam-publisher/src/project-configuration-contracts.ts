import type { SteamBuildSession } from "./contracts";
import type { SteamEnrollmentPrincipal } from "./enrollment-contracts";

export type SteamDepotPlatform = "windows" | "linux" | "macos";
export type SteamPlatformDepots = Readonly<Partial<Record<SteamDepotPlatform, string>>>;

export interface SteamProjectConfigurationIntent {
  readonly id: string;
  readonly tenantId: string;
  readonly projectId: string;
  readonly userId: string;
  readonly sessionBindingDigest: string;
  readonly idempotencyKey: string;
  readonly requestDigest: string;
  readonly state: "CONFIGURING" | "COMPLETED" | "EXPIRED";
  readonly buildSession: SteamBuildSession;
  readonly releaseConfigurationId: string | null;
  readonly createdAt: string;
  readonly expiresAt: string;
  readonly completedAt: string | null;
}

export interface SteamProjectReleaseConfiguration {
  readonly id: string;
  readonly projectId: string;
  readonly revision: number;
  readonly steamAppId: string;
  readonly betaBranch: string;
  readonly platformDepots: SteamPlatformDepots;
  readonly buildSessionId: string;
  readonly buildSessionState: SteamBuildSession["state"];
  readonly buildSessionExpiresAt: string;
  readonly accountName: string;
  readonly createdAt: string;
}

export interface SteamProjectConfigurationStore {
  probe(): Promise<void>;
  findStatus(input: {
    readonly tenantId: string;
    readonly projectId: string;
    readonly userId: string;
    readonly sessionBindingDigest: string;
    readonly at: string;
  }): Promise<Readonly<{
    activeConfiguration: SteamProjectReleaseConfiguration | null;
    pendingIntent: SteamProjectConfigurationIntent | null;
  }>>;
  createIntent(input: Omit<SteamProjectConfigurationIntent,
    "state" | "buildSession" | "releaseConfigurationId" | "completedAt">): Promise<SteamProjectConfigurationIntent>;
  findIntent(input: {
    readonly tenantId: string;
    readonly projectId: string;
    readonly intentId: string;
    readonly userId: string;
    readonly sessionBindingDigest: string;
  }): Promise<SteamProjectConfigurationIntent>;
  complete(input: {
    readonly tenantId: string;
    readonly projectId: string;
    readonly intentId: string;
    readonly userId: string;
    readonly sessionBindingDigest: string;
    readonly steamAppId: string;
    readonly betaBranch: string;
    readonly platformDepots: SteamPlatformDepots;
    readonly branchPasswordSecretRef: string;
    readonly depotConfigurationId: string;
    readonly depotConfigurationDigest: string;
    readonly releaseConfigurationId: string;
    readonly releaseConfigurationDigest: string;
    readonly createdBy: string;
    readonly at: string;
  }): Promise<SteamProjectReleaseConfiguration>;
}

export interface SteamProjectConfigurationStatus {
  readonly state: "UNCONFIGURED" | "CONFIGURING" | "READY" | "STALE_SESSION";
  readonly projectId: string;
  readonly configurationUrl: string | null;
  readonly intentExpiresAt: string | null;
  readonly revision: number | null;
  readonly steamAppId: string | null;
  readonly betaBranch: string | null;
  readonly platformDepots: SteamPlatformDepots;
  readonly accountName: string | null;
  readonly sessionExpiresAt: string | null;
}

export interface SteamProjectConfigurationView {
  readonly intentId: string;
  readonly projectId: string;
  readonly state: "CONFIGURING" | "READY";
  readonly configurationUrl: string | null;
  readonly expiresAt: string;
  readonly revision: number | null;
}

export interface SteamProjectConfigurationBrokerPort {
  status(principal: SteamEnrollmentPrincipal, projectId: string): Promise<SteamProjectConfigurationStatus>;
  begin(principal: SteamEnrollmentPrincipal, projectId: string, idempotencyKey: string): Promise<SteamProjectConfigurationView>;
}

export interface SteamProjectConfigurationInteractivePort {
  completeConfiguration(input: {
    readonly principal: SteamEnrollmentPrincipal;
    readonly projectId: string;
    readonly intentId: string;
    readonly steamAppId: string;
    readonly betaBranch: string;
    readonly platformDepots: SteamPlatformDepots;
    readonly branchPassword: Uint8Array;
  }): Promise<SteamProjectConfigurationView>;
}
