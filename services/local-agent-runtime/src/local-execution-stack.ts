import path from "node:path";
import type { FastifyInstance } from "fastify";
import { AgentExecutionSupervisor } from "../../agent-worker/src/supervisor";
import { NodeGatewayDnsResolver } from "../../inference-gateway/src/dns-resolver";
import { buildInferenceGateway } from "../../inference-gateway/src/http";
import { ProductionGatewayConnector } from "../../inference-gateway/src/production-connector";
import { FixtureWorkspaceProvisioner } from "./fixture-workspace";
import { IsolatedLocalAgentExecutor } from "./isolated-executor";
import { LocalInferenceAuthority } from "./local-inference-authority";
import { LoopbackLocalInferenceRelay } from "./local-inference-relay";
import { LocalProviderControl } from "./provider-control";

type Environment = Readonly<Record<string, string | undefined>>;

export interface LocalExecutionStack {
  readonly executor: IsolatedLocalAgentExecutor;
  readonly gateway: FastifyInstance;
  readonly gatewayHost: "127.0.0.1";
  readonly gatewayPort: number;
  readonly authority: LocalInferenceAuthority;
  readonly relay: LoopbackLocalInferenceRelay;
}

/** Compose the real local CLI path only under the explicit loopback test launcher. */
export function localExecutionStackFromEnvironment(
  env: Environment,
  providerControl: LocalProviderControl | null,
): LocalExecutionStack | null {
  if (env.DEVILUDO_LOCAL_TEST_MODE !== "1" || env.DEVILUDO_LOCAL_AGENT_EXECUTION !== "1" || !providerControl) {
    return null;
  }
  const gatewayUrl = new URL(env.DEVILUDO_LOCAL_INFERENCE_GATEWAY_URL ?? "");
  if (gatewayUrl.protocol !== "http:" || gatewayUrl.hostname !== "127.0.0.1"
    || gatewayUrl.username || gatewayUrl.password || gatewayUrl.search || gatewayUrl.hash
    || gatewayUrl.pathname.replace(/\/+$/, "") !== "/v1") {
    throw new Error("Local inference Gateway must be an explicit loopback /v1 HTTP URL");
  }
  const gatewayPort = port(gatewayUrl.port);
  const storageRoot = absolute(env.DEVILUDO_LOCAL_AGENT_STORAGE_ROOT, "Local Agent storage root");
  const fixtureRoot = absolute(env.DEVILUDO_LOCAL_AGENT_FIXTURE_ROOT, "Local Agent fixture root");
  const dns = new NodeGatewayDnsResolver();
  const authority = new LocalInferenceAuthority(providerControl);
  const connector = new ProductionGatewayConnector({
    credentials: authority.credentials,
    usage: authority.usage,
    dns,
  });
  const signingKey = authority.signingKey();
  const gateway = buildInferenceGateway({
    signingKey,
    runs: authority.runs,
    providers: authority.providers,
    usage: authority.usage,
    dns,
    connector,
    readiness: { async probe() { await connector.probe(); } },
  });
  signingKey.fill(0);
  const relay = new LoopbackLocalInferenceRelay({ gatewayUrl, tokenResolver: authority.secrets });
  const supervisor = new AgentExecutionSupervisor({ secretResolver: relay.secrets });
  const executor = new IsolatedLocalAgentExecutor({
    storageRoot,
    gatewayUrl: gatewayUrl.toString(),
    allowLocalLoopbackGateway: true,
    workspaceProvisioner: new FixtureWorkspaceProvisioner(fixtureRoot),
    runTokenBroker: authority,
    inferenceRelay: relay,
    supervisor,
  });
  return Object.freeze({ executor, gateway, gatewayHost: "127.0.0.1", gatewayPort, authority, relay });
}

function absolute(value: string | undefined, label: string): string {
  if (!value || !path.isAbsolute(value)) throw new Error(`${label} must be explicitly configured as an absolute path`);
  return path.normalize(value);
}

function port(value: string): number {
  if (!/^\d+$/.test(value)) throw new Error("Local inference Gateway port is invalid");
  const parsed = Number(value);
  if (!Number.isSafeInteger(parsed) || parsed < 1 || parsed > 65_535) {
    throw new Error("Local inference Gateway port is invalid");
  }
  return parsed;
}
