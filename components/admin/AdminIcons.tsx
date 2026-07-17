import type { SVGProps } from "react";

export type AdminIconName =
  | "agents"
  | "activity"
  | "projects"
  | "runners"
  | "releases"
  | "shield"
  | "audit"
  | "settings"
  | "search"
  | "bell"
  | "chevron"
  | "check"
  | "refresh"
  | "external"
  | "key"
  | "git"
  | "server"
  | "layers"
  | "more"
  | "alert"
  | "close";

const paths: Record<AdminIconName, React.ReactNode> = {
  agents: <><path d="M7 10a3 3 0 1 0 0-6 3 3 0 0 0 0 6Z"/><path d="M17 10a3 3 0 1 0 0-6 3 3 0 0 0 0 6ZM2.5 20v-2a4 4 0 0 1 4-4h1a4 4 0 0 1 4 4v2M14 20v-2a4 4 0 0 1 4-4h.5a3 3 0 0 1 3 3v3"/></>,
  activity: <path d="M3 12h4l2.2-7 4 14 2.2-7H21" />,
  projects: <><path d="M4 5.5h6l2 2h8v11H4z"/><path d="M4 9h16"/></>,
  runners: <><rect x="4" y="3.5" width="16" height="7" rx="1"/><rect x="4" y="13.5" width="16" height="7" rx="1"/><path d="M8 7h.01M8 17h.01M12 7h5M12 17h5"/></>,
  releases: <><path d="M12 3v12M7 10l5 5 5-5"/><path d="M4 20h16"/></>,
  shield: <path d="M12 3 20 6v5c0 5-3.2 8.4-8 10-4.8-1.6-8-5-8-10V6z" />,
  audit: <><path d="M6 3h12v18H6z"/><path d="M9 8h6M9 12h6M9 16h4"/></>,
  settings: <><circle cx="12" cy="12" r="3"/><path d="M19 13.5v-3l-2-.7a7.5 7.5 0 0 0-.8-1.8l.9-1.9L15 4l-1.9.9a7.5 7.5 0 0 0-1.8-.8L10.5 2h-3l-.7 2a7.5 7.5 0 0 0-1.8.8L3.1 4 1 6.1 2 8a7.5 7.5 0 0 0-.8 1.8l-2 .7v3l2 .7A7.5 7.5 0 0 0 2 16l-1 1.9L3.1 20 5 19a7.5 7.5 0 0 0 1.8.8l.7 2h3l.7-2A7.5 7.5 0 0 0 13 19l1.9 1 2.1-2.1-1-1.9a7.5 7.5 0 0 0 .8-1.8z" transform="translate(3 0) scale(.75)"/></>,
  search: <><circle cx="10.5" cy="10.5" r="6.5"/><path d="m16 16 5 5"/></>,
  bell: <><path d="M6 9a6 6 0 0 1 12 0c0 7 3 7 3 8H3c0-1 3-1 3-8Z"/><path d="M10 21h4"/></>,
  chevron: <path d="m9 6 6 6-6 6" />,
  check: <path d="m5 12 4 4L19 6" />,
  refresh: <><path d="M20 6v5h-5"/><path d="M18.7 16A8 8 0 1 1 19 8l1 3"/></>,
  external: <><path d="M14 4h6v6M20 4l-9 9"/><path d="M18 13v7H4V6h7"/></>,
  key: <><circle cx="8" cy="12" r="4"/><path d="M12 12h9M18 12v3M15 12v2"/></>,
  git: <><circle cx="6" cy="5" r="2"/><circle cx="18" cy="19" r="2"/><circle cx="6" cy="19" r="2"/><path d="M6 7v10M8 5h4a6 6 0 0 1 6 6v6"/></>,
  server: <><rect x="3" y="4" width="18" height="6" rx="1"/><rect x="3" y="14" width="18" height="6" rx="1"/><path d="M7 7h.01M7 17h.01M11 7h7M11 17h7"/></>,
  layers: <><path d="m12 3 9 5-9 5-9-5z"/><path d="m3 12 9 5 9-5M3 16l9 5 9-5"/></>,
  more: <><circle cx="5" cy="12" r="1" fill="currentColor" stroke="none"/><circle cx="12" cy="12" r="1" fill="currentColor" stroke="none"/><circle cx="19" cy="12" r="1" fill="currentColor" stroke="none"/></>,
  alert: <><path d="M12 3 2.5 20h19z"/><path d="M12 9v4M12 17h.01"/></>,
  close: <path d="m6 6 12 12M18 6 6 18" />,
};

export function AdminIcon({ name, ...props }: { name: AdminIconName } & SVGProps<SVGSVGElement>) {
  return (
    <svg viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="1.7" strokeLinecap="round" strokeLinejoin="round" aria-hidden="true" {...props}>
      {paths[name]}
    </svg>
  );
}
