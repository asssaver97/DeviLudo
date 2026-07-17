import "reflect-metadata";
import { randomUUID } from "node:crypto";
import type { INestApplication } from "@nestjs/common";
import { NestFactory } from "@nestjs/core";
import { FastifyAdapter, type NestFastifyApplication } from "@nestjs/platform-fastify";
import { AppModule } from "./app.module";

export interface ControlPlaneOptions {
  readonly logger?: false | ("error" | "warn" | "log" | "debug" | "verbose" | "fatal")[];
}

export async function createControlPlaneApp(
  options: ControlPlaneOptions = {},
): Promise<NestFastifyApplication> {
  const adapter = new FastifyAdapter({
    trustProxy: true,
    bodyLimit: 64 * 1024,
    requestIdHeader: "x-request-id",
    genReqId: () => randomUUID(),
    logger: false,
  });
  const app = await NestFactory.create<NestFastifyApplication>(AppModule, adapter, {
    logger: options.logger ?? false,
    abortOnError: true,
  });
  app.enableShutdownHooks();
  const fastify = app.getHttpAdapter().getInstance();
  fastify.addHook("onSend", async (_request, reply, payload) => {
    reply.header("cache-control", "no-store");
    reply.header("x-content-type-options", "nosniff");
    reply.header("referrer-policy", "no-referrer");
    return payload;
  });
  await app.init();
  return app;
}

export async function closeControlPlaneApp(app: INestApplication): Promise<void> {
  await app.close();
}
