import type { Metadata } from "next";
import { HomeChat } from "@/components/HomeChat";
import { localizedMetadata } from "@/lib/web/localized-metadata";

export async function generateMetadata(): Promise<Metadata> {
  return localizedMetadata("首页 · DeviLudo", "Home · DeviLudo");
}

export default function HomePage() { return <HomeChat />; }
