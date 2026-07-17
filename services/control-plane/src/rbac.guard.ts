import { CanActivate, ExecutionContext, Inject, Injectable } from "@nestjs/common";
import { Reflector } from "@nestjs/core";
import type { FastifyRequest } from "fastify";
import { ADMIN_ROLES, ServiceProblem, type AdminRole } from "./contracts";
import { ADMIN_ROLES_METADATA } from "./roles";

export class RbacGuard implements CanActivate {
  constructor(private readonly reflector: Reflector) {}

  canActivate(context: ExecutionContext): boolean {
    const allowed = this.reflector.getAllAndOverride<readonly AdminRole[]>(ADMIN_ROLES_METADATA, [
      context.getHandler(),
      context.getClass(),
    ]);
    if (!allowed?.length) return true;
    const request = context.switchToHttp().getRequest<FastifyRequest>();
    const rawRole = header(request, "x-deviludo-role") ?? "Auditor";
    if (!ADMIN_ROLES.includes(rawRole as AdminRole)) {
      throw new ServiceProblem(401, "INVALID_ADMIN_ROLE", "The authenticated principal has no recognized admin role");
    }
    if (!allowed.includes(rawRole as AdminRole)) {
      throw new ServiceProblem(403, "FORBIDDEN", "The authenticated principal cannot perform this operation", {
        requiredRoles: allowed,
      });
    }
    return true;
  }
}

Inject(Reflector)(RbacGuard, undefined, 0);
Injectable()(RbacGuard);

export function header(request: FastifyRequest, name: string): string | undefined {
  const value = request.headers[name];
  if (Array.isArray(value)) return value[0];
  return typeof value === "string" ? value : undefined;
}
