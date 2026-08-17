import type { Metadata } from "next";
import { ProductDashboard } from "@/components/ProductDashboard";
import { localizedMetadata } from "@/lib/web/localized-metadata";

export async function generateMetadata(): Promise<Metadata> {
  return localizedMetadata("关联项目 · DeviLudo", "Link Project · DeviLudo");
}

export default function ImportProjectPage() {
  return <ProductDashboard creationOnly initialMode="IMPORT" />;
}
