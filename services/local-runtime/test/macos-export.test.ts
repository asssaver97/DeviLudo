import assert from "node:assert/strict";
import test from "node:test";
import { validateMacosBuildArchive } from "../src/macos-export";

const entries = [
  "DeviLudo Local Smoke.command",
  "DeviLudo Local Smoke.app/Contents/MacOS/DeviLudo Local Smoke",
  "DeviLudo Local Smoke.app/Contents/Resources/DeviLudo Local Smoke.pck",
  "DeviLudo Local Smoke.app/Contents/Resources/icon.icns",
  "DeviLudo Local Smoke.app/Contents/Resources/PrivacyInfo.xcprivacy",
  "DeviLudo Local Smoke.app/Contents/Info.plist",
  "DeviLudo Local Smoke.app/Contents/PkgInfo",
] as const;

function listing(type = "-") {
  return entries.map((entry, index) => `${type}rwxr-xr-x  2.0 unx ${index + 1} b- ${index + 1} defN 26-Jul-23 08:08 ${entry}`).join("\n");
}

test("macOS build archive accepts only the fixed regular-file app payload", () => {
  assert.doesNotThrow(() => validateMacosBuildArchive(entries, listing()));
  assert.throws(
    () => validateMacosBuildArchive([...entries.slice(0, -1), "../escape"], listing()),
    /unexpected or unsafe file list/,
  );
  assert.throws(() => validateMacosBuildArchive(entries, listing("l")), /non-regular file/);
  assert.throws(() => validateMacosBuildArchive([...entries, entries[0]], listing()), /unexpected or unsafe file list/);
});
