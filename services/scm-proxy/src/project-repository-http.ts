import type { FastifyInstance, FastifyRequest } from "fastify";
import type { ProjectRepositoryOnboardingService } from "./project-repository-service";

export function registerProjectRepositoryRoutes(server: FastifyInstance, options: Readonly<{
  service: ProjectRepositoryOnboardingService;
  authorize(request: FastifyRequest): void | Promise<void>;
}>): void {
  server.post("/v1/project-repositories/catalog", { bodyLimit: 32 * 1024 }, async (request, reply) => {
    secure(reply);
    try { await options.authorize(request); }
    catch { return reply.status(401).send({ error: { code: "WORKLOAD_IDENTITY_REQUIRED" } }); }
    try {
      const body = exactObject(request.body, ["principal"]);
      return reply.send(await options.service.catalog(body.principal));
    } catch {
      return reply.status(400).send({ error: { code: "REPOSITORY_CATALOG_REJECTED", message: "Repository catalog request was rejected" } });
    }
  });

  server.post("/v1/projects/lookup", { bodyLimit: 32 * 1024 }, async (request, reply) => {
    secure(reply);
    try { await options.authorize(request); }
    catch { return reply.status(401).send({ error: { code: "WORKLOAD_IDENTITY_REQUIRED" } }); }
    try {
      const body = exactObject(request.body, ["principal", "projectId"]);
      const project = await options.service.project(body);
      return project ? reply.send(project) : reply.status(404).send({ error: { code: "PROJECT_NOT_FOUND" } });
    } catch {
      return reply.status(400).send({ error: { code: "PROJECT_LOOKUP_REJECTED", message: "Project lookup request was rejected" } });
    }
  });

  server.post("/v1/projects", { bodyLimit: 32 * 1024 }, async (request, reply) => {
    secure(reply);
    try { await options.authorize(request); }
    catch { return reply.status(401).send({ error: { code: "WORKLOAD_IDENTITY_REQUIRED" } }); }
    try {
      const body = exactObject(request.body, ["installationId", "name", "principal", "repositoryId", "slug"]);
      const receipt = await options.service.create({
        ...body,
        idempotencyKey: header(request, "idempotency-key"),
      });
      return reply.status(201).send(receipt);
    } catch (error) {
      const message = error instanceof Error ? error.message : "";
      const busy = message.includes("currently processing");
      const conflict = message.includes("idempotency key conflicts");
      return reply.status(busy ? 503 : conflict ? 409 : 400).send({
        error: {
          code: busy ? "PROJECT_CREATION_BUSY" : conflict ? "IDEMPOTENCY_CONFLICT" : "PROJECT_CREATION_REJECTED",
          message: busy ? "Project creation is still processing" : conflict ? "Idempotency key conflicts with another request" : "Project creation request was rejected",
        },
      });
    }
  });
}

function header(request: FastifyRequest, name: string): string {
  const value = request.headers[name];
  if (typeof value !== "string" || !/^[A-Za-z0-9][A-Za-z0-9._:-]{0,159}$/.test(value)) throw new Error("Project creation idempotency key is invalid");
  return value;
}
function exactObject(value: unknown, keys: readonly string[]): Record<string, unknown> {
  if (!value || typeof value !== "object" || Array.isArray(value)) throw new Error("Project repository request is invalid");
  const body = value as Record<string, unknown>;
  if (JSON.stringify(Object.keys(body).sort()) !== JSON.stringify([...keys].sort())) throw new Error("Project repository request is invalid");
  return body;
}
function secure(reply: { header(name: string, value: string): unknown }): void {
  reply.header("cache-control", "no-store"); reply.header("referrer-policy", "no-referrer"); reply.header("x-content-type-options", "nosniff");
}
