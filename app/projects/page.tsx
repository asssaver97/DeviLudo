import type { Metadata } from "next";
import { ProjectCatalog } from "@/components/console/ProjectCatalog";

export const metadata: Metadata = { title: "游戏项目" };
export default function Page() { return <ProjectCatalog />; }
