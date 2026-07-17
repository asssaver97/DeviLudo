import type { SVGProps } from "react";

type IconProps = SVGProps<SVGSVGElement>;

function IconBase({ children, ...props }: IconProps) {
  return (
    <svg
      aria-hidden="true"
      fill="none"
      height="20"
      viewBox="0 0 24 24"
      width="20"
      {...props}
    >
      {children}
    </svg>
  );
}

const stroke = {
  stroke: "currentColor",
  strokeLinecap: "round" as const,
  strokeLinejoin: "round" as const,
  strokeWidth: 1.8,
};

export function GridIcon(props: IconProps) {
  return (
    <IconBase {...props}>
      <path d="M4 4h6v6H4zM14 4h6v6h-6zM4 14h6v6H4zM14 14h6v6h-6z" {...stroke} />
    </IconBase>
  );
}

export function SparkIcon(props: IconProps) {
  return (
    <IconBase {...props}>
      <path d="m12 3 1.35 4.65L18 9l-4.65 1.35L12 15l-1.35-4.65L6 9l4.65-1.35L12 3Z" {...stroke} />
      <path d="m18.5 15 .65 2.35L21.5 18l-2.35.65L18.5 21l-.65-2.35L15.5 18l2.35-.65.65-2.35Z" {...stroke} />
    </IconBase>
  );
}

export function GamepadIcon(props: IconProps) {
  return (
    <IconBase {...props}>
      <path d="M8.5 8h7c3.2 0 5.2 2.7 4.4 5.8l-.7 2.7a2.6 2.6 0 0 1-4.3 1.2L13.1 16h-2.2l-1.8 1.7a2.6 2.6 0 0 1-4.3-1.2l-.7-2.7C3.3 10.7 5.3 8 8.5 8Z" {...stroke} />
      <path d="M8 11v4M6 13h4M16.5 11.5h.01M18 14h.01" {...stroke} />
    </IconBase>
  );
}

export function ServerIcon(props: IconProps) {
  return (
    <IconBase {...props}>
      <rect height="6" rx="1.5" width="18" x="3" y="4" {...stroke} />
      <rect height="6" rx="1.5" width="18" x="3" y="14" {...stroke} />
      <path d="M7 7h.01M7 17h.01M11 7h6M11 17h6" {...stroke} />
    </IconBase>
  );
}

export function ShieldIcon(props: IconProps) {
  return (
    <IconBase {...props}>
      <path d="M12 3 5 6v5c0 4.4 2.7 8.2 7 10 4.3-1.8 7-5.6 7-10V6l-7-3Z" {...stroke} />
      <path d="m9 12 2 2 4-4" {...stroke} />
    </IconBase>
  );
}

export function LinkIcon(props: IconProps) {
  return (
    <IconBase {...props}>
      <path d="m10 13.5 4-4M8.5 16.5l-1 1a3.5 3.5 0 0 1-5-5l3-3a3.5 3.5 0 0 1 5 0M15.5 7.5l1-1a3.5 3.5 0 0 1 5 5l-3 3a3.5 3.5 0 0 1-5 0" {...stroke} />
    </IconBase>
  );
}

export function FileIcon(props: IconProps) {
  return (
    <IconBase {...props}>
      <path d="M6 3h8l4 4v14H6zM14 3v5h4M9 13h6M9 17h4" {...stroke} />
    </IconBase>
  );
}

export function ArrowIcon(props: IconProps) {
  return (
    <IconBase {...props}>
      <path d="M5 12h14M14 7l5 5-5 5" {...stroke} />
    </IconBase>
  );
}

export function PlusIcon(props: IconProps) {
  return (
    <IconBase {...props}>
      <path d="M12 5v14M5 12h14" {...stroke} />
    </IconBase>
  );
}

export function CheckIcon(props: IconProps) {
  return (
    <IconBase {...props}>
      <path d="m5 12 4 4L19 6" {...stroke} />
    </IconBase>
  );
}

export function GithubIcon(props: IconProps) {
  return (
    <IconBase {...props}>
      <path d="M15 21v-3.5c.1-1-.4-2-1-2.5 3 0 6-1.5 6-6.5.08-1.6-.5-3.1-1.6-4.2.45-1.3.4-2.7-.1-4 0 0-1.2-.4-4.3 1.6a14.7 14.7 0 0 0-7.8 0C3.1-.1 1.9.3 1.9.3a5.7 5.7 0 0 0-.1 4A6.1 6.1 0 0 0 .2 8.5C.2 15 3.2 16 6.2 16c-.5.45-.85 1.1-1 1.8-.45.25-1.65.7-2.4-.7-.45-.8-1.25-.85-1.25-.85" {...stroke} />
      <path d="M9 21v-3.5c0-.9-.4-1.8-1-2.5" {...stroke} />
    </IconBase>
  );
}

export function SteamIcon(props: IconProps) {
  return (
    <IconBase {...props}>
      <circle cx="15.5" cy="8.5" r="3.5" {...stroke} />
      <circle cx="6.5" cy="16.5" r="2.5" {...stroke} />
      <path d="m8.7 15.3 4.2-3.7M4.4 15.1 2 14M8.5 18l2 1" {...stroke} />
    </IconBase>
  );
}

export function BellIcon(props: IconProps) {
  return (
    <IconBase {...props}>
      <path d="M18 9a6 6 0 0 0-12 0c0 7-3 7-3 7h18s-3 0-3-7M10 20h4" {...stroke} />
    </IconBase>
  );
}

export function ClockIcon(props: IconProps) {
  return (
    <IconBase {...props}>
      <circle cx="12" cy="12" r="9" {...stroke} />
      <path d="M12 7v5l3 2" {...stroke} />
    </IconBase>
  );
}
