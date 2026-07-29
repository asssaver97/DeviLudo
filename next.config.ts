import type { NextConfig } from "next";

function loopbackOrigin(name: string, fallback: string): string {
  const url = new URL(process.env[name] ?? fallback);
  if (url.protocol !== "http:" || (url.hostname !== "127.0.0.1" && url.hostname !== "localhost")
    || url.username || url.password || url.search || url.hash || (url.pathname !== "/" && url.pathname !== "")) {
    throw new Error(`${name} must be a plain loopback HTTP origin`);
  }
  return url.origin;
}

const nextConfig: NextConfig = {
  // Vinext's Cloudflare worker does not inherit arbitrary Node environment
  // variables. Expose only the non-secret, loopback-constrained local harness
  // bindings; production remains disabled by NODE_ENV even if misconfigured.
  env: {
    DEVILUDO_LOCAL_TEST_MODE: process.env.DEVILUDO_LOCAL_TEST_MODE === "1" ? "1" : "0",
    DEVILUDO_LOCAL_PROVIDER_CONTROL_REQUIRED: process.env.DEVILUDO_LOCAL_PROVIDER_CONTROL_REQUIRED === "1" ? "1" : "0",
    DEVILUDO_PLATFORM_MANAGED_CONFIGURATION: process.env.DEVILUDO_PLATFORM_MANAGED_CONFIGURATION === "1" ? "1" : "0",
    DEVILUDO_ACCOUNT_ALLOW_INSECURE_LOCAL: process.env.DEVILUDO_ACCOUNT_ALLOW_INSECURE_LOCAL === "1" ? "1" : "0",
    DEVILUDO_ACCOUNT_API_URL: loopbackOrigin("DEVILUDO_ACCOUNT_API_URL", "http://127.0.0.1:4100"),
    DEVILUDO_LOCAL_RUNTIME_URL: loopbackOrigin("DEVILUDO_LOCAL_RUNTIME_URL", "http://127.0.0.1:4311"),
    DEVILUDO_LOCAL_AGENT_RUNTIME_URL: loopbackOrigin("DEVILUDO_LOCAL_AGENT_RUNTIME_URL", "http://127.0.0.1:4312"),
    DEVILUDO_LOCAL_SPEC_RUNTIME_URL: loopbackOrigin("DEVILUDO_LOCAL_SPEC_RUNTIME_URL", "http://127.0.0.1:4313"),
  },
};

export default nextConfig;
