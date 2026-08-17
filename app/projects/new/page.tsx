import type { Metadata } from "next";
import { ProductDashboard } from "@/components/ProductDashboard";
import { localizedMetadata } from "@/lib/web/localized-metadata";

export async function generateMetadata(): Promise<Metadata> {
  return localizedMetadata("新游戏构想 · DeviLudo", "New Game Concept · DeviLudo");
}

export default function NewProjectPage() { return <ProductDashboard creationOnly />; }
