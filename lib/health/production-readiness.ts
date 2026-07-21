import { adminControlPlaneBrokerFromEnvironment } from "@/lib/admin/control-plane-broker";
import { identityAdminBrokerFromEnvironment, identityBrokerFromEnvironment } from "@/lib/auth/identity-broker";
import { githubBrokerRuntimeFromEnvironment } from "@/lib/connections/github-broker";
import { steamEnrollmentRuntimeFromEnvironment } from "@/lib/connections/steam-broker";
import { deliveryProjectionBrokerFromEnvironment } from "@/lib/delivery-projection/broker";
import { projectRepositoryBrokerFromEnvironment } from "@/lib/projects/repository-broker";
import { releaseAuthorizationRuntimeFromEnvironment } from "@/lib/releases/publish-broker";
import { specDialogueBrokerRuntimeFromEnvironment } from "@/lib/spec-dialogue/broker";
import { userAcceptanceBrokerFromEnvironment } from "@/lib/user-acceptance/broker";

export type ProductionDependencyStatus = "CONFIGURED" | "NOT_CONFIGURED" | "INVALID_CONFIGURATION";

export interface ProductionWebReadiness {
  readonly ready: boolean;
  readonly dependencies: Readonly<{
    identityBroker: ProductionDependencyStatus;
    identityAdminBroker: ProductionDependencyStatus;
    githubAuthorizationBroker: ProductionDependencyStatus;
    projectRepositoryBroker: ProductionDependencyStatus;
    specificationDialogueBroker: ProductionDependencyStatus;
    userAcceptanceBroker: ProductionDependencyStatus;
    deliveryProjectionBroker: ProductionDependencyStatus;
    adminControlPlaneBroker: ProductionDependencyStatus;
    steamEnrollmentBroker: ProductionDependencyStatus;
    releaseAuthorizationBroker: ProductionDependencyStatus;
  }>;
}

type Environment = Readonly<Record<string, string | undefined>>;

export function evaluateProductionWebReadiness(env: Environment = process.env): ProductionWebReadiness {
  const dependencies = Object.freeze({
    identityBroker: configured(() => identityBrokerFromEnvironment(env)),
    identityAdminBroker: configured(() => identityAdminBrokerFromEnvironment(env)),
    githubAuthorizationBroker: configured(() => githubBrokerRuntimeFromEnvironment(env)),
    projectRepositoryBroker: configured(() => projectRepositoryBrokerFromEnvironment(env)),
    specificationDialogueBroker: configured(() => specDialogueBrokerRuntimeFromEnvironment(env)),
    userAcceptanceBroker: configured(() => userAcceptanceBrokerFromEnvironment(env)),
    deliveryProjectionBroker: configured(() => deliveryProjectionBrokerFromEnvironment(env)),
    adminControlPlaneBroker: configured(() => adminControlPlaneBrokerFromEnvironment(env)),
    steamEnrollmentBroker: configured(() => steamEnrollmentRuntimeFromEnvironment(env)),
    releaseAuthorizationBroker: configured(() => releaseAuthorizationRuntimeFromEnvironment(env)),
  });
  return Object.freeze({
    ready: Object.values(dependencies).every((status) => status === "CONFIGURED"),
    dependencies,
  });
}

function configured(factory: () => object | null): ProductionDependencyStatus {
  try {
    return factory() ? "CONFIGURED" : "NOT_CONFIGURED";
  } catch {
    return "INVALID_CONFIGURATION";
  }
}
