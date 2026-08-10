import type { Metadata } from "next";
import { ProductDashboard } from "@/components/ProductDashboard";

export const metadata: Metadata = { title: "关联项目 · DeviLudo" };

export default function ImportProjectPage() {
  return <ProductDashboard creationOnly initialMode="IMPORT" />;
}
