import type { Metadata } from "next";
import { TenantAgentSettings } from "@/components/console/TenantAgentSettings";

export const metadata: Metadata = { title: "开发 Agent", description: "租户 Provider、BYOK 与默认 Agent 配置。" };
export default function TenantAgentSettingsPage() { return <TenantAgentSettings />; }
