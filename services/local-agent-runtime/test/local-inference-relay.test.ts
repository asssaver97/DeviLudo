import assert from "node:assert/strict";
import { createHash } from "node:crypto";
import { createServer, type IncomingMessage, type Server } from "node:http";
import test from "node:test";
import type { LocalAgentExecutionRequest } from "../src/contracts";
import { LoopbackLocalInferenceRelay } from "../src/local-inference-relay";
import type { PreparedLocalRunToken } from "../src/isolated-executor";

function execution(agent: "claude-code" | "codex-cli", suffix: string): LocalAgentExecutionRequest {
  const claude = agent === "claude-code";
  const prompt = "Implement the approved game.";
  const model = claude ? "claude-sonnet-4-6-20250514" : "gpt-5.3-codex-2026-06-12";
  return Object.freeze({
    tenantId: "tenant-local",
    projectId: `project-${suffix}`,
    runId: `run-${suffix}`,
    attemptId: `attempt-${suffix}`,
    specRevisionId: "SPEC-001",
    testPlanRevisionId: "godot-testkit-1.0.0",
    profileRevisionId: `profile-${suffix}-r1`,
    installationId: `installation-${suffix}-1`,
    agent,
    expectedVersion: claude ? "2.1.201" : "0.145.0-alpha.18",
    imageDigest: `sha256:${(claude ? "a" : "b").repeat(64)}`,
    adapterVersion: claude ? "1.3.0" : "1.2.2",
    providerRevisionId: `provider-${suffix}-r1`,
    providerProtocol: claude ? "anthropic-messages" : "openai-responses",
    credentialVersionId: `credential-${suffix}-v1`,
    model,
    modelRoles: Object.freeze({ primaryModel: model, planningModel: model, smallFastModel: model, subagentModel: model }),
    budget: Object.freeze({ maxTurns: 64, maxCostUsd: 2, maxInputTokens: 10_000, maxOutputTokens: 2_000 }),
    timeoutSeconds: 7_200,
    promptDigest: createHash("sha256").update(prompt).digest("hex"),
    prompt,
  });
}

test("local relay gives both CLIs an attempt credential and resolves the renewed DLRT per request", async () => {
  const observed: Array<Readonly<{ url: string; authorization?: string; apiKey?: string; body: string }>> = [];
  const gateway = createServer(async (incoming, outgoing) => {
    const body = await read(incoming);
    observed.push(Object.freeze({
      url: incoming.url ?? "",
      ...(typeof incoming.headers.authorization === "string" ? { authorization: incoming.headers.authorization } : {}),
      ...(typeof incoming.headers["x-api-key"] === "string" ? { apiKey: incoming.headers["x-api-key"] } : {}),
      body,
    }));
    outgoing.writeHead(200, { "content-type": "application/json" });
    outgoing.end(JSON.stringify({ id: "gateway-response", usage: { input_tokens: 1, output_tokens: 1 } }));
  });
  const port = await listen(gateway);
  let currentDlrt = "initial-dlrt-never-enters-cli";
  const relay = new LoopbackLocalInferenceRelay({
    gatewayUrl: `http://127.0.0.1:${port}/v1`,
    tokenResolver: {
      async resolve(secretRef, context) {
        assert.equal(secretRef.startsWith("secret://local-run-token/"), true);
        assert.equal(context.runId.startsWith("run-"), true);
        return currentDlrt;
      },
    },
  });
  try {
    for (const agent of ["claude-code", "codex-cli"] as const) {
      const request = execution(agent, agent === "claude-code" ? "claude" : "codex");
      let renewalCalls = 0;
      const token: PreparedLocalRunToken = {
        secretRef: `secret://local-run-token/${request.runId}/${request.attemptId}`,
        expiresAt: new Date(Date.now() + 60_000).toISOString(),
        async renew() {
          renewalCalls += 1;
          currentDlrt = `renewed-dlrt-${request.attemptId}`;
          return { expiresAt: new Date(Date.now() + 15 * 60_000).toISOString(), renewed: true };
        },
        async revoke() {},
      };
      const handle = await relay.start({ request, token });
      const environmentVariable = agent === "claude-code" ? "ANTHROPIC_API_KEY" : "DEVILUDO_RUN_TOKEN";
      const localCredential = await relay.secrets.resolve(handle.runTokenSecretRef, {
        runId: request.runId, attemptId: request.attemptId, environmentVariable,
      });
      assert.notEqual(localCredential, currentDlrt);
      assert.equal(localCredential.includes("dlrt"), false);
      const path = agent === "claude-code" ? "/v1/messages" : "/v1/responses";
      const wrong = await fetch(`${handle.gatewayUrl}${path}`, {
        method: "POST",
        headers: agent === "claude-code" ? { "x-api-key": "wrong" } : { authorization: "Bearer wrong" },
        body: "{}",
      });
      assert.equal(wrong.status, 404);
      const response = await fetch(`${handle.gatewayUrl}${path}`, {
        method: "POST",
        headers: agent === "claude-code"
          ? { "content-type": "application/json", "x-api-key": localCredential }
          : { authorization: `Bearer ${localCredential}`, "content-type": "application/json" },
        body: JSON.stringify({ model: request.model, input: "build" }),
      });
      assert.equal(response.status, 200);
      assert.equal((await response.json() as { id: string }).id, "gateway-response");
      assert.equal(renewalCalls, 1);
      const forwarded = observed.at(-1);
      assert.equal(forwarded?.url, path);
      if (agent === "claude-code") {
        assert.equal(forwarded?.apiKey, currentDlrt);
        assert.equal(forwarded?.authorization, undefined);
      } else {
        assert.equal(forwarded?.authorization, `Bearer ${currentDlrt}`);
        assert.equal(forwarded?.apiKey, undefined);
      }
      assert.equal(JSON.stringify(forwarded).includes(localCredential), false);
      if (agent === "codex-cli") {
        await relay.close();
        await handle.close();
      } else await handle.close();
      await assert.rejects(relay.secrets.resolve(handle.runTokenSecretRef, {
        runId: request.runId, attemptId: request.attemptId, environmentVariable,
      }), /unavailable/);
    }
    assert.equal(observed.length, 2);
  } finally {
    await relay.close();
    await close(gateway);
  }
});

function read(incoming: IncomingMessage): Promise<string> {
  return new Promise((resolvePromise, rejectPromise) => {
    const chunks: Buffer[] = [];
    incoming.on("data", (chunk: Buffer) => chunks.push(chunk));
    incoming.once("end", () => resolvePromise(Buffer.concat(chunks).toString("utf8")));
    incoming.once("error", rejectPromise);
  });
}

function listen(server: Server): Promise<number> {
  return new Promise((resolvePromise, rejectPromise) => {
    server.once("error", rejectPromise);
    server.listen(0, "127.0.0.1", () => {
      const address = server.address();
      if (!address || typeof address === "string") rejectPromise(new Error("Gateway address is unavailable"));
      else resolvePromise(address.port);
    });
  });
}

function close(server: Server): Promise<void> {
  server.closeAllConnections();
  return new Promise((resolvePromise, rejectPromise) => server.close((error) => error ? rejectPromise(error) : resolvePromise()));
}
