"use client";

import { useLanguage } from "../i18n/LanguageProvider";

export function TypingDots() {
  const { text } = useLanguage();
  return (
    <span aria-label={text("等待回复", "Waiting for reply")} className="typing-dots" role="status">
      <i />
      <i />
      <i />
    </span>
  );
}
