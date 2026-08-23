export function retiredSourceImagePaths(
  previousManifest: unknown,
  currentManifest: unknown,
): readonly string[];

export function removeRetiredSourceImages(
  root: string,
  previousManifest: unknown,
  currentManifest: unknown,
): Promise<readonly string[]>;
