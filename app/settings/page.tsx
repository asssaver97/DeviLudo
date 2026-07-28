import type { Metadata } from "next";
import { SettingsHub } from "@/components/console/SettingsHub";

export const metadata: Metadata = { title: "设置", description: "集中管理账号连接、开发 Agent 和平台权限。" };

export default function SettingsPage() {
  return <SettingsHub />;
}
