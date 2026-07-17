import { Module } from "@nestjs/common";
import { APP_FILTER, APP_GUARD, APP_INTERCEPTOR } from "@nestjs/core";
import { AdminController } from "./admin.controller";
import { AdminService } from "./admin.service";
import { AdminStore } from "./admin.store";
import { IdempotencyInterceptor } from "./idempotency.interceptor";
import { ProblemFilter } from "./problem.filter";
import { RbacGuard } from "./rbac.guard";
import { InferenceGatewayProviderProbe, ProviderProbe } from "./provider-probe";
import { createSecretVault, SecretVault } from "./secret-vault";

export class AppModule {}

Module({
  controllers: [AdminController],
  providers: [
    AdminService,
    AdminStore,
    { provide: SecretVault, useFactory: createSecretVault },
    { provide: ProviderProbe, useClass: InferenceGatewayProviderProbe },
    { provide: APP_GUARD, useClass: RbacGuard },
    { provide: APP_INTERCEPTOR, useClass: IdempotencyInterceptor },
    { provide: APP_FILTER, useClass: ProblemFilter },
  ],
})(AppModule);
