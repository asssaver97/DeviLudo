import type { Metadata } from "next";
import { ProductDashboard } from "@/components/ProductDashboard";

export const metadata: Metadata = { title: "新游戏构想 · DeviLudo" };

export default function NewProjectPage() { return <ProductDashboard creationOnly />; }
