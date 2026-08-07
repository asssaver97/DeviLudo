import { NextResponse } from "next/server";
import { writeFile, mkdir } from "node:fs/promises";
import { join } from "node:path";
import { pool } from "@/lib/server/database";
import { getAssetManifest, updateAssetItemStatus } from "@/services/core/src/asset-manifest";
import { uploadObject } from "@/lib/server/storage";
import type { AssetItem } from "@/lib/product/asset-manifest";

export async function POST(
  request: Request,
  { params }: { params: { projectId: string } }
) {
  try {
    const { projectId } = params;
    const formData = await request.formData();
    const file = formData.get("file") as File | null;
    const assetKey = formData.get("assetKey") as string | null;

    if (!file || !assetKey) {
      return NextResponse.json({ error: "Missing file or assetKey" }, { status: 400 });
    }

    const manifest = await getAssetManifest(pool, projectId, true);
    if (!manifest) {
      return NextResponse.json({ error: "Manifest not found" }, { status: 404 });
    }

    const item = manifest.items?.find((i: AssetItem) => i.assetKey === assetKey);
    if (!item) {
      return NextResponse.json({ error: "Asset item not found" }, { status: 404 });
    }

    // Upload to S3/MinIO
    const buffer = Buffer.from(await file.arrayBuffer());
    const objectKey = `workspaces/${manifest.workspaceId}/projects/${projectId}/assets/${assetKey}.png`;

    await uploadObject(objectKey, buffer, file.type);

    // Update database
    await updateAssetItemStatus(pool, item.id, "uploaded", objectKey);

    return NextResponse.json({ success: true, objectKey });
  } catch (error) {
    console.error("Failed to upload asset:", error);
    return NextResponse.json(
      { error: "Failed to upload asset" },
      { status: 500 }
    );
  }
}
