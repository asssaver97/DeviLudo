import { NextResponse } from "next/server";
import { pool } from "@/lib/server/database";
import { checkAssetCompletion, getAssetManifest } from "@/services/core/src/asset-manifest";

export async function GET(
  request: Request,
  { params }: { params: { projectId: string } }
) {
  try {
    const { projectId } = params;

    const manifest = await getAssetManifest(pool, projectId, true);
    if (!manifest) {
      return NextResponse.json({ manifest: null, items: [], completion: null });
    }

    const completion = await checkAssetCompletion(pool, manifest.id);

    return NextResponse.json({
      manifest,
      items: manifest.items || [],
      completion,
    });
  } catch (error) {
    console.error("Failed to get asset manifest:", error);
    return NextResponse.json(
      { error: "Failed to load asset manifest" },
      { status: 500 }
    );
  }
}
