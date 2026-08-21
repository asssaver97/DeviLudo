export function assertBuildAssetsReferenced(
  projectRoot: string,
  assetKeys: readonly string[],
): Promise<void>;

export function missingBuildAssetReferences(
  projectRoot: string,
  assetKeys: readonly string[],
): Promise<readonly string[]>;
