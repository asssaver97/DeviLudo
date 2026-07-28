import type { Metadata } from "next";
import AgentAdminDashboard from "@/components/admin/AgentAdminDashboard";
import { accountPlatformSessionFromRequest } from "@/lib/auth/account-platform";
import { platformManagedConfiguration } from "@/lib/config/platform-managed";
import { headers } from "next/headers";
import { notFound } from "next/navigation";

export const metadata: Metadata = {
  title: "Agent 运维台 · DeviLudo",
  description: "管理 DeviLudo 开发 Agent、版本、部署、Provider 与配置继承。",
};

export default async function AgentAdminPage() {
  if (platformManagedConfiguration()) {
    try {
      const incoming = new Headers(await headers());
      const session = await accountPlatformSessionFromRequest(new Request("http://deviludo.local/admin/agents", { headers: incoming }));
      if (!session?.platformAdminRoles.length) notFound();
    } catch { notFound(); }
  }
  return <AgentAdminDashboard />;
}
