import assert from "node:assert/strict";
import test from "node:test";
import { ServiceUnavailableException } from "@nestjs/common";
import { HealthController } from "../src/health.controller";
import { InMemoryAdminStore } from "../src/admin.store";

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
    async probe() {
      calls.push("admin-store");
      if (failing === "admin-store") throw new Error("admin-store unavailable");
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

test("P0 profile readiness accepts an exact Claude model while rejecting a missing platform default", async () => {
  const store = new InMemoryAdminStore();
  const controller = new HealthController(store, {} as never, {} as never, {} as never, {} as never, {} as never);
  assert.deepEqual(await controller.p0Profile(), {
    schemaVersion: "deviludo.agent-profile-readiness.v1",
    status: "ready",
    agent: "claude-code",
    cliVersion: "2.1.14",
    model: "claude-sonnet-4-6-20250514",
    profileState: "READY",
    providerState: "READY",
    credentialState: "ACTIVE",
    installationState: "ACTIVE",
    workerState: "READY",
  });
  await store.mutate((state) => state.defaults.delete("platform"));
  await assert.rejects(controller.p0Profile(), (error: unknown) =>
    error instanceof ServiceUnavailableException && error.getStatus() === 503);
});
