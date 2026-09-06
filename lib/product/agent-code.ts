export type AgentContentBlock = Readonly<{
  kind: "text" | "code";
  offset: number;
  content: string;
  filename?: string;
  language?: string;
}>;

/** Keep command output bounded in the UI, including source reads without Markdown fences. */
export function commandOutputMarkdown(command: string, content: string): string {
  const shell = command.match(/^\/bin\/(?:ba|z)?sh\s+-lc\s+([\s\S]+)$/u)?.[1] ?? command;
  const unwrapped = shell.replace(/^(['"])([\s\S]*)\1$/u, "$2");
  const paths = [...unwrapped.matchAll(/"([^"\n]*)"|'([^'\n]*)'|([^\s;|&<>]+)/gu)]
    .map(match => match[1] ?? match[2] ?? match[3] ?? "")
    .filter(isFilename);
  const filename = [...new Set(paths)].join(" · ");
  // A command can contain several reads with no output separators. Preserve
  // their names together instead of inventing a per-file attribution.
  const title = filename ? ` filename=${JSON.stringify(filename)}` : "";
  let longestFence = 2;
  for (const match of content.matchAll(/`+/gu)) longestFence = Math.max(longestFence, match[0].length);
  const fence = "`".repeat(longestFence + 1);
  return `\n${fence}output${title}\n${content}${content.endsWith("\n") ? "" : "\n"}${fence}\n`;
}

/** Parse complete and still-streaming fenced code without interpreting HTML. */
export function agentContentBlocks(value: string): readonly AgentContentBlock[] {
  const blocks: AgentContentBlock[] = [];
  const lines = value.match(/[^\n]*\n|[^\n]+$/gu) ?? [];
  let offset = 0;
  let textOffset = 0;
  let text = "";
  let code: { offset: number; fence: string; filename?: string; language?: string; content: string } | null = null;
  const flushText = () => {
    if (text.trim()) blocks.push({ kind: "text", offset: textOffset, content: text });
    text = "";
  };
  for (const line of lines) {
    if (code) {
      const closing = line.match(/^ {0,3}([`~]+)\s*$/u)?.[1];
      if (closing && closing.length >= code.fence.length && [...closing].every(character => character === code!.fence[0])) {
        blocks.push({ kind: "code", ...code });
        code = null;
        textOffset = offset + line.length;
      } else {
        code.content += line;
      }
    } else {
      const opening = line.match(/^ {0,3}(`{3,}|~{3,})([^\r\n]*)\r?\n?$/u);
      if (opening) {
        const info = opening[2]!.trim();
        const language = info.split(/\s/u, 1)[0] || undefined;
        const metadata = info.match(/\b(?:filename|file|path|title)=(?:"([^"\n]+)"|'([^'\n]+)'|(\S+))/u);
        let filename = metadata ? metadata[1] ?? metadata[2] ?? metadata[3] : undefined;
        filename ??= info.split(/\s+/u).find(isFilename);
        const previousLine = text.trimEnd().split("\n").at(-1) ?? "";
        const previousFilename = previousLine.trim()
          .replace(/^#{1,6}\s+/u, "")
          .replace(/^[*`]+|[*`]+$/gu, "")
          .replace(/^(?:文件(?:名)?|File(?:name)?)\s*[:：]\s*/iu, "")
          .replace(/^`|`$|[:：]$/gu, "");
        const explicitLabel = /^(?:#{1,6}\s|[*`]|(?:文件(?:名)?|File(?:name)?)\s*[:：])/iu.test(previousLine.trim());
        if (isFilename(previousFilename) && (explicitLabel || !/\s/u.test(previousFilename)) && (!filename || filename === previousFilename)) {
          filename = previousFilename;
          text = text.trimEnd().slice(0, -previousLine.length);
        }
        flushText();
        code = { offset, fence: opening[1]!, filename, language: language && !isFilename(language) ? language : undefined, content: "" };
      } else {
        if (!text) textOffset = offset;
        text += line;
      }
    }
    offset += line.length;
  }
  if (code) blocks.push({ kind: "code", ...code });
  else flushText();
  return blocks;
}

function isFilename(value: string): boolean {
  return /^(?:res:\/\/)?[\p{L}\p{N}_@./\\()+ -]*[\p{L}\p{N}_@()-]\.[a-zA-Z][a-zA-Z0-9]{0,15}$/u.test(value)
    || /^(?:[\p{L}\p{N}_./-]+\/)?(?:Dockerfile|Makefile|\.gitignore|\.env)$/u.test(value);
}
