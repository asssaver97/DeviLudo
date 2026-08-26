import { describe, it } from "node:test";
import assert from "node:assert/strict";
import { runAssetGenerationBatch } from "@/services/core/src/asset-generation";
import {
  composeImagePrompt,
  generateAssetImage,
  generatedImageExtension,
  sniffContentType,
} from "@/services/core/src/image-generation";
import type { AssetGenerationLease } from "@/services/core/src/asset-manifest";
import type { StoredInstanceAgentSettings } from "@/services/core/src/repository";

const workspaceId = "10000000-0000-4000-8000-000000000001";
const projectId = "10000000-0000-4000-8000-000000000002";
const itemId = "10000000-0000-4000-8000-000000000003";

const PNG = Buffer.concat([
  Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a]),
  Buffer.alloc(64, 7),
]);
const JPEG = Buffer.concat([Buffer.from([0xff, 0xd8, 0xff, 0xe0]), Buffer.alloc(32, 3)]);
const WEBP = Buffer.concat([
  Buffer.from("RIFF", "latin1"),
  Buffer.alloc(4),
  Buffer.from("WEBP", "latin1"),
  Buffer.alloc(32, 5),
]);

function lease(overrides: Partial<AssetGenerationLease> = {}): AssetGenerationLease {
  return Object.freeze({
    workspaceId,
    projectId,
    itemId,
    assetKey: "sprites/player_idle",
    assetType: "animation",
    description: "Player idle animation",
    generationPrompt: "pixel art character idle, side view",
    dimensions: "32x32",
    frameCount: 4,
    attempt: 1,
    leaseToken: "30000000-0000-4000-8000-000000000004",
    ...overrides,
  });
}

const settings: StoredInstanceAgentSettings = Object.freeze({
  agentRuntime: "CLAUDE_CODE" as const,
  baseUrl: "https://api.example.com/v1",
  primaryModel: "claude-primary",
  modelOverrides: Object.freeze({ intent: null, analysis: null, design: null, development: null, test: null }),
  imageModel: "gpt-image-1",
  credentialSecretRef: "vault://instance/agent-runtime/api-key/versions/1",
  testPolicyReady: false,
  testPolicyCheckedRevision: null,
  apiKeyMask: "sk-********abcd",
  apiKeyFingerprint: "sha256:0123456789ab",
  credentialVersion: "20000000-0000-4000-8000-000000000009",
  revision: 1,
  updatedBy: "admin",
  updatedAt: "2024-01-01T00:00:00Z",
});

/** Records what the generator did so the tests can assert the sequence. */
function harness(options: Readonly<{
  leases?: readonly AssetGenerationLease[];
  imageSettings?: StoredInstanceAgentSettings | null;
  apiKey?: string | null;
  fetchImpl?: typeof globalThis.fetch;
  codexImageRunner?: (input: Readonly<{ baseUrl: string; credential: string; model: string; prompt: string }>) => Promise<Buffer>;
}> = {}) {
  const stored: { assetKey: string; extension: string; contentType: string; bytes: number }[] = [];
  const completed: { itemId: string; objectKey: string }[] = [];
  const failures: { itemId: string; error: string }[] = [];
  const claims: { leaseSeconds: number; batchSize: number }[] = [];
  const dependencies = {
    repository: {
      readAgentSettings: async () =>
        options.imageSettings === undefined ? settings : options.imageSettings,
      assets: {
        claimGeneration: async (leaseSeconds: number, batchSize: number) => {
          claims.push({ leaseSeconds, batchSize });
          return options.leases ?? [];
        },
        completeGeneration: async (input: { itemId: string; objectKey: string }) => {
          completed.push({ itemId: input.itemId, objectKey: input.objectKey });
          return true;
        },
        failGeneration: async (_workspace: string, id: string, _leaseToken: string, error: string) => {
          failures.push({ itemId: id, error });
          return true;
        },
      },
    },
    objectStore: {
      putProjectAsset: async (input: {
        assetKey: string; extension: string; contentType: string; content: Buffer;
      }) => {
        stored.push({
          assetKey: input.assetKey,
          extension: input.extension,
          contentType: input.contentType,
          bytes: input.content.length,
        });
        return Object.freeze({
          bucket: "assets",
          key: `workspaces/${workspaceId}/projects/${projectId}/assets/${input.assetKey}.${input.extension}`,
          sha256: `sha256:${"0".repeat(64)}`,
          sizeBytes: input.content.length,
        });
      },
    },
    secrets: {
      readApiKey: async () => options.apiKey === undefined ? "sk-test-key" : options.apiKey,
    },
    fetchImpl: options.fetchImpl,
    codexImageRunner: options.codexImageRunner,
  };
  return { dependencies: dependencies as never, stored, completed, failures, claims };
}

/** A DALL-E response carrying the given bytes base64-encoded. */
function dalleResponse(content: Buffer): typeof globalThis.fetch {
  return (async () => new Response(
    JSON.stringify({ data: [{ b64_json: content.toString("base64") }] }),
    { status: 200, headers: { "content-type": "application/json" } },
  )) as never;
}

describe("Asset generation batch", () => {
  it("generates a leased asset, stores it, then records it", async () => {
    const { dependencies, stored, completed, failures, claims } = harness({
      leases: [lease()],
      fetchImpl: dalleResponse(PNG),
    });
    const outcome = await runAssetGenerationBatch(dependencies);
    assert.deepEqual(outcome, { claimed: 1, generated: 1, failed: 0 });
    // Stored before recorded: a row pointing at a missing object would break the
    // build that reads it, whereas an orphaned object is swept with the project.
    assert.deepEqual(stored, [{
      assetKey: "sprites/player_idle", extension: "png", contentType: "image/png", bytes: PNG.length,
    }]);
    assert.equal(completed.length, 1);
    assert.match(completed[0].objectKey, /\/assets\/sprites\/player_idle\.png$/);
    assert.deepEqual(failures, []);
    // The lease has to outlive the slowest runtime backend or a running
    // generation gets re-claimed by the next sweep.
    assert.equal(claims[0].leaseSeconds >= 600, true);
  });

  it("does nothing when the selected Agent connection has no image model or credential", async () => {
    const withoutSettings = harness({ leases: [lease()], imageSettings: null });
    assert.deepEqual(
      await runAssetGenerationBatch(withoutSettings.dependencies),
      { claimed: 0, generated: 0, failed: 0 },
    );
    // Claiming without a credential would flip items to 'generating' and burn an
    // attempt against a call that can never be made.
    assert.deepEqual(withoutSettings.claims, []);

    const withoutImageModel = harness({
      leases: [lease()],
      imageSettings: Object.freeze({ ...settings, imageModel: null }),
    });
    assert.deepEqual(
      await runAssetGenerationBatch(withoutImageModel.dependencies),
      { claimed: 0, generated: 0, failed: 0 },
    );
    assert.deepEqual(withoutImageModel.claims, []);

    const withoutKey = harness({ leases: [lease()], apiKey: null });
    assert.deepEqual(
      await runAssetGenerationBatch(withoutKey.dependencies),
      { claimed: 0, generated: 0, failed: 0 },
    );
    assert.deepEqual(withoutKey.claims, []);
  });

  it("selects Codex built-in ImageGen from the active runtime", async () => {
    const codexSettings: StoredInstanceAgentSettings = Object.freeze({
      ...settings,
      agentRuntime: "CODEX_CLI",
      baseUrl: "https://chatgpt.com",
      primaryModel: "gpt-5.6-sol",
      imageModel: null,
      apiKeyMask: "cod********json",
    });
    const observed: Array<{ baseUrl: string; credential: string; model: string; prompt: string }> = [];
    const { dependencies, completed, claims } = harness({
      leases: [lease()],
      imageSettings: codexSettings,
      apiKey: JSON.stringify({ tokens: { access_token: "test-token" } }),
      codexImageRunner: async input => {
        observed.push(input);
        return PNG;
      },
    });
    assert.deepEqual(await runAssetGenerationBatch(dependencies), {
      claimed: 1, generated: 1, failed: 0,
    });
    assert.equal(completed.length, 1);
    assert.equal(claims[0].batchSize, 1);
    assert.equal(observed[0].model, "gpt-5.6-sol");
    assert.match(observed[0].prompt, /pixel art character idle/);
    assert.equal(observed[0].baseUrl, "https://chatgpt.com");
    assert.match(observed[0].credential, /test-token/);
  });

  it("records a provider failure against the item and keeps going", async () => {
    const { dependencies, stored, completed, failures } = harness({
      leases: [lease({ itemId: "item-a" }), lease({ itemId: "item-b", assetKey: "ui/button" })],
      fetchImpl: (async (url: string) => url.includes("images/generations")
        ? new Response("{}", { status: 429 })
        : new Response("{}", { status: 200 })) as never,
    });
    const outcome = await runAssetGenerationBatch(dependencies);
    // One asset failing must not abandon the rest of the batch.
    assert.deepEqual(outcome, { claimed: 2, generated: 0, failed: 2 });
    assert.deepEqual(stored, []);
    assert.deepEqual(completed, []);
    assert.deepEqual(failures.map(failure => failure.itemId), ["item-a", "item-b"]);
    // The status reaches the user; the response body never does, because a provider
    // echoing the request could put the credential into it.
    for (const failure of failures) {
      assert.match(failure.error, /Provider 429/);
      assert.doesNotMatch(failure.error, /sk-test-key/);
    }
  });

  it("rejects a response whose bytes are not a supported image", async () => {
    const { dependencies, stored, failures } = harness({
      leases: [lease()],
      fetchImpl: dalleResponse(Buffer.from("<!doctype html><html>nope</html>")),
    });
    const outcome = await runAssetGenerationBatch(dependencies);
    assert.deepEqual(outcome, { claimed: 1, generated: 0, failed: 1 });
    // Nothing reaches the bucket: the type is decided by the magic number, so a
    // provider cannot get an arbitrary file in by lying in a header.
    assert.deepEqual(stored, []);
    assert.equal(failures.length, 1);
  });

  it("stops between items once aborted, leaving the rest to their lease expiry", async () => {
    const controller = new AbortController();
    const { dependencies, completed } = harness({
      leases: [lease({ itemId: "item-a" }), lease({ itemId: "item-b" })],
      fetchImpl: (async () => {
        controller.abort();
        return new Response(
          JSON.stringify({ data: [{ b64_json: PNG.toString("base64") }] }),
          { status: 200 },
        );
      }) as never,
    });
    const outcome = await runAssetGenerationBatch(dependencies, controller.signal);
    assert.equal(outcome.claimed, 2);
    assert.equal(completed.length, 1);
  });
});

describe("Image generation provider calls", () => {
  it("restates the Agent's separate constraints in the prompt", () => {
    const prompt = composeImagePrompt({
      assetKey: "sprites/player_idle",
      assetType: "animation",
      description: "Player idle animation",
      generationPrompt: "pixel art character idle",
      dimensions: "32x32",
      frameCount: 4,
    });
    // The Agent expresses frame count and size as fields; a model only honours them
    // if they are in the prompt text.
    assert.match(prompt, /pixel art character idle/);
    assert.match(prompt, /Exactly 4 animation frames/);
    assert.match(prompt, /32x32/);
    assert.match(prompt, /transparent background/i);
    assert.match(prompt, /No text, no watermark/);
  });

  it("omits the frame instruction for a single-frame asset", () => {
    const prompt = composeImagePrompt({
      assetKey: "backgrounds/menu",
      assetType: "background",
      description: "Menu backdrop",
      generationPrompt: "painted fantasy landscape",
      dimensions: null,
      frameCount: null,
    });
    assert.doesNotMatch(prompt, /animation frames/);
    // A background is meant to be opaque, so it must not be asked for transparency.
    assert.doesNotMatch(prompt, /transparent background/i);
  });

  it("maps an asset aspect ratio onto a size the provider accepts", async () => {
    const requested: string[] = [];
    const fetchImpl = (async (_url: string, init: RequestInit) => {
      requested.push(JSON.parse(String(init.body)).size);
      return new Response(JSON.stringify({ data: [{ b64_json: PNG.toString("base64") }] }), { status: 200 });
    }) as never;
    const target = { baseUrl: "https://api.example.com/v1", model: "gpt-image-1", apiKey: "k" };
    const request = {
      assetKey: "a", assetType: "sprite", description: "d", generationPrompt: "p", frameCount: null,
    };
    // A 32x32 sprite is not a size DALL-E accepts, so it is requested at the
    // nearest supported aspect and downscaled by the game's importer.
    await generateAssetImage(target, { ...request, dimensions: "32x32" }, fetchImpl);
    await generateAssetImage(target, { ...request, dimensions: "1920x1080" }, fetchImpl);
    await generateAssetImage(target, { ...request, dimensions: "512x1024" }, fetchImpl);
    assert.deepEqual(requested, ["1024x1024", "1536x1024", "1024x1536"]);
  });

  it("requires the selected connection to return image bytes inline", async () => {
    await assert.rejects(
      () => generateAssetImage(
        { baseUrl: "https://api.example.com/v1", model: "gpt-image-1", apiKey: "k" },
        {
          assetKey: "a", assetType: "sprite", description: "d",
          generationPrompt: "p", dimensions: null, frameCount: null,
        },
        (async () => new Response("{}", { status: 200 })) as never,
      ),
      /未返回图像数据/,
    );
  });

  it("uses the selected connection endpoint, credential, and sole image model", async () => {
    let observedUrl = "";
    let observedAuthorization = "";
    let observedModel = "";
    await generateAssetImage(
      { baseUrl: "https://gateway.example.com/provider", model: "studio-image", apiKey: "secret" },
      {
        assetKey: "a", assetType: "sprite", description: "d",
        generationPrompt: "p", dimensions: null, frameCount: null,
      },
      (async (input: RequestInfo | URL, init?: RequestInit) => {
        observedUrl = String(input);
        observedAuthorization = new Headers(init?.headers).get("authorization") ?? "";
        observedModel = (JSON.parse(String(init?.body)) as { model: string }).model;
        return new Response(JSON.stringify({ data: [{ b64_json: PNG.toString("base64") }] }), { status: 200 });
      }) as never,
    );
    assert.equal(observedUrl, "https://gateway.example.com/provider/v1/images/generations");
    assert.equal(observedAuthorization, "Bearer secret");
    assert.equal(observedModel, "studio-image");
  });

  it("identifies images by magic number, not by the declared content type", () => {
    assert.equal(sniffContentType(PNG), "image/png");
    assert.equal(sniffContentType(JPEG), "image/jpeg");
    assert.equal(sniffContentType(WEBP), "image/webp");
    assert.equal(sniffContentType(Buffer.from("GIF89a")), null);
    assert.equal(sniffContentType(Buffer.alloc(0)), null);
    // Only what the upload route accepts and Godot imports unconfigured.
    assert.equal(generatedImageExtension("image/png"), "png");
    assert.equal(generatedImageExtension("image/gif"), null);
    assert.equal(generatedImageExtension("application/octet-stream"), null);
  });
});
