"use client";

import { useMemo } from "react";
import { agentContentBlocks } from "@/lib/product/agent-code";
import { useLanguage } from "../i18n/LanguageProvider";

export function AgentMessageContent({ content }: Readonly<{ content: string }>) {
  const { text } = useLanguage();
  const blocks = useMemo(() => agentContentBlocks(content), [content]);
  return <div className="conversation-agent-content">
    {blocks.map(block => block.kind === "text"
      ? <p key={block.offset}>{block.content}</p>
      : <details className="conversation-code-block" key={block.offset}>
        <summary aria-label={block.filename}>
          <span className="conversation-code-filename" title={block.filename}>
            {block.filename?.split(" · ").map(path => path.split(/[/\\]/u).at(-1)).join(" · ")
              ?? (block.language === "output" ? text("命令输出", "Command output") : text("代码", "Code"))}
          </span>
          <span className="conversation-code-lines">{text(`${lineCount(block.content)} 行`, `${lineCount(block.content)} lines`)}</span>
        </summary>
        <pre aria-label={block.filename ?? text("代码内容", "Code content")} tabIndex={0}><code>{block.content}</code></pre>
      </details>)}
  </div>;
}

function lineCount(content: string): number {
  return content ? content.split("\n").length - (content.endsWith("\n") ? 1 : 0) : 0;
}
