import {
  createLocalSidecarHeaders,
  LocalSidecarRequestVerifier,
  localSidecarKeyFromEnvironment,
} from "../../../lib/security/local-sidecar-auth";
export { LocalSidecarAuthenticationError as LocalAgentRuntimeAuthenticationError } from "../../../lib/security/local-sidecar-auth";

type Environment = Readonly<Record<string, string | undefined>>;
const PROTOCOL = Object.freeze({
  audience: "agent-runtime",
  keyEnvironmentVariable: "DEVILUDO_LOCAL_AGENT_RUNTIME_HMAC_KEY",
});

export interface LocalAgentRuntimeAssertion {
  readonly method: "POST";
  readonly path: "/v1/preflight" | "/v1/runs" | "/v1/runs/cancel"
    | "/v1/provider-credentials" | "/v1/provider-credentials/revoke" | "/v1/provider-probes"
    | "/v1/provider-bindings/activate" | "/v1/provider-bindings/disable";
  readonly body: string | Uint8Array;
}

export function localAgentRuntimeKeyFromEnvironment(
  env: Environment = { DEVILUDO_LOCAL_AGENT_RUNTIME_HMAC_KEY: process.env.DEVILUDO_LOCAL_AGENT_RUNTIME_HMAC_KEY },
): Uint8Array {
  return localSidecarKeyFromEnvironment(PROTOCOL, env);
}

export function createLocalAgentRuntimeHeaders(
  assertion: LocalAgentRuntimeAssertion,
  options: Readonly<{ key?: Uint8Array; now?: Date; nonce?: string }> = {},
): Readonly<Record<string, string>> {
  return createLocalSidecarHeaders(PROTOCOL, assertion, {
    ...options,
    key: options.key ?? localAgentRuntimeKeyFromEnvironment(),
  });
}

export class LocalAgentRuntimeRequestVerifier extends LocalSidecarRequestVerifier {
  constructor(key: Uint8Array) {
    super(PROTOCOL, key);
  }
}
