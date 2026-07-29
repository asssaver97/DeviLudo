import type { Metadata } from "next";
import { ProductDashboard } from "@/components/ProductDashboard";

export const metadata: Metadata = { title: "工作台 · DeviLudo" };

export default function HomePage() { return <ProductDashboard />; }
