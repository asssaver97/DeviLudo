import type { Metadata } from "next";
import { cookies } from "next/headers";

export async function localizedMetadata(
  chineseTitle: string,
  englishTitle: string,
  chineseDescription?: string,
  englishDescription?: string,
): Promise<Metadata> {
  const english = (await cookies()).get("deviludo_locale")?.value !== "zh";
  return {
    title: english ? englishTitle : chineseTitle,
    ...(chineseDescription && englishDescription
      ? { description: english ? englishDescription : chineseDescription }
      : {}),
  };
}
