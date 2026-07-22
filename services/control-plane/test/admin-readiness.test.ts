import assert from "node:assert/strict";
import test from "node:test";
import { ServiceUnavailableException } from "@nestjs/common";
import { HealthController } from "../src/health.controller";

const dependencyNames = [
  "admin-store",
  "secret-broker",
  "provider-probe",
  "agent-supply-chain",
  "inference-reconciliation",
  "spec-model-reconciliation",
] as const;

function readinessController(failing: string | null = null) {
  const calls: string[] = [];
  const probe = (name: string) => ({
    async probe() {
      calls.push(name);
      if (failing === name) throw new Error(`${name} unavailable`);
      return Object.freeze({ status: "READY" });
    },
  });
  const store = {
    async read(callback: (state: unknown) => unknown) {
      calls.push("admin-store");
      if (failing === "admin-store") throw new Error("admin-store unavailable");
      return callback(Object.freeze({}));
    },
  };
  return {
    calls,
    controller: new HealthController(
      store as never,
      probe("secret-broker") as never,
      probe("provider-probe") as never,
      probe("agent-supply-chain") as never,
      probe("inference-reconciliation") as never,
      probe("spec-model-reconciliation") as never,
    ),
  };
}

test("Agent administration readiness proves every credential, Provider and supply-chain dependency", async () => {
  const fixture = readinessController();
  assert.deepEqual(await fixture.controller.readiness(), {
    status: "ok",
    service: "deviludo-admin-control-plane",
  });
  assert.deepEqual([...fixture.calls].sort(), [...dependencyNames].sort());
});

test("Agent administration readiness fails closed when any authoritative dependency is unavailable", async (context) => {
  for (const dependency of dependencyNames) {
    await context.test(dependency, async () => {
      const fixture = readinessController(dependency);
      await assert.rejects(fixture.controller.readiness(), (error: unknown) =>
        error instanceof ServiceUnavailableException && error.getStatus() === 503);
    });
  }
});
