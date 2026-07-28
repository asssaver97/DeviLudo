import {
  createLocalSidecarHeaders,
  LocalSidecarRequestVerifier,
  localSidecarKeyFromEnvironment,
  type LocalSidecarAssertion,
} from "../../../lib/security/local-sidecar-auth";

export { LocalSidecarAuthenticationError as LocalGitHubRuntimeAuthenticationError } from "../../../lib/security/local-sidecar-auth";

type Environment = Readonly<Record<string, string | undefined>>;
const PROTOCOL = Object.freeze({
  audience: "github-runtime",
  keyEnvironmentVariable: "DEVILUDO_LOCAL_GITHUB_RUNTIME_HMAC_KEY",
});

export function localGitHubRuntimeKeyFromEnvironment(
  env: Environment = { DEVILUDO_LOCAL_GITHUB_RUNTIME_HMAC_KEY: process.env.DEVILUDO_LOCAL_GITHUB_RUNTIME_HMAC_KEY },
): Uint8Array {
  return localSidecarKeyFromEnvironment(PROTOCOL, env);
}

export function createLocalGitHubRuntimeHeaders(
  assertion: LocalSidecarAssertion,
  options: Readonly<{ key?: Uint8Array; now?: Date; nonce?: string }> = {},
): Readonly<Record<string, string>> {
  return createLocalSidecarHeaders(PROTOCOL, assertion, {
    ...options,
    key: options.key ?? localGitHubRuntimeKeyFromEnvironment(),
  });
}

export class LocalGitHubRuntimeRequestVerifier extends LocalSidecarRequestVerifier {
  constructor(key: Uint8Array) { super(PROTOCOL, key); }
}
