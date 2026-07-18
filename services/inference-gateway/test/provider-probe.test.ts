import assert from "node:assert/strict";
import { Readable } from "node:stream";
import test from "node:test";
import type { GatewayProtocol } from "../src/contracts";
import { PROVIDER_PROBE_CHECKS, StrictGatewayProviderProbe } from "../src/provider-probe";
import type { GatewayUpstreamTransport } from "../src/production-connector";

for (const protocol of ["openai-responses", "anthropic-messages"] as const) {
  test(`strict Provider probe executes the complete ${protocol} contract and wipes its lease`, async () => {
    const calls: Array<{ path: string; headers: Readonly<Record<string, string>>; body: Record<string, unknown>; aborted: boolean }> = [];
    let destroyed = false;
    const transport: GatewayUpstreamTransport = {
      async request(input) {
        const body = JSON.parse(input.body.toString("utf8")) as Record<string, unknown>;
        calls.push({ path: input.url.pathname, headers: input.headers, body, aborted: input.signal.aborted });
        if (input.signal.aborted) throw Object.assign(new Error("aborted"), { name: "AbortError" });
        if (calls.length >= 5) {
          await new Promise<void>((_accept, reject) => input.signal.addEventListener("abort", () => reject(Object.assign(new Error("timed out"), { name: "AbortError" })), { once: true }));
        }
        if (body.stream === true) return streamResponse(protocol);
        if (Array.isArray(body.tools)) return jsonResponse(toolResponse(protocol));
        return jsonResponse(minimalResponse(protocol));
      },
    };
    const probe = new StrictGatewayProviderProbe({
      credentials: {
        async resolveProviderProbe(input) {
          assert.equal(input.providerRevisionId, `provider-${protocol}`);
          const value = Buffer.from("fixed-provider-key");
          return { value, destroy() { value.fill(0); destroyed = true; } };
        },
      },
      dns: { async resolve() { return [{ address: "8.8.8.8", family: 4 as const }]; } },
      transport,
    });
    const model = protocol === "openai-responses" ? "gpt-5.3-codex-2026-06-12" : "claude-sonnet-4-20250514";
    const result = await probe.run({
      providerRevisionId: `provider-${protocol}`,
      agent: protocol === "openai-responses" ? "codex-cli" : "claude-code",
      protocol,
      baseUrl: "https://provider.example.com/v1",
      models: { primaryModel: model, planningModel: model, smallFastModel: model, subagentModel: model },
      credentialVersionId: "credential-v1",
      requiredChecks: PROVIDER_PROBE_CHECKS,
    });
    assert.deepEqual(Object.keys(result.checks), [...PROVIDER_PROBE_CHECKS]);
    assert.ok(Object.values(result.checks).every((value) => value === "PASS"));
    assert.equal(destroyed, true);
    assert.equal(calls.length, 5);
    assert.ok(calls.every((call) => call.path === (protocol === "openai-responses" ? "/v1/responses" : "/v1/messages")));
    assert.equal(protocol === "openai-responses" ? calls[0]?.headers.authorization : calls[0]?.headers["x-api-key"],
      protocol === "openai-responses" ? "Bearer fixed-provider-key" : "fixed-provider-key");
    assert.equal(JSON.stringify(result).includes("fixed-provider-key"), false);
  });
}

test("strict Provider probe refuses protocol drift and floating model aliases before resolving a key", async () => {
  let resolutions = 0;
  const probe = new StrictGatewayProviderProbe({
    credentials: { async resolveProviderProbe() { resolutions += 1; return { value: Buffer.from("fixed-key"), destroy() {} }; } },
    dns: { async resolve() { return [{ address: "8.8.8.8", family: 4 as const }]; } },
    transport: { async request() { throw new Error("must not connect"); } },
  });
  const base = {
    providerRevisionId: "provider-r1", agent: "codex-cli", protocol: "openai-responses",
    baseUrl: "https://provider.example.com/v1", credentialVersionId: "credential-v1",
    requiredChecks: PROVIDER_PROBE_CHECKS,
  };
  await assert.rejects(probe.run({ ...base, protocol: "anthropic-messages", models: exactModels("gpt-5.3-codex-2026-06-12") }), /probe failed/);
  await assert.rejects(probe.run({ ...base, models: exactModels("latest") }), /probe failed/);
  assert.equal(resolutions, 0);
});

function exactModels(model: string) {
  return { primaryModel: model, planningModel: model, smallFastModel: model, subagentModel: model };
}
function jsonResponse(payload: unknown) {
  return { statusCode: 200, headers: { "content-type": "application/json" }, body: Readable.from([JSON.stringify(payload)]) };
}
function minimalResponse(protocol: GatewayProtocol) {
  return protocol === "openai-responses"
    ? { id: "resp_probe", output: [{ type: "message", content: [{ type: "output_text", text: "OK" }] }], usage: { input_tokens: 8, output_tokens: 2 } }
    : { id: "msg_probe", type: "message", content: [{ type: "text", text: "OK" }], usage: { input_tokens: 8, output_tokens: 2 } };
}
function toolResponse(protocol: GatewayProtocol) {
  return protocol === "openai-responses"
    ? { id: "resp_tool", output: [{ type: "function_call", name: "deviludo_probe_ok", arguments: "{}" }], usage: { input_tokens: 10, output_tokens: 3 } }
    : { id: "msg_tool", type: "message", content: [{ type: "tool_use", name: "deviludo_probe_ok", input: {} }], usage: { input_tokens: 10, output_tokens: 3 } };
}
function streamResponse(protocol: GatewayProtocol) {
  const events = protocol === "openai-responses"
    ? [`data: ${JSON.stringify({ type: "response.completed", response: { usage: { input_tokens: 8, output_tokens: 2 } } })}\n\n`]
    : [
      `data: ${JSON.stringify({ type: "message_start", message: { usage: { input_tokens: 8, output_tokens: 0 } } })}\n\n`,
      `data: ${JSON.stringify({ type: "message_delta", usage: { output_tokens: 2 } })}\n\n`,
    ];
  return { statusCode: 200, headers: { "content-type": "text/event-stream" }, body: Readable.from(events) };
}
