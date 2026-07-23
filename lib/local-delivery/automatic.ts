import type { LocalDeliverySnapshot } from "@/lib/local-delivery/model";
import { commandLocalDelivery, readLocalDelivery } from "@/lib/local-delivery/store";
import { runAndSaveLocalValidation } from "@/lib/local-delivery/runtime-validation";

export type LocalAutomationStopReason =
  | "USER_ACCEPTANCE_REQUIRED"
  | "MFA_REQUIRED"
  | "EXTERNAL_APPROVAL_REQUIRED"
  | "WAITING_PROVIDER"
  | "SPEC_APPROVAL_REQUIRED"
  | "LOCAL_EXPORT_TEMPLATES_REQUIRED"
  | "LOCAL_VALIDATION_FAILED"
  | "TERMINAL";

export type LocalAutomationResult = {
  readonly snapshot: LocalDeliverySnapshot;
  readonly stopReason: LocalAutomationStopReason;
  readonly automaticTransitions: number;
  readonly validationExecuted: boolean;
};

type ValidationRunner = typeof runAndSaveLocalValidation;

/**
 * Advances only server-owned fixture stages. It deliberately cannot cross a
 * user acceptance, MFA, Provider recovery, or external Steam approval gate.
 */
export async function runLocalDeliveryUntilHumanGate(
  projectId: string,
  operationKey: string,
  validationRunner: ValidationRunner = runAndSaveLocalValidation,
): Promise<LocalAutomationResult> {
  let snapshot = await readLocalDelivery(projectId);
  let automaticTransitions = 0;
  let validationExecuted = false;

  for (let attempt = 0; attempt < 12; attempt += 1) {
    switch (snapshot.stage) {
      case "AGENT_QUEUED":
      case "AGENT_RUNNING":
      case "E2E_RUNNING":
      case "MERGING":
      case "MAIN_GATE_RUNNING":
      case "STEAM_BETA_UPLOADING":
      case "STEAM_REINSTALL_E2E": {
        const transition = await commandLocalDelivery(
          projectId,
          "advance",
          `${operationKey}:advance:${snapshot.revision}:${snapshot.stage}`,
        );
        snapshot = transition.snapshot;
        automaticTransitions += transition.replayed ? 0 : 1;
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
            return result(snapshot, "LOCAL_EXPORT_TEMPLATES_REQUIRED", automaticTransitions, validationExecuted);
          }
          if (snapshot.localValidation?.status === "FAILED") {
            return result(snapshot, "LOCAL_VALIDATION_FAILED", automaticTransitions, validationExecuted);
          }
          if (snapshot.localValidation?.releaseGate !== "LOCAL_VALIDATION_PASSED") {
            throw new Error("本机验证没有产生可用于自动编排的终态证据");
          }
          break;
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
      case "AWAITING_ACCEPTANCE":
        return result(snapshot, "USER_ACCEPTANCE_REQUIRED", automaticTransitions, validationExecuted);
      case "MFA_REQUIRED":
        return result(snapshot, "MFA_REQUIRED", automaticTransitions, validationExecuted);
      case "EXTERNAL_APPROVAL_REQUIRED":
        return result(snapshot, "EXTERNAL_APPROVAL_REQUIRED", automaticTransitions, validationExecuted);
      case "WAITING_PROVIDER":
        return result(snapshot, "WAITING_PROVIDER", automaticTransitions, validationExecuted);
      case "AWAITING_SPEC_APPROVAL":
        return result(snapshot, "SPEC_APPROVAL_REQUIRED", automaticTransitions, validationExecuted);
      case "CANCELLED":
      case "RELEASED":
        return result(snapshot, "TERMINAL", automaticTransitions, validationExecuted);
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
): LocalAutomationResult {
  return { snapshot, stopReason, automaticTransitions, validationExecuted };
}
