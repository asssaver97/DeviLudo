import type { Metadata } from "next";
import { ProductDashboard } from "@/components/ProductDashboard";
import { localizedMetadata } from "@/lib/web/localized-metadata";

export async function generateMetadata(): Promise<Metadata> {
  return localizedMetadata("导入已有项目 · DeviLudo", "Import Existing Project · DeviLudo");
}

export default function ImportProjectPage() {
  return <ProductDashboard creationOnly initialMode="IMPORT" />;
}
