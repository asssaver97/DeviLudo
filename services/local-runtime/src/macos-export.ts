import { lstat, readdir, realpath } from "node:fs/promises";
import path from "node:path";

const APP_NAME = "DeviLudo Local Smoke";
const MAX_EXTRACTED_BYTES = 512 * 1024 * 1024;
const EXPECTED_FILES = Object.freeze([
  `${APP_NAME}.command`,
  `${APP_NAME}.app/Contents/Info.plist`,
  `${APP_NAME}.app/Contents/MacOS/${APP_NAME}`,
  `${APP_NAME}.app/Contents/PkgInfo`,
  `${APP_NAME}.app/Contents/Resources/${APP_NAME}.pck`,
  `${APP_NAME}.app/Contents/Resources/PrivacyInfo.xcprivacy`,
  `${APP_NAME}.app/Contents/Resources/icon.icns`,
].sort());
const EXPECTED_DIRECTORIES = new Set([
  `${APP_NAME}.app`,
  `${APP_NAME}.app/Contents`,
  `${APP_NAME}.app/Contents/MacOS`,
  `${APP_NAME}.app/Contents/Resources`,
]);

export function validateMacosBuildArchive(
  entries: readonly string[],
  detailedListing: string,
): void {
  const sorted = [...entries].sort();
  if (entries.length !== EXPECTED_FILES.length
    || new Set(entries).size !== entries.length
    || JSON.stringify(sorted) !== JSON.stringify(EXPECTED_FILES)) {
    throw new Error("macOS build archive has an unexpected or unsafe file list");
  }

  const metadataLines = detailedListing.split(/\r?\n/)
    .filter((line) => /^[dl-][rwxstST-]{9}\s/.test(line));
  if (metadataLines.length !== EXPECTED_FILES.length) {
    throw new Error("macOS build archive metadata does not match its file list");
  }
  let totalBytes = 0;
  for (const expected of EXPECTED_FILES) {
    const matches = metadataLines.filter((line) => line.endsWith(expected));
    if (matches.length !== 1 || !matches[0].startsWith("-")) {
      throw new Error("macOS build archive contains a non-regular file");
    }
    const size = matches[0].match(/^-[rwx-]{9}\s+\S+\s+\S+\s+(\d+)\s/)?.[1];
    if (!size || !Number.isSafeInteger(Number(size)) || Number(size) < 1) {
      throw new Error("macOS build archive contains an invalid file size");
    }
    totalBytes += Number(size);
    if (totalBytes > MAX_EXTRACTED_BYTES) {
      throw new Error("macOS build archive exceeds the extracted size limit");
    }
  }
}

export async function inspectExtractedMacosBuild(root: string): Promise<string> {
  const rootInfo = await lstat(root);
  if (!rootInfo.isDirectory() || rootInfo.isSymbolicLink()) {
    throw new Error("macOS build extraction root is not a real directory");
  }
  const rootRealPath = await realpath(root);
  const discoveredFiles = new Set<string>();
  const discoveredDirectories = new Set<string>();
  let totalBytes = 0;
  const pending = [""];
  while (pending.length) {
    const relativeDirectory = pending.pop()!;
    const absoluteDirectory = path.join(root, relativeDirectory);
    const entries = await readdir(absoluteDirectory, { withFileTypes: true });
    for (const entry of entries) {
      const relative = path.posix.join(relativeDirectory.split(path.sep).join("/"), entry.name);
      const absolute = path.join(root, ...relative.split("/"));
      const metadata = await lstat(absolute);
      if (metadata.isSymbolicLink()) throw new Error("Extracted macOS build contains a symlink");
      if (metadata.isDirectory()) {
        if (!EXPECTED_DIRECTORIES.has(relative)) throw new Error("Extracted macOS build contains an unexpected directory");
        discoveredDirectories.add(relative);
        pending.push(relative);
        continue;
      }
      if (!metadata.isFile() || !EXPECTED_FILES.includes(relative)) {
        throw new Error("Extracted macOS build contains an unexpected entry");
      }
      if (metadata.size < 1) throw new Error("Extracted macOS build contains an empty file");
      totalBytes += metadata.size;
      if (totalBytes > MAX_EXTRACTED_BYTES) throw new Error("Extracted macOS build exceeds the size limit");
      discoveredFiles.add(relative);
    }
  }
  if (discoveredFiles.size !== EXPECTED_FILES.length
    || discoveredDirectories.size !== EXPECTED_DIRECTORIES.size
    || EXPECTED_FILES.some((entry) => !discoveredFiles.has(entry))) {
    throw new Error("Extracted macOS build is incomplete");
  }
  const executable = path.join(root, `${APP_NAME}.app`, "Contents", "MacOS", APP_NAME);
  const executableInfo = await lstat(executable);
  if ((executableInfo.mode & 0o111) === 0) throw new Error("Extracted macOS build executable is not executable");
  const executableRealPath = await realpath(executable);
  if (path.dirname(executableRealPath) !== path.join(rootRealPath, `${APP_NAME}.app`, "Contents", "MacOS")) {
    throw new Error("Extracted macOS build executable escapes its extraction root");
  }
  return executableRealPath;
}
