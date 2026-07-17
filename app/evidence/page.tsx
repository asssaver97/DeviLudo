import type { Metadata } from "next";
import { EvidencePage } from "@/components/console/ResourcePages";

export const metadata: Metadata = { title: "证据中心" };
export default function Page() { return <EvidencePage />; }
