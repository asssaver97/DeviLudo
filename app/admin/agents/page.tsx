import type { Metadata } from "next";
import AgentAdminDashboard from "@/components/admin/AgentAdminDashboard";

export const metadata: Metadata = {
  title: "Agent 运维台 · DeviLudo",
  description: "管理 DeviLudo 开发 Agent、版本、部署、Provider 与配置继承。",
};

export default function AgentAdminPage() {
  return <AgentAdminDashboard />;
}
