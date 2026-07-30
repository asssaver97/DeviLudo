import { createHash } from "node:crypto";
import { readFile, writeFile } from "node:fs/promises";

const version = process.env.DEVILUDO_RELEASE_VERSION ?? "";
const output = process.argv[2] ?? "release-manifest.json";
if (!/^v\d+\.\d+\.\d+(?:-[0-9A-Za-z.-]+)?$/.test(version)) throw new Error("DEVILUDO_RELEASE_VERSION is invalid");
const roles = ["WEB", "CORE", "E2E_LINUX", "E2E_WINDOWS", "E2E_MACOS"];
const bundles = {};
for (const role of roles) {
  const file = role === "E2E_WINDOWS" ? `${role}.zip` : `${role}.tar.gz`;
  const content = await readFile(file);
  bundles[role] = { file, sha256: createHash("sha256").update(content).digest("hex") };
}
const images = JSON.parse(process.env.DEVILUDO_RELEASE_IMAGES ?? "[]");
if (!Array.isArray(images) || images.some(image => typeof image !== "string" || !image.includes("@sha256:"))) throw new Error("Release image digests are required");
const godotBuilderImage = images.find(image => image.includes("-godot-builder@"));
if (!godotBuilderImage) throw new Error("The signed Godot Builder image is required");
const e2eRuntimeDigests = JSON.parse(process.env.DEVILUDO_E2E_RUNTIME_DIGESTS ?? "{}");
if (["linux", "windows", "macos"].some(platform => !/^sha256:[0-9a-f]{64}$/.test(e2eRuntimeDigests[platform] ?? ""))) {
  throw new Error("Signed E2E golden image digests are required");
}
const kata = {
  version: process.env.DEVILUDO_KATA_VERSION ?? "",
  url: process.env.DEVILUDO_KATA_URL ?? "",
  sha256: process.env.DEVILUDO_KATA_SHA256 ?? "",
};
if (!/^\d+\.\d+\.\d+$/.test(kata.version)
  || !new RegExp(`^https://github\\.com/kata-containers/kata-containers/releases/download/${kata.version.replaceAll(".", "\\.")}/kata-static-${kata.version.replaceAll(".", "\\.")}-amd64\\.tar\\.xz$`).test(kata.url)
  || !/^[0-9a-f]{64}$/.test(kata.sha256)) {
  throw new Error("Pinned Kata runtime URL and SHA-256 are required");
}
await writeFile(output, JSON.stringify({
  schemaVersion: "deviludo.release.v1",
  version,
  createdAt: new Date().toISOString(),
  roles,
  database: { baseline: "001", schemaCompatibility: "deviludo-core-v4" },
  protocols: ["deviludo.job.v4", "deviludo.sandbox-plan.v2", "deviludo.executor-receipt.v2"],
  images,
  plugins: {
    GODOT: {
      version: "1",
      builderImage: godotBuilderImage,
      buildProtocol: "deviludo.godot-build.v1",
      guestReportProtocol: "deviludo.godot-guest-report.v1",
      guestActions: ["test", "clean-install"],
      artifactHostCommandsAllowed: false,
    },
  },
  e2eRuntimeDigests,
  externalArtifacts: { kata },
  bundles,
}, null, 2));
