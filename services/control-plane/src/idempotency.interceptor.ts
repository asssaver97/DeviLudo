import {
  CallHandler,
  ExecutionContext,
  Injectable,
  Inject,
  NestInterceptor,
} from "@nestjs/common";
import { createHash } from "node:crypto";
import type { FastifyReply, FastifyRequest } from "fastify";
import { catchError, from, map, mergeMap, Observable, of, throwError } from "rxjs";
import { authenticatedAdminActor, bindAdminMutationClaim } from "./admin-principal";
import { AdminIdempotencyStore } from "./admin-idempotency";
import { ServiceProblem } from "./contracts";
import { header } from "./rbac.guard";

export class IdempotencyInterceptor implements NestInterceptor {
  constructor(private readonly store: AdminIdempotencyStore) {}

  async intercept(context: ExecutionContext, next: CallHandler): Promise<Observable<unknown>> {
    if (context.getType() !== "http") return next.handle();
    const request = context.switchToHttp().getRequest<FastifyRequest>();
    const reply = context.switchToHttp().getResponse<FastifyReply>();
    const mutation = request.method !== "GET" && request.method !== "HEAD" && request.method !== "OPTIONS";
    if (!mutation) {
      return next.handle().pipe(map((data) => ({ data, meta: { requestId: request.id } })));
    }

    const idempotencyKey = header(request, "idempotency-key")?.trim();
    if (!idempotencyKey || idempotencyKey.length > 160 || !/^[A-Za-z0-9._:-]+$/.test(idempotencyKey)) {
      throw new ServiceProblem(400, "IDEMPOTENCY_KEY_REQUIRED", "A valid Idempotency-Key header is required for mutations");
    }
    const actor = authenticatedAdminActor(request);
    const identity = [
      request.method,
      request.routeOptions.url,
      request.params ? JSON.stringify(request.params) : "",
      actor.role,
      actor.actorId,
      actor.tenantId ?? "platform",
      actor.projectId ?? "all-projects",
      idempotencyKey,
    ].join("|");
    const identityDigest = createHash("sha256").update(identity).digest("hex");
    const requestFingerprint = fingerprintRequest(request.body);
    const claim = await this.store.acquire({ identityDigest, requestFingerprint });
    if (claim.kind === "CONFLICT") {
      throw new ServiceProblem(409, "IDEMPOTENCY_KEY_REUSED", "Idempotency-Key was already used with a different request");
    }
    if (claim.kind === "BUSY") {
      reply.header("Retry-After", "1");
      throw new ServiceProblem(409, "IDEMPOTENCY_REQUEST_IN_PROGRESS", "An equivalent administrator request is still in progress");
    }
    if (claim.kind === "REPLAY") {
      reply.status(200);
      reply.header("Idempotent-Replayed", "true");
      return of({
        data: structuredClone(claim.payload),
        meta: { requestId: request.id, idempotentReplay: true },
      });
    }

    bindAdminMutationClaim(request, {
      identityDigest,
      requestFingerprint,
      claimToken: claim.claimToken,
    });

    return next.handle().pipe(
      mergeMap((payload) => from(this.store.complete({
        identityDigest,
        requestFingerprint,
        claimToken: claim.claimToken,
        payload,
      })).pipe(map(() => ({
        data: payload,
        meta: { requestId: request.id, idempotentReplay: false },
      })))),
      catchError((error: unknown) => from(this.store.release({
        identityDigest,
        requestFingerprint,
        claimToken: claim.claimToken,
      }).catch(() => undefined)).pipe(mergeMap(() => throwError(() => error)))),
    );
  }
}

Inject(AdminIdempotencyStore)(IdempotencyInterceptor, undefined, 0);
Injectable()(IdempotencyInterceptor);

function fingerprintRequest(value: unknown): string {
  return createHash("sha256").update(canonicalJson(value)).digest("hex");
}

function canonicalJson(value: unknown): string {
  if (value === null || typeof value !== "object") return JSON.stringify(value) ?? "undefined";
  if (Array.isArray(value)) return `[${value.map(canonicalJson).join(",")}]`;
  return `{${Object.entries(value as Record<string, unknown>)
    .sort(([left], [right]) => left.localeCompare(right))
    .map(([key, child]) => `${JSON.stringify(key)}:${canonicalJson(child)}`)
    .join(",")}}`;
}
