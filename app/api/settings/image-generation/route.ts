import { NextResponse } from "next/server";
import { readFile, writeFile, access, constants } from "node:fs/promises";
import { join } from "node:path";
import type { ImageGenerationConfig } from "@/lib/product/asset-manifest";

const CONFIG_PATH = process.env.DEVILUDO_IMAGE_GEN_CONFIG_PATH || "/etc/deviludo/image-generation.json";

export async function GET() {
  try {
    // Check if config exists
    await access(CONFIG_PATH, constants.R_OK);
    const content = await readFile(CONFIG_PATH, "utf-8");
    const config: ImageGenerationConfig = JSON.parse(content);

    // Return config without exposing full API key
    return NextResponse.json({
      provider: config.provider,
      apiKey: config.apiKey ? "configured" : undefined,
      apiEndpoint: config.apiEndpoint,
      model: config.model,
      defaultParameters: config.defaultParameters,
    });
  } catch (error) {
    // No config file or not readable
    return NextResponse.json(null);
  }
}

export async function POST(request: Request) {
  try {
    const payload = await request.json();

    // Validate provider
    const validProviders = ["dalle-3", "stable-diffusion-xl", "midjourney", "replicate"];
    if (!validProviders.includes(payload.provider)) {
      return NextResponse.json({ error: "Invalid provider" }, { status: 400 });
    }

    // Load existing config if present
    let existingConfig: Partial<ImageGenerationConfig> = {};
    try {
      await access(CONFIG_PATH, constants.R_OK);
      const content = await readFile(CONFIG_PATH, "utf-8");
      existingConfig = JSON.parse(content);
    } catch {
      // No existing config
    }

    // Merge with existing, only update provided fields
    const newConfig: ImageGenerationConfig = {
      provider: payload.provider,
      apiKey: payload.apiKey || existingConfig.apiKey,
      apiEndpoint: payload.apiEndpoint || existingConfig.apiEndpoint,
      model: payload.model || existingConfig.model,
      defaultParameters: payload.defaultParameters || existingConfig.defaultParameters,
    };

    await writeFile(CONFIG_PATH, JSON.stringify(newConfig, null, 2), { mode: 0o600 });

    return NextResponse.json({ success: true });
  } catch (error) {
    console.error("Failed to save image generation config:", error);
    return NextResponse.json(
      { error: "Failed to save configuration" },
      { status: 500 }
    );
  }
}
