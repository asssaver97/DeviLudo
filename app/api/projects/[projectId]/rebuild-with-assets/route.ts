import { NextResponse } from "next/server";
import { pool } from "@/lib/server/database";
import { checkAssetCompletion, getAssetManifest } from "@/services/core/src/asset-manifest";
import { enqueueDelivery } from "@/services/core/src/delivery";

export async function POST(
  request: Request,
  { params }: { params: { projectId: string } }
) {
  try {
    const { projectId } = params;

    const manifest = await getAssetManifest(pool, projectId);
    if (!manifest) {
      return NextResponse.json({ error: "Manifest not found" }, { status: 404 });
    }

    const completion = await checkAssetCompletion(pool, manifest.id);
    if (!completion.complete) {
      return NextResponse.json(
        { error: "Assets not complete", completion },
        { status: 400 }
      );
    }

    // Enqueue a new build workflow with assets
    // This would trigger the build stage with asset integration
    await enqueueDelivery(pool, manifest.workspaceId, projectId, "VALIDATE", ["macos"], true);

    return NextResponse.json({ success: true });
  } catch (error) {
    console.error("Failed to trigger rebuild:", error);
    return NextResponse.json(
      { error: "Failed to start rebuild" },
      { status: 500 }
    );
  }
}
