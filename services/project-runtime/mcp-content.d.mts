export type ProjectToolContent = Readonly<{
  type: "text" | "image";
  text?: string;
  data?: string;
  mimeType?: string;
}>;

export function formatProjectToolResult(result: unknown): Readonly<{
  content: readonly ProjectToolContent[];
  structuredContent?: Readonly<Record<string, unknown>>;
}>;
