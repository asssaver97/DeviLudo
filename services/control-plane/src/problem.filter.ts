import { ArgumentsHost, Catch, ExceptionFilter, HttpException } from "@nestjs/common";
import type { FastifyReply, FastifyRequest } from "fastify";
import { ServiceProblem } from "./contracts";

export class ProblemFilter implements ExceptionFilter {
  catch(error: unknown, host: ArgumentsHost): void {
    const http = host.switchToHttp();
    const request = http.getRequest<FastifyRequest>();
    const reply = http.getResponse<FastifyReply>();
    const problem = normalizeProblem(error);
    reply
      .status(problem.status)
      .header("cache-control", "no-store")
      .header("x-content-type-options", "nosniff")
      .send({
        error: {
          code: problem.code,
          message: problem.message,
          details: redact(problem.details ?? null),
          requestId: request.id,
        },
      });
  }
}

Catch()(ProblemFilter);

function normalizeProblem(error: unknown): {
  status: number;
  code: string;
  message: string;
  details?: unknown;
} {
  if (error instanceof ServiceProblem) {
    return { status: error.status, code: error.code, message: error.message, details: error.details };
  }
  if (error instanceof HttpException) {
    const status = error.getStatus();
    return {
      status,
      code: status === 404 ? "NOT_FOUND" : "HTTP_ERROR",
      message: status >= 500 ? "The control-plane could not complete the request" : error.message,
    };
  }
  return {
    status: 500,
    code: "INTERNAL_ERROR",
    message: "The control-plane could not complete the request",
  };
}

const SECRET_FIELD = /(api[-_]?key|secret|password|token|authorization)/i;

function redact(value: unknown): unknown {
  if (Array.isArray(value)) return value.map(redact);
  if (value && typeof value === "object") {
    return Object.fromEntries(
      Object.entries(value as Record<string, unknown>).map(([key, child]) => [
        key,
        SECRET_FIELD.test(key) ? "[REDACTED]" : redact(child),
      ]),
    );
  }
  return value;
}
