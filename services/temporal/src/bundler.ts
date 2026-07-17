import { fileURLToPath } from "node:url";
import type { Configuration } from "webpack";

const repositoryRoot = fileURLToPath(new URL("../../../", import.meta.url));

/** Temporal's webpack does not read the web app's @/* alias automatically. */
export function temporalWebpackConfigHook(config: Configuration): Configuration {
  const existingAlias = config.resolve?.alias;
  const alias = !Array.isArray(existingAlias) ? existingAlias : {};
  return {
    ...config,
    resolve: {
      ...config.resolve,
      alias: {
        ...alias,
        "@": repositoryRoot,
      },
    },
  };
}
