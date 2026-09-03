import assert from "node:assert/strict";
import test from "node:test";
import sharp from "sharp";
import { normalizeSteamDeliveryDraft, validateSteamDraftCoverage } from "@/services/core/src/project-runtime-service";
import { renderCapsule, STEAM_STORE_ASSET_SIZES } from "@/services/core/src/steam-preparation";
import { ROLE_TO_CANONICAL_TOOLS, toolInputSchema } from "@/services/project-runtime/tool-names.mjs";

function validDraft() {
  return {
    schemaVersion: "deviludo.steam-delivery-draft.v1",
    localizations: [{ language: "english", shortDescription: "A verified game.", about: "Play the verified core loop." }],
    tags: ["Indie"], categories: ["Single-player"],
    languages: [{ language: "english", interface: true, audio: false, subtitles: true }],
    systemRequirements: [{ platform: "macos", minimum: "Apple Silicon; macOS 14" }],
    installDirectory: "Verified Game",
    launchOptions: [{ platform: "macos", executable: "Verified Game.app" }],
    depots: [{ platform: "macos", name: "macOS", architecture: "arm64" }],
    artwork: { landscapePrompt: "Text-free landscape key art based only on verified gameplay.", portraitPrompt: "Text-free portrait key art based only on verified gameplay." },
    screenshots: [1, 2, 3, 4, 5].map(index => ({ checkpointId: `checkpoint-${index}` })),
  };
}

test("Publishing Runtime has only read tools and one strict draft replacement tool", () => {
  assert.deepEqual(ROLE_TO_CANONICAL_TOOLS.PUBLISHING, [
    "context.read", "source.list", "source.read", "evidence.read", "steam.settings.read", "steam.delivery_draft.replace",
  ]);
  const schema = toolInputSchema("steam.delivery_draft.replace") as Record<string, unknown>;
  const schemaProperties = schema.properties as Record<string, Record<string, unknown>>;
  const draftSchema = schemaProperties.draft;
  const draftProperties = draftSchema.properties as Record<string, Record<string, unknown>>;
  assert.equal(schema.additionalProperties, false);
  assert.equal(draftSchema.additionalProperties, false);
  assert.equal(draftProperties.screenshots.minItems, 5);
  assert.equal(draftProperties.screenshots.maxItems, 5);
});

test("Steam draft requires English and five distinct evidence checkpoint IDs", () => {
  assert.equal(normalizeSteamDeliveryDraft(validDraft()).schemaVersion, "deviludo.steam-delivery-draft.v1");
  const noEnglish = validDraft(); noEnglish.localizations[0].language = "schinese";
  assert.throws(() => normalizeSteamDeliveryDraft(noEnglish), /incomplete/);
  const repeated = validDraft(); repeated.screenshots[4].checkpointId = "checkpoint-1";
  assert.throws(() => normalizeSteamDeliveryDraft(repeated), /incomplete/);
});

test("Steam draft cannot submit authoritative IDs or credentials", () => {
  assert.throws(() => normalizeSteamDeliveryDraft({ ...validDraft(), appId: "123" }), /cannot contain appId/);
  const nested = validDraft() as unknown as Record<string, unknown>;
  (nested.depots as Record<string, unknown>[])[0].depotId = "456";
  assert.throws(() => normalizeSteamDeliveryDraft(nested), /cannot contain depotId/);
  assert.throws(() => normalizeSteamDeliveryDraft({ ...validDraft(), credential: "secret" }), /unsafe|cannot contain/);
});

test("Steam draft language and platform derivation covers the release snapshot exactly", () => {
  const draft = normalizeSteamDeliveryDraft(validDraft());
  assert.doesNotThrow(() => validateSteamDraftCoverage(draft, ["macos"]));
  assert.throws(() => validateSteamDraftCoverage(draft, ["macos", "windows"]), /every target platform/);
  const missingCopy = validDraft();
  missingCopy.languages.push({ language: "schinese", interface: true, audio: false, subtitles: true });
  assert.throws(() => validateSteamDraftCoverage(normalizeSteamDeliveryDraft(missingCopy), ["macos"]), /every declared game language/);
});

test("Steam capsule rendering emits each exact Store and Library dimension", async () => {
  const master = await sharp({ create: { width: 64, height: 64, channels: 4, background: "#356677" } }).png().toBuffer();
  for (const target of STEAM_STORE_ASSET_SIZES) {
    const rendered = await renderCapsule(master, "Verified Game", target.width, target.height);
    const metadata = await sharp(rendered).metadata();
    assert.equal(metadata.width, target.width, target.key);
    assert.equal(metadata.height, target.height, target.key);
  }
});
