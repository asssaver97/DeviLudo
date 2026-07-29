import type { Metadata } from "next";
import { HomeChat } from "@/components/HomeChat";

export const metadata: Metadata = { title: "首页 · DeviLudo" };

export default function HomePage() { return <HomeChat />; }
