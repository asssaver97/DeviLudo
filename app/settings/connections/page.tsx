import type { Metadata } from "next";
import { ConnectionsPanel } from "@/components/console/ConnectionsPanel";

export const metadata: Metadata = { title: "账号连接", description: "安全连接 GitHub App 与 Steamworks 发布会话。" };

export default async function ConnectionsPage({
  searchParams,
}: {
  searchParams: Promise<Record<string, string | string[] | undefined>>;
}) {
  const query = await searchParams;
  return <ConnectionsPanel initialGitHubConnected={query.github === "connected"} />;
}
