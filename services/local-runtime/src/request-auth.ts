import {
  createLocalSidecarHeaders,
  LocalSidecarRequestVerifier,
  localSidecarKeyFromEnvironment,
  type LocalSidecarAssertion,
} from "../../../lib/security/local-sidecar-auth";
export { LocalSidecarAuthenticationError as LocalRuntimeAuthenticationError } from "../../../lib/security/local-sidecar-auth";

type Environment = Readonly<Record<string, string | undefined>>;
const PROTOCOL = Object.freeze({
  audience: "godot-runtime",
  keyEnvironmentVariable: "DEVILUDO_LOCAL_RUNTIME_HMAC_KEY",
});

export function localRuntimeKeyFromEnvironment(
  env: Environment = { DEVILUDO_LOCAL_RUNTIME_HMAC_KEY: process.env.DEVILUDO_LOCAL_RUNTIME_HMAC_KEY },
): Uint8Array {
  return localSidecarKeyFromEnvironment(PROTOCOL, env);
}

export function createLocalRuntimeHeaders(
  assertion: LocalSidecarAssertion,
  options: Readonly<{ key?: Uint8Array; now?: Date; nonce?: string }> = {},
): Readonly<Record<string, string>> {
  return createLocalSidecarHeaders(PROTOCOL, assertion, {
    ...options,
    key: options.key ?? localRuntimeKeyFromEnvironment(),
  });
}

export class LocalRuntimeRequestVerifier extends LocalSidecarRequestVerifier {
  constructor(key: Uint8Array) { super(PROTOCOL, key); }
}
