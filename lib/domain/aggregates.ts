import { DomainError, invariant } from "./errors";
import {
  AGENT_RUN_TRANSITIONS,
  AGENT_VERSION_TRANSITIONS,
  E2E_ATTEMPT_TRANSITIONS,
  GAME_SPEC_TRANSITIONS,
  INSTALLATION_TRANSITIONS,
  ITERATION_TRANSITIONS,
  PROFILE_TRANSITIONS,
  STEAM_RELEASE_TRANSITIONS,
  transitionState,
  type AgentRunState,
  type AgentVersionState,
  type E2EAttemptState,
  type GameSpecState,
  type InstallationState,
  type IterationState,
  type ProfileState,
  type SteamReleaseState,
} from "./state-machine";
import {
  deepFreeze,
  uniqueSorted,
  type AgentKind,
  type DeepReadonly,
  type EntityId,
  type ISODateTime,
  type Sha256,
  type TargetPlatform,
} from "./types";

export interface AcceptanceCriterion {
  readonly id: string;
  readonly description: string;
  readonly required: boolean;
}

export interface FrozenTestPlan {
  readonly version: string;
  readonly digest: Sha256;
  readonly scenarios: readonly string[];
  readonly minimumFps: number;
  readonly maxCrashCount: 0;
}

/** Content is immutable; approval/supersession produces a new event-sourced snapshot. */
export interface GameSpecRevision {
  readonly id: EntityId;
  readonly tenantId: EntityId;
  readonly projectId: EntityId;
  readonly revision: number;
  readonly previousRevisionId: EntityId | null;
  readonly state: GameSpecState;
  readonly title: string;
  readonly elevatorPitch: string;
  readonly genre: string;
  readonly godotVersion: string;
  readonly targetPlatforms: readonly TargetPlatform[];
  readonly features: readonly string[];
  readonly acceptanceCriteria: readonly AcceptanceCriterion[];
  readonly testPlan: FrozenTestPlan;
  readonly contentDigest: Sha256;
  readonly createdBy: EntityId;
  readonly createdAt: ISODateTime;
  readonly approvedBy: EntityId | null;
  readonly approvedAt: ISODateTime | null;
}

export function createGameSpecRevision(
  input: Omit<GameSpecRevision, "state" | "approvedBy" | "approvedAt">,
): DeepReadonly<GameSpecRevision> {
  invariant(input.revision > 0, "Specification revision must be positive");
  invariant(input.targetPlatforms.length > 0, "At least one target platform is required");
  invariant(input.acceptanceCriteria.length > 0, "Acceptance criteria cannot be empty");
  return deepFreeze({
    ...input,
    state: "DRAFT" as const,
    targetPlatforms: uniqueSorted(input.targetPlatforms),
    approvedBy: null,
    approvedAt: null,
  });
}

export function approveGameSpec(
  spec: GameSpecRevision,
  actorId: EntityId,
  at: ISODateTime,
): DeepReadonly<GameSpecRevision> {
  const transitioned = transitionState(spec, "APPROVED", GAME_SPEC_TRANSITIONS);
  return deepFreeze({ ...transitioned, approvedBy: actorId, approvedAt: at });
}

export interface GameIteration {
  readonly id: EntityId;
  readonly tenantId: EntityId;
  readonly projectId: EntityId;
  readonly number: number;
  readonly previousIterationId: EntityId | null;
  readonly specRevisionId: EntityId;
  readonly specDigest: Sha256;
  readonly candidateBranch: string;
  readonly candidateCommitSha: string;
  readonly draftPullRequestUrl: string;
  readonly feedback: string | null;
  readonly state: IterationState;
  readonly createdAt: ISODateTime;
}

export function transitionIteration(iteration: GameIteration, next: IterationState): GameIteration {
  return transitionState(iteration, next, ITERATION_TRANSITIONS);
}

export interface AgentRegistry {
  readonly id: EntityId;
  readonly kind: AgentKind;
  readonly vendor: "Anthropic" | "OpenAI";
  readonly displayName: string;
  readonly officialSource: string;
  readonly adapterId: string;
  readonly configurationSchemaVersion: string;
  readonly capabilities: readonly ("plan" | "code" | "review" | "repair")[];
  readonly supportedWorkerPlatforms: readonly ("linux/amd64" | "linux/arm64")[];
}

export interface AgentVersion {
  readonly id: EntityId;
  readonly registryId: EntityId;
  readonly exactVersion: string;
  readonly sourceUrl: string;
  readonly packageIntegrity: string;
  readonly sha256: Sha256;
  readonly signatureVerified: boolean;
  readonly sbomDigest: Sha256 | null;
  readonly vulnerabilityReportDigest: Sha256 | null;
  readonly adapterCompatibility: Readonly<{ min: string; maxExclusive: string }>;
  readonly releaseNotesUrl: string;
  readonly state: AgentVersionState;
  readonly discoveredAt: ISODateTime;
}

export function transitionAgentVersion(version: AgentVersion, next: AgentVersionState): AgentVersion {
  if (next === "APPROVED") {
    invariant(!/(^|[-_.])(latest|stable|default)(?:$|[-_.])/i.test(version.exactVersion), "A floating Agent version cannot be approved");
    invariant(version.signatureVerified, "Unsigned Agent versions cannot be approved");
    invariant(Boolean(version.sbomDigest), "An SBOM is required before approval");
    invariant(Boolean(version.vulnerabilityReportDigest), "A vulnerability scan is required before approval");
  }
  return transitionState(version, next, AGENT_VERSION_TRANSITIONS);
}

export interface WorkerImage {
  readonly id: EntityId;
  readonly agentVersionId: EntityId;
  readonly exactAgentVersion: string;
  readonly adapterVersion: string;
  readonly baseImageDigest: string;
  readonly imageDigest: string;
  readonly containsSingleAgent: true;
  readonly readOnlyRootFilesystem: true;
  readonly cliSelfUpdateDisabled: true;
  readonly builtAt: ISODateTime;
}

export interface AgentInstallation {
  readonly id: EntityId;
  readonly registryId: EntityId;
  readonly agentVersionId: EntityId;
  readonly workerImageId: EntityId;
  readonly imageDigest: string;
  readonly workerPool: string;
  readonly rolloutPercent: 0 | 5 | 25 | 100;
  readonly rollbackInstallationId: EntityId | null;
  readonly health: "UNKNOWN" | "HEALTHY" | "UNHEALTHY";
  readonly state: InstallationState;
  readonly createdAt: ISODateTime;
}

export function transitionInstallation(
  installation: AgentInstallation,
  next: InstallationState,
  rolloutPercent = installation.rolloutPercent,
): AgentInstallation {
  const validRollouts: readonly number[] = [0, 5, 25, 100];
  invariant(validRollouts.includes(rolloutPercent), "Rollout must be 0, 5, 25, or 100");
  if (next === "CANARY") invariant(rolloutPercent === 5, "A canary must begin at 5%");
  if (next === "ACTIVE") invariant(rolloutPercent === 100, "Only a 100% rollout can become active");
  if (next === "ACTIVE") invariant(installation.health === "HEALTHY", "Only healthy installations can become active");
  const transitioned = transitionState(installation, next, INSTALLATION_TRANSITIONS);
  return Object.freeze({ ...transitioned, rolloutPercent: rolloutPercent as 0 | 5 | 25 | 100 });
}

export function advanceInstallationRollout(installation: AgentInstallation): AgentInstallation {
  invariant(installation.state === "CANARY", "Only a canary rollout can advance");
  const next = installation.rolloutPercent === 5 ? 25 : installation.rolloutPercent === 25 ? 100 : null;
  invariant(next !== null, "Canary rollout is already at its final checkpoint");
  invariant(installation.health === "HEALTHY", "An unhealthy canary cannot advance");
  return Object.freeze({ ...installation, rolloutPercent: next });
}

export function quarantineInstallation(installation: AgentInstallation): Readonly<{
  quarantined: AgentInstallation;
  rollbackInstallationId: EntityId;
}> {
  invariant(Boolean(installation.rollbackInstallationId), "A production candidate must have a rollback target");
  return Object.freeze({
    quarantined: transitionState(installation, "QUARANTINED", INSTALLATION_TRANSITIONS),
    rollbackInstallationId: installation.rollbackInstallationId as EntityId,
  });
}

export type ProviderProtocol = "anthropic-messages" | "openai-responses";

export interface ModelRoleMap {
  readonly primaryModel: string;
  readonly planningModel: string;
  readonly smallFastModel: string;
  readonly subagentModel: string;
}

export interface ProviderRevision {
  readonly id: EntityId;
  readonly providerId: EntityId;
  readonly revision: number;
  readonly agentKind: AgentKind;
  readonly protocol: ProviderProtocol;
  readonly baseUrl: string;
  readonly models: ModelRoleMap;
  readonly credentialBindingId: EntityId;
  readonly credentialVersionId: EntityId;
  readonly dataRegion: string;
  readonly retentionPolicy: string;
  readonly trainingPolicy: string;
  readonly securityApprovalId: EntityId | null;
  readonly probeEvidenceDigest: Sha256;
  readonly createdAt: ISODateTime;
}

export interface AgentBudget {
  readonly maxUsd: number;
  readonly maxTurns: number;
  readonly timeoutSeconds: number;
}

export interface AgentPermissions {
  readonly workspaceWrite: true;
  readonly networkThroughGatewayOnly: true;
  readonly allowHooks: false;
  readonly allowProjectPlugins: false;
  readonly allowDangerousBypass: false;
}

export interface AgentProfileRevision {
  readonly id: EntityId;
  readonly profileId: EntityId;
  readonly revision: number;
  readonly scope: "PLATFORM" | "TENANT" | "PROJECT";
  readonly scopeId: EntityId;
  readonly agentKind: AgentKind;
  readonly installationId: EntityId;
  readonly providerRevisionId: EntityId;
  readonly modelRoles: ModelRoleMap;
  readonly credentialBindingId: EntityId;
  readonly credentialVersionId: EntityId;
  readonly permissions: AgentPermissions;
  readonly budget: AgentBudget;
  readonly fallbackProfileRevisionId: EntityId | null;
  readonly state: ProfileState;
  readonly createdAt: ISODateTime;
}

export function transitionProfile(profile: AgentProfileRevision, next: ProfileState): AgentProfileRevision {
  return transitionState(profile, next, PROFILE_TRANSITIONS);
}

/** The complete immutable resolution captured at queue time. */
export interface AgentRunConfigurationLock {
  readonly profileRevisionId: EntityId;
  readonly installationId: EntityId;
  readonly imageDigest: string;
  readonly exactAgentVersion: string;
  readonly adapterVersion: string;
  readonly providerRevisionId: EntityId;
  readonly providerProtocol: ProviderProtocol;
  readonly modelRoles: ModelRoleMap;
  readonly credentialBindingId: EntityId;
  readonly credentialVersionId: EntityId;
  readonly permissions: AgentPermissions;
  readonly budget: AgentBudget;
  readonly specRevisionId: EntityId;
  readonly specDigest: Sha256;
  readonly testPlanDigest: Sha256;
  readonly commitSha: string;
  readonly sourceDigest: Sha256;
  readonly targetMatrix: readonly TargetPlatform[];
  readonly resolvedAt: ISODateTime;
  readonly resolutionDigest: Sha256;
}

export interface AgentRun {
  readonly id: EntityId;
  readonly tenantId: EntityId;
  readonly projectId: EntityId;
  readonly iterationId: EntityId;
  readonly idempotencyKey: string;
  readonly configuration: DeepReadonly<AgentRunConfigurationLock>;
  readonly state: AgentRunState;
  readonly createdAt: ISODateTime;
}

export function createAgentRun(input: Omit<AgentRun, "state" | "configuration"> & {
  readonly configuration: AgentRunConfigurationLock;
}): DeepReadonly<AgentRun> {
  if (!input.configuration.targetMatrix.length) {
    throw new DomainError("INVALID_CONFIGURATION", "A run must lock at least one target platform");
  }
  return deepFreeze({ ...input, state: "QUEUED" as const, configuration: input.configuration });
}

export function transitionAgentRun(run: AgentRun, next: AgentRunState): AgentRun {
  return transitionState(run, next, AGENT_RUN_TRANSITIONS);
}

export interface E2EAttempt {
  readonly id: EntityId;
  readonly runId: EntityId;
  readonly iterationId: EntityId;
  readonly attemptNumber: number;
  readonly fencingToken: number;
  readonly commitSha: string;
  readonly sourceDigest: Sha256;
  readonly specRevisionId: EntityId;
  readonly specDigest: Sha256;
  readonly testPlanDigest: Sha256;
  readonly targetMatrix: readonly TargetPlatform[];
  readonly leaseExpiresAt: ISODateTime | null;
  readonly state: E2EAttemptState;
  readonly createdAt: ISODateTime;
}

export function transitionE2EAttempt(attempt: E2EAttempt, next: E2EAttemptState): E2EAttempt {
  return transitionState(attempt, next, E2E_ATTEMPT_TRANSITIONS);
}

export interface SteamRelease {
  readonly id: EntityId;
  readonly tenantId: EntityId;
  readonly projectId: EntityId;
  readonly mainCommitSha: string;
  readonly sourceDigest: Sha256;
  readonly evidenceBundleDigest: Sha256;
  readonly targetMatrix: readonly TargetPlatform[];
  readonly steamAppId: string;
  readonly steamSessionSecretRef: string;
  readonly betaBranch: string;
  readonly mfaApprovalId: EntityId;
  readonly state: SteamReleaseState;
  readonly externalGate: "NONE" | "VALVE_REVIEW" | "FIRST_RELEASE" | "DEFAULT_BRANCH_CONFIRMATION";
  readonly createdAt: ISODateTime;
}

export function transitionSteamRelease(
  release: SteamRelease,
  next: SteamReleaseState,
  externalGate = release.externalGate,
): SteamRelease {
  if (next === "RELEASED") {
    invariant(externalGate === "NONE", "Steam release cannot complete while an external gate is pending");
  }
  const transitioned = transitionState(release, next, STEAM_RELEASE_TRANSITIONS);
  return Object.freeze({ ...transitioned, externalGate });
}
