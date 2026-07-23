import type { LocalDeliverySnapshot } from "@/lib/local-delivery/model";
import { commandLocalDelivery, readLocalDelivery } from "@/lib/local-delivery/store";
import { runAndSaveLocalMainValidation } from "@/lib/local-delivery/runtime-main-validation";
import { runAndSaveLocalValidation } from "@/lib/local-delivery/runtime-validation";
import { runAndSaveLocalSteamReinstall } from "@/lib/local-delivery/runtime-steam-reinstall";

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
  | "PHYSICAL_RUNNERS_REQUIRED"
  | "TERMINAL";

export type LocalAutomationResult = {
  readonly snapshot: LocalDeliverySnapshot;
  readonly stopReason: LocalAutomationStopReason;
  readonly automaticTransitions: number;
  readonly validationExecuted: boolean;
  readonly mainValidationExecuted: boolean;
  readonly steamReinstallExecuted: boolean;
  readonly requiredPhysicalPlatforms: readonly ("linux" | "windows")[];
};

type ValidationRunner = typeof runAndSaveLocalValidation;
type MainValidationRunner = typeof runAndSaveLocalMainValidation;
type SteamReinstallRunner = typeof runAndSaveLocalSteamReinstall;

/**
 * Advances only server-owned fixture stages. It deliberately cannot cross a
 * user acceptance, MFA, Provider recovery, or external Steam approval gate.
 */
export async function runLocalDeliveryUntilHumanGate(
  projectId: string,
  operationKey: string,
  validationRunner: ValidationRunner = runAndSaveLocalValidation,
  mainValidationRunner: MainValidationRunner = runAndSaveLocalMainValidation,
  steamReinstallRunner: SteamReinstallRunner = runAndSaveLocalSteamReinstall,
): Promise<LocalAutomationResult> {
  let snapshot = await readLocalDelivery(projectId);
  let automaticTransitions = 0;
  let validationExecuted = false;
  let mainValidationExecuted = false;
  let steamReinstallExecuted = false;

  for (let attempt = 0; attempt < 12; attempt += 1) {
    switch (snapshot.stage) {
      case "AGENT_QUEUED":
      case "AGENT_RUNNING":
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
          return result(snapshot, "LOCAL_STEAM_REINSTALL_FAILED", automaticTransitions, validationExecuted, mainValidationExecuted, [], steamReinstallExecuted);
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
            return result(snapshot, "LOCAL_EXPORT_TEMPLATES_REQUIRED", automaticTransitions, validationExecuted, mainValidationExecuted);
          }
          if (snapshot.localValidation?.status === "FAILED") {
            return result(snapshot, "LOCAL_VALIDATION_FAILED", automaticTransitions, validationExecuted, mainValidationExecuted);
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
          return result(
            snapshot,
            "PHYSICAL_RUNNERS_REQUIRED",
            automaticTransitions,
            validationExecuted,
            mainValidationExecuted,
            requiredPhysicalPlatforms,
          );
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
          return result(snapshot, "LOCAL_MAIN_VALIDATION_FAILED", automaticTransitions, validationExecuted, mainValidationExecuted);
        }
        if (snapshot.mainValidation?.releaseGate === "WAITING_EXPORT_TEMPLATES") {
          return result(snapshot, "LOCAL_EXPORT_TEMPLATES_REQUIRED", automaticTransitions, validationExecuted, mainValidationExecuted);
        }
        if (snapshot.stage !== "MFA_REQUIRED") {
          throw new Error("main SHA 门禁没有产生可用于自动编排的终态证据");
        }
        break;
      }
      case "AWAITING_ACCEPTANCE":
        return result(snapshot, "USER_ACCEPTANCE_REQUIRED", automaticTransitions, validationExecuted, mainValidationExecuted);
      case "MFA_REQUIRED":
        return result(snapshot, "MFA_REQUIRED", automaticTransitions, validationExecuted, mainValidationExecuted);
      case "EXTERNAL_APPROVAL_REQUIRED":
        return result(snapshot, "EXTERNAL_APPROVAL_REQUIRED", automaticTransitions, validationExecuted, mainValidationExecuted, [], steamReinstallExecuted);
      case "WAITING_PROVIDER":
        return result(snapshot, "WAITING_PROVIDER", automaticTransitions, validationExecuted, mainValidationExecuted);
      case "AWAITING_SPEC_APPROVAL":
        return result(snapshot, "SPEC_APPROVAL_REQUIRED", automaticTransitions, validationExecuted, mainValidationExecuted);
      case "CANCELLED":
      case "RELEASED":
        return result(snapshot, "TERMINAL", automaticTransitions, validationExecuted, mainValidationExecuted);
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
): LocalAutomationResult {
  return {
    snapshot,
    stopReason,
    automaticTransitions,
    validationExecuted,
    mainValidationExecuted,
    steamReinstallExecuted,
    requiredPhysicalPlatforms,
  };
}
