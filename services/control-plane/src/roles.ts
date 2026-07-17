import { SetMetadata } from "@nestjs/common";
import type { AdminRole } from "./contracts";

export const ADMIN_ROLES_METADATA = Symbol("deviludo.admin-roles");

export const Roles = (...roles: readonly AdminRole[]): MethodDecorator & ClassDecorator =>
  SetMetadata(ADMIN_ROLES_METADATA, roles);
