export type ConfigurationOwnership = "workspace" | "platform";

export function platformManagedConfiguration(
  env: Readonly<Record<string, string | undefined>> = process.env,
): boolean {
  return env.DEVILUDO_PLATFORM_MANAGED_CONFIGURATION === "1";
}

export function configurationOwnership(
  env: Readonly<Record<string, string | undefined>> = process.env,
): ConfigurationOwnership {
  return platformManagedConfiguration(env) ? "platform" : "workspace";
}
