import type { LocalDeliverySnapshot } from "@/lib/local-delivery/model";
import { commandLocalDelivery, readLocalDelivery } from "@/lib/local-delivery/store";
import { runAndSaveLocalMainValidation } from "@/lib/local-delivery/runtime-main-validation";
import { runAndSaveLocalValidation } from "@/lib/local-delivery/runtime-validation";
import { runAndSaveLocalSteamReinstall } from "@/lib/local-delivery/runtime-steam-reinstall";
import {
  runAndSaveLocalAgentExecution,
  type LocalAgentExecutionAttempt,
} from "@/lib/local-delivery/runtime-agent-execution";

export type LocalAutomationStopReason =
  | "USER_ACCEPTANCE_REQUIRED"
  | "MFA_REQUIRED"
  | "EXTERNAL_APPROVAL_REQUIRED"
  | "WAITING_PROVIDER"
  | "SPEC_APPROVAL_REQUIRED"
  | "LOCAL_EXPORT_TEMPLATES_REQUIRED"
  | "LOCAL_VALIDATION_FAILED"
  | "LOCAL_MAIN_VALIDATION_FAILED"
  | "LOCAL_STEAM_REINSTALL_FAILED"
  | "LOCAL_AGENT_EXECUTOR_REQUIRED"
  | "PHYSICAL_RUNNERS_REQUIRED"
  | "TERMINAL";

export type LocalAutomationResult = {
  readonly snapshot: LocalDeliverySnapshot;
  readonly stopReason: LocalAutomationStopReason;
  readonly automaticTransitions: number;
  readonly validationExecuted: boolean;
  readonly mainValidationExecuted: boolean;
  readonly steamReinstallExecuted: boolean;
  readonly agentExecutionAttempted: boolean;
  readonly developmentMode: "REAL_AGENT" | "FIXTURE" | null;
  readonly fixtureFallbackCode: string | null;
  readonly requiredPhysicalPlatforms: readonly ("linux" | "windows")[];
};

type ValidationRunner = typeof runAndSaveLocalValidation;
type MainValidationRunner = typeof runAndSaveLocalMainValidation;
type SteamReinstallRunner = typeof runAndSaveLocalSteamReinstall;
type AgentRunner = (
  projectId: string,
  delivery: LocalDeliverySnapshot,
  commandKey: string,
) => Promise<LocalAgentExecutionAttempt>;

/**
 * Prefers the locked real Agent when a runner is supplied. Explicit localhost
 * installation/attestation/enablement blockers select the visible Fixture
 * Executor; Provider loss never switches authority. Human gates remain hard.
 */
export async function runLocalDeliveryUntilHumanGate(
  projectId: string,
  operationKey: string,
  validationRunner: ValidationRunner = runAndSaveLocalValidation,
  mainValidationRunner: MainValidationRunner = runAndSaveLocalMainValidation,
  steamReinstallRunner: SteamReinstallRunner = runAndSaveLocalSteamReinstall,
  agentRunner: AgentRunner | null = null,
): Promise<LocalAutomationResult> {
  let snapshot = await readLocalDelivery(projectId);
  let automaticTransitions = 0;
  let validationExecuted = false;
  let mainValidationExecuted = false;
  let steamReinstallExecuted = false;
  let agentExecutionAttempted = false;
  let developmentMode: LocalAutomationResult["developmentMode"] = null;
  let fixtureFallbackCode: string | null = null;
  let fixtureFallbackSelected = agentRunner === null;
  const finish = (
    stopReason: LocalAutomationStopReason,
    requiredPhysicalPlatforms: readonly ("linux" | "windows")[] = [],
  ) => result(
    snapshot,
    stopReason,
    automaticTransitions,
    validationExecuted,
    mainValidationExecuted,
    requiredPhysicalPlatforms,
    steamReinstallExecuted,
    agentExecutionAttempted,
    developmentMode,
    fixtureFallbackCode,
  );

  for (let attempt = 0; attempt < 12; attempt += 1) {
    switch (snapshot.stage) {
      case "AGENT_QUEUED":
      case "AGENT_RUNNING": {
        if (agentRunner && !fixtureFallbackSelected && !snapshot.agentExecution?.valid) {
          agentExecutionAttempted = true;
          const attempt = await agentRunner(
            projectId,
            snapshot,
            `${operationKey}:agent:${snapshot.runId}`,
          );
          if (attempt.kind === "COMPLETED") {
            if (attempt.snapshot.projectId !== projectId
              || attempt.snapshot.runId !== snapshot.runId
              || attempt.snapshot.specRevisionId !== snapshot.specRevisionId
              || attempt.snapshot.stage !== "CANDIDATE_READY"
              || attempt.snapshot.agentExecution?.valid !== true
              || attempt.snapshot.agentExecution.candidate.commitSha !== attempt.snapshot.candidateSha) {
              throw new Error("本机 Agent 执行结果没有产生绑定当前运行的权威候选");
            }
            snapshot = attempt.snapshot;
            developmentMode = "REAL_AGENT";
            break;
          }
          if (attempt.code === "WAITING_PROVIDER") {
            const transition = await commandLocalDelivery(
              projectId,
              "provider-fail",
              `${operationKey}:provider-fail:${snapshot.revision}`,
            );
            snapshot = transition.snapshot;
            automaticTransitions += transition.replayed ? 0 : 1;
            fixtureFallbackCode = attempt.code;
            return finish("WAITING_PROVIDER");
          }
          if (attempt.code === "LOCAL_AGENT_EXECUTOR_NOT_CONFIGURED") {
            fixtureFallbackCode = attempt.code;
            return finish("LOCAL_AGENT_EXECUTOR_REQUIRED");
          }
          if (attempt.code === "LOCAL_AGENT_RUN_CANCELLED") {
            snapshot = await readLocalDelivery(projectId);
            if (snapshot.stage !== "CANCELLED") {
              throw new Error("本机 Agent 已停止，但交付取消状态尚未持久化");
            }
            fixtureFallbackCode = attempt.code;
            return finish("TERMINAL");
          }
          fixtureFallbackSelected = true;
          fixtureFallbackCode = attempt.code;
          developmentMode = "FIXTURE";
        }
        const transition = await commandLocalDelivery(
          projectId,
          "advance",
          `${operationKey}:advance:${snapshot.revision}:${snapshot.stage}`,
        );
        snapshot = transition.snapshot;
        automaticTransitions += transition.replayed ? 0 : 1;
        break;
      }
      case "E2E_RUNNING":
      case "STEAM_BETA_UPLOADING": {
        const transition = await commandLocalDelivery(
          projectId,
          "advance",
          `${operationKey}:advance:${snapshot.revision}:${snapshot.stage}`,
        );
        snapshot = transition.snapshot;
        automaticTransitions += transition.replayed ? 0 : 1;
        break;
      }
      case "STEAM_REINSTALL_E2E": {
        const reinstall = await steamReinstallRunner(
          projectId,
          snapshot,
          `${operationKey}:steam-reinstall:${snapshot.revision}`,
        );
        snapshot = reinstall.snapshot;
        steamReinstallExecuted = true;
        if (snapshot.repairHandoff?.reason === "STEAM_INSTALL_FAILURE") {
          return finish("LOCAL_STEAM_REINSTALL_FAILED");
        }
        if (snapshot.stage !== "EXTERNAL_APPROVAL_REQUIRED") {
          throw new Error("本地 Beta 回装没有产生可用于自动编排的终态证据");
        }
        break;
      }
      case "CANDIDATE_READY": {
        const evidencePassed = snapshot.localValidation?.valid === true
          && snapshot.localValidation.status === "TESTS_PASSED"
          && snapshot.localValidation.releaseGate === "LOCAL_VALIDATION_PASSED";
        if (!evidencePassed) {
          const validation = await validationRunner(
            projectId,
            snapshot,
            `${operationKey}:validation:${snapshot.revision}`,
          );
          snapshot = validation.snapshot;
          validationExecuted = true;
          if (snapshot.localValidation?.releaseGate === "WAITING_EXPORT_TEMPLATES") {
            return finish("LOCAL_EXPORT_TEMPLATES_REQUIRED");
          }
          if (snapshot.localValidation?.status === "FAILED") {
            return finish("LOCAL_VALIDATION_FAILED");
          }
          if (snapshot.localValidation?.releaseGate !== "LOCAL_VALIDATION_PASSED") {
            throw new Error("本机验证没有产生可用于自动编排的终态证据");
          }
          break;
        }
        const requiredPhysicalPlatforms = snapshot.targetMatrix.filter(
          (platform): platform is "linux" | "windows" => platform !== snapshot.localValidation?.platform,
        );
        if (requiredPhysicalPlatforms.length > 0) {
          return finish("PHYSICAL_RUNNERS_REQUIRED", requiredPhysicalPlatforms);
        }
        const transition = await commandLocalDelivery(
          projectId,
          "advance",
          `${operationKey}:advance:${snapshot.revision}:${snapshot.stage}`,
        );
        snapshot = transition.snapshot;
        automaticTransitions += transition.replayed ? 0 : 1;
        break;
      }
      case "MERGING":
      case "MAIN_GATE_RUNNING": {
        const alreadyPassed = snapshot.mainValidation?.valid === true
          && snapshot.mainValidation.status === "TESTS_PASSED"
          && snapshot.mainValidation.releaseGate === "MAIN_VALIDATION_PASSED";
        if (alreadyPassed) {
          throw new Error("main SHA 门禁证据已通过但交付阶段未推进");
        }
        const validation = await mainValidationRunner(
          projectId,
          snapshot,
          `${operationKey}:main-validation:${snapshot.revision}`,
        );
        snapshot = validation.snapshot;
        mainValidationExecuted = true;
        if (snapshot.repairHandoff?.reason === "MAIN_GATE_FAILURE") {
          return finish("LOCAL_MAIN_VALIDATION_FAILED");
        }
        if (snapshot.mainValidation?.releaseGate === "WAITING_EXPORT_TEMPLATES") {
          return finish("LOCAL_EXPORT_TEMPLATES_REQUIRED");
        }
        if (snapshot.stage !== "MFA_REQUIRED") {
          throw new Error("main SHA 门禁没有产生可用于自动编排的终态证据");
        }
        break;
      }
      case "AWAITING_ACCEPTANCE":
        return finish("USER_ACCEPTANCE_REQUIRED");
      case "MFA_REQUIRED":
        return finish("MFA_REQUIRED");
      case "EXTERNAL_APPROVAL_REQUIRED":
        return finish("EXTERNAL_APPROVAL_REQUIRED");
      case "WAITING_PROVIDER":
        return finish("WAITING_PROVIDER");
      case "AWAITING_SPEC_APPROVAL":
        return finish("SPEC_APPROVAL_REQUIRED");
      case "CANCELLED":
      case "RELEASED":
        return finish("TERMINAL");
      default:
        throw new Error(`本地自动编排遇到未知阶段：${snapshot.stage satisfies never}`);
    }
  }

  throw new Error("本地自动编排超过安全的最大转换次数");
}

function result(
  snapshot: LocalDeliverySnapshot,
  stopReason: LocalAutomationStopReason,
  automaticTransitions: number,
  validationExecuted: boolean,
  mainValidationExecuted: boolean,
  requiredPhysicalPlatforms: readonly ("linux" | "windows")[] = [],
  steamReinstallExecuted = false,
  agentExecutionAttempted = false,
  developmentMode: LocalAutomationResult["developmentMode"] = null,
  fixtureFallbackCode: string | null = null,
): LocalAutomationResult {
  return {
    snapshot,
    stopReason,
    automaticTransitions,
    validationExecuted,
    mainValidationExecuted,
    steamReinstallExecuted,
    agentExecutionAttempted,
    developmentMode,
    fixtureFallbackCode,
    requiredPhysicalPlatforms,
  };
}

export const localAgentAutomationRunner: AgentRunner = runAndSaveLocalAgentExecution;
