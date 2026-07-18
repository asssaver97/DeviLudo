import type { Metadata } from "next";
import InvitationAdmin from "@/components/admin/InvitationAdmin";
import { AppShell } from "@/components/console/AppShell";

export const metadata: Metadata = { title: "受邀账号管理", description: "签发一次性、租户和角色绑定的 GitHub 登录邀请。" };

export default function InvitationsPage() {
  return <AppShell><InvitationAdmin /></AppShell>;
}
