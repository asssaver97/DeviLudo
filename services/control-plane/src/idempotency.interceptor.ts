import {
  CallHandler,
  ExecutionContext,
  Injectable,
  NestInterceptor,
} from "@nestjs/common";
import { createHash } from "node:crypto";
import type { FastifyReply, FastifyRequest } from "fastify";
import { map, Observable } from "rxjs";
import { authenticatedAdminActor } from "./admin-principal";
import { ServiceProblem } from "./contracts";
import { header } from "./rbac.guard";

interface CachedResult {
  readonly payload: unknown;
  readonly requestFingerprint: string;
  readonly createdAt: number;
}

export class IdempotencyInterceptor implements NestInterceptor {
  readonly #results = new Map<string, CachedResult>();

  intercept(context: ExecutionContext, next: CallHandler): Observable<unknown> {
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
    this.evictExpired();
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
    const requestFingerprint = fingerprintRequest(request.body);
    const cached = this.#results.get(identity);
    if (cached) {
      if (cached.requestFingerprint !== requestFingerprint) {
        throw new ServiceProblem(409, "IDEMPOTENCY_KEY_REUSED", "Idempotency-Key was already used with a different request");
      }
      reply.status(200);
      reply.header("Idempotent-Replayed", "true");
      return new Observable((subscriber) => {
        subscriber.next({
          data: structuredClone(cached.payload),
          meta: { requestId: request.id, idempotentReplay: true },
        });
        subscriber.complete();
      });
    }

    return next.handle().pipe(
      map((payload) => {
        this.#results.set(identity, {
          payload: structuredClone(payload),
          requestFingerprint,
          createdAt: Date.now(),
        });
        return { data: payload, meta: { requestId: request.id, idempotentReplay: false } };
      }),
    );
  }

  private evictExpired(): void {
    const cutoff = Date.now() - 24 * 60 * 60 * 1000;
    for (const [key, result] of this.#results) {
      if (result.createdAt < cutoff) this.#results.delete(key);
    }
  }
}

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
