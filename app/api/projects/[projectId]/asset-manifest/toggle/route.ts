import { NextResponse } from "next/server";
import { pool } from "@/lib/server/database";
import { toggleAutoGenerate, getAssetManifest } from "@/services/core/src/asset-manifest";

export async function POST(
  request: Request,
  { params }: { params: { projectId: string } }
) {
  try {
    const { projectId } = params;
    const { enabled } = await request.json();

    if (typeof enabled !== "boolean") {
      return NextResponse.json({ error: "Invalid payload" }, { status: 400 });
    }

    const manifest = await getAssetManifest(pool, projectId);
    if (!manifest) {
      return NextResponse.json({ error: "Manifest not found" }, { status: 404 });
    }

    await toggleAutoGenerate(pool, manifest.id, enabled);

    return NextResponse.json({ success: true });
  } catch (error) {
    console.error("Failed to toggle auto-generate:", error);
    return NextResponse.json(
      { error: "Failed to update setting" },
      { status: 500 }
    );
  }
}
