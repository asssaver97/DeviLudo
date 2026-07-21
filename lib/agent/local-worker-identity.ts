import type { AgentKind } from "./types";
import { fingerprintSecret } from "../security/credentials";

const EXACT_VERSION = /^\d+\.\d+\.\d+(?:-[0-9A-Za-z.-]+)?$/;

/**
 * Content identity used only by the localhost deterministic Worker broker.
 * Production WorkerImage identities must continue to come from the signed
 * supply-chain build receipt and registry digest.
 */
export async function localWorkerImageDigest(
  agent: AgentKind,
  cliVersion: string,
  adapterVersion: string,
): Promise<`sha256:${string}`> {
  if ((agent !== "claude-code" && agent !== "codex-cli")
    || !EXACT_VERSION.test(cliVersion)
    || !EXACT_VERSION.test(adapterVersion)
    || /latest|stable|default/i.test(cliVersion)
    || /latest|stable|default/i.test(adapterVersion)) {
    throw new Error("Local Worker identity requires exact Agent and adapter versions");
  }
  return fingerprintSecret(new TextEncoder().encode(
    `local-worker-image:v1:${agent}:${cliVersion}:${adapterVersion}`,
  ));
}
