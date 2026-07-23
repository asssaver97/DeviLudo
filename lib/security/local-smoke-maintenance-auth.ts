import {
  createLocalSidecarHeaders,
  LocalSidecarRequestVerifier,
  localSidecarKeyFromEnvironment,
  type LocalSidecarAssertion,
} from "./local-sidecar-auth";
export { LocalSidecarAuthenticationError as LocalSmokeMaintenanceAuthenticationError } from "./local-sidecar-auth";

type Environment = Readonly<Record<string, string | undefined>>;
const PROTOCOL = Object.freeze({
  audience: "smoke-maintenance",
  keyEnvironmentVariable: "DEVILUDO_LOCAL_RUNTIME_HMAC_KEY",
});

export function localSmokeMaintenanceKeyFromEnvironment(
  env: Environment = { DEVILUDO_LOCAL_RUNTIME_HMAC_KEY: process.env.DEVILUDO_LOCAL_RUNTIME_HMAC_KEY },
): Uint8Array {
  return localSidecarKeyFromEnvironment(PROTOCOL, env);
}

export function createLocalSmokeMaintenanceHeaders(
  assertion: LocalSidecarAssertion,
  options: Readonly<{ key?: Uint8Array; now?: Date; nonce?: string }> = {},
): Readonly<Record<string, string>> {
  return createLocalSidecarHeaders(PROTOCOL, assertion, {
    ...options,
    key: options.key ?? localSmokeMaintenanceKeyFromEnvironment(),
  });
}

export class LocalSmokeMaintenanceRequestVerifier extends LocalSidecarRequestVerifier {
  constructor(key: Uint8Array) { super(PROTOCOL, key); }
}
