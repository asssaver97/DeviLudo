export const runtime = "nodejs";
export const dynamic = "force-dynamic";

export async function GET(): Promise<Response> {
  const raw = process.env.DEVILUDO_LOCAL_GIT_IMPORT_PUBLIC_URL?.trim() ?? "";
  if (!raw) return Response.json({ available: false }, { headers: { "cache-control": "no-store" } });
  try {
    const url = new URL(raw);
    if (url.protocol !== "http:" || !["127.0.0.1", "localhost"].includes(url.hostname)
      || url.username || url.password || url.pathname !== "/" || url.search || url.hash) {
      throw new Error("invalid local Git import URL");
    }
    return Response.json(
      { available: true, url: url.href.replace(/\/$/, "") },
      { headers: { "cache-control": "no-store" } },
    );
  } catch {
    return Response.json({ available: false }, { headers: { "cache-control": "no-store" } });
  }
}
