import {
  Body,
  Controller,
  Get,
  Inject,
  Param,
  Post,
  Put,
  Req,
} from "@nestjs/common";
import type { FastifyRequest } from "fastify";
import { AdminService } from "./admin.service";
import { authenticatedAdminMutationActor } from "./admin-principal";
import { credentialResultView, credentialView } from "./admin-public";
import { ADMIN_ROLES, type AdminRole, type RequestActor } from "./contracts";
import { Roles } from "./roles";

const ALL_ROLES = ADMIN_ROLES;
const PROFILE_ROLES = ["PlatformAgentAdmin", "SecurityAdmin", "TenantAdmin", "ProjectOwner"] as const;

export class AdminController {
  constructor(private readonly service: AdminService) {}

  agents(request: FastifyRequest): Promise<Readonly<Record<string, unknown>>> {
    return this.service.agents(actor(request));
  }

  discoverVersions(body: Record<string, unknown>, request: FastifyRequest) {
    return this.service.discoverVersions(objectBody(body), actor(request));
  }

  approveVersion(body: Record<string, unknown>, request: FastifyRequest) {
    return this.service.setVersionState("approve", objectBody(body), actor(request));
  }

  blockVersion(body: Record<string, unknown>, request: FastifyRequest) {
    return this.service.setVersionState("block", objectBody(body), actor(request));
  }

  createInstallation(body: Record<string, unknown>, request: FastifyRequest) {
    return this.service.createInstallation(objectBody(body), actor(request));
  }

  advanceRollout(id: string, request: FastifyRequest) {
    return this.service.rollout(id, "advance", actor(request));
  }

  rollbackRollout(id: string, request: FastifyRequest) {
    return this.service.rollout(id, "rollback", actor(request));
  }

  createProfile(body: Record<string, unknown>, request: FastifyRequest) {
    return this.service.createProfile(objectBody(body), actor(request));
  }

  validateProfile(id: string, request: FastifyRequest) {
    return this.service.transitionProfile(id, "validate", actor(request));
  }

  activateProfile(id: string, request: FastifyRequest) {
    return this.service.transitionProfile(id, "activate", actor(request));
  }

  disableProfile(id: string, request: FastifyRequest) {
    return this.service.transitionProfile(id, "disable", actor(request));
  }

  async createCredential(body: Record<string, unknown>, request: FastifyRequest) {
    return credentialView(await this.service.createCredential(objectBody(body), actor(request)));
  }

  async rotateCredential(
    id: string,
    body: Record<string, unknown>,
    request: FastifyRequest,
  ) {
    return credentialResultView(await this.service.rotateCredential(id, objectBody(body), actor(request)));
  }

  async revokeCredential(id: string, request: FastifyRequest) {
    return credentialView(await this.service.revokeCredential(id, actor(request)));
  }

  updateDefault(
    scope: string,
    body: Record<string, unknown>,
    request: FastifyRequest,
  ) {
    return this.service.updateDefault(scope, objectBody(body), actor(request));
  }

  health(): Promise<Readonly<Record<string, unknown>>> {
    return this.service.health();
  }

  audit(request: FastifyRequest) {
    return this.service.auditLog(actor(request));
  }

  reconcileInferenceRequest(id: string, body: Record<string, unknown>, request: FastifyRequest) {
    return this.service.reconcileInferenceRequest(id, objectBody(body), actor(request));
  }

  lookupInferenceReconciliation(tenantId: string, runId: string) {
    return this.service.lookupInferenceReconciliation(tenantId, runId);
  }

  reconcileSpecModelGeneration(operationKey: string, body: Record<string, unknown>, request: FastifyRequest) {
    return this.service.reconcileSpecModelGeneration(operationKey, objectBody(body), actor(request));
  }

  lookupSpecModelReconciliation(tenantId: string, operationKey: string) {
    return this.service.lookupSpecModelReconciliation(tenantId, operationKey);
  }
}

// Decorators are applied imperatively so this service remains consumable from
// the web workspace's standard-decorator tsconfig as well as Nest's legacy
// decorator tsconfig. The resulting Nest route metadata is identical.
Inject(AdminService)(AdminController, undefined, 0);
applyRoute("agents", Get("agents"), ALL_ROLES, [Req()]);
applyRoute("discoverVersions", Post("agent-versions/discover"), ["PlatformAgentAdmin"], [Body(), Req()]);
applyRoute("approveVersion", Post("agent-versions/approve"), ["PlatformAgentAdmin"], [Body(), Req()]);
applyRoute("blockVersion", Post("agent-versions/block"), ["PlatformAgentAdmin"], [Body(), Req()]);
applyRoute("createInstallation", Post("agent-installations"), ["PlatformAgentAdmin"], [Body(), Req()]);
applyRoute("advanceRollout", Post("agent-rollouts/:id/advance"), ["PlatformAgentAdmin"], [Param("id"), Req()]);
applyRoute("rollbackRollout", Post("agent-rollouts/:id/rollback"), ["PlatformAgentAdmin"], [Param("id"), Req()]);
applyRoute("createProfile", Post("agent-profiles"), PROFILE_ROLES, [Body(), Req()]);
applyRoute("validateProfile", Post("agent-profiles/:id/validate"), PROFILE_ROLES, [Param("id"), Req()]);
applyRoute("activateProfile", Post("agent-profiles/:id/activate"), ["SecurityAdmin"], [Param("id"), Req()]);
applyRoute("disableProfile", Post("agent-profiles/:id/disable"), PROFILE_ROLES, [Param("id"), Req()]);
applyRoute("createCredential", Post("credentials"), ["SecurityAdmin", "TenantAdmin"], [Body(), Req()]);
applyRoute("rotateCredential", Post("credentials/:id/rotate"), ["SecurityAdmin", "TenantAdmin"], [Param("id"), Body(), Req()]);
applyRoute("revokeCredential", Post("credentials/:id/revoke"), ["SecurityAdmin", "TenantAdmin"], [Param("id"), Req()]);
applyRoute("updateDefault", Put("agent-defaults/:scope"), PROFILE_ROLES, [Param("scope"), Body(), Req()]);
applyRoute("health", Get("agent-health"), ALL_ROLES, []);
applyRoute("audit", Get("audit"), ALL_ROLES, [Req()]);
applyRoute("reconcileInferenceRequest", Post("inference-requests/:id/reconcile"), ["SecurityAdmin"], [Param("id"), Body(), Req()]);
applyRoute("lookupInferenceReconciliation", Get("inference-runs/:tenantId/:runId/reconciliation"), ["SecurityAdmin"], [Param("tenantId"), Param("runId")]);
applyRoute("reconcileSpecModelGeneration", Post("spec-model-generations/:operationKey/reconcile"), ["SecurityAdmin"], [Param("operationKey"), Body(), Req()]);
applyRoute("lookupSpecModelReconciliation", Get("spec-model-generations/:tenantId/:operationKey/reconciliation"), ["SecurityAdmin"], [Param("tenantId"), Param("operationKey")]);
Controller("admin")(AdminController);

function applyRoute(
  method: keyof AdminController,
  routeDecorator: MethodDecorator,
  roles: readonly AdminRole[],
  parameters: readonly ParameterDecorator[],
): void {
  const descriptor = Object.getOwnPropertyDescriptor(AdminController.prototype, method);
  if (!descriptor) throw new Error(`Missing AdminController method ${String(method)}`);
  parameters.forEach((decorator, index) => decorator(AdminController.prototype, method, index));
  Roles(...roles)(AdminController.prototype, method, descriptor);
  routeDecorator(AdminController.prototype, method, descriptor);
}

function objectBody(body: unknown): Record<string, unknown> {
  if (!body || typeof body !== "object" || Array.isArray(body)) return {};
  return body as Record<string, unknown>;
}

function actor(request: FastifyRequest): RequestActor {
  return authenticatedAdminMutationActor(request);
}
