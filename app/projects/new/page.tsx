import type { Metadata } from "next";
import { NewProjectEntry } from "@/components/console/NewProjectEntry";

export const metadata: Metadata = {
  title: "新游戏构想",
  description: "通过多轮对话把游戏构想转化为可批准、可测试的规格。",
};

export default function NewProjectPage() {
  return <NewProjectEntry />;
}
