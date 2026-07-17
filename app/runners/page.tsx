import type { Metadata } from "next";
import { RunnersPage } from "@/components/console/ResourcePages";

export const metadata: Metadata = { title: "运行节点" };
export default function Page() { return <RunnersPage />; }
