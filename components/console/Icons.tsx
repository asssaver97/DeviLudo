import type { ReactNode, SVGProps } from "react";

type IconProps = SVGProps<SVGSVGElement>;
const stroke = { stroke: "currentColor", strokeLinecap: "round" as const, strokeLinejoin: "round" as const, strokeWidth: 1.8 };

function IconBase({ children, ...props }: IconProps & { children?: ReactNode }) {
  return <svg aria-hidden="true" fill="none" height="20" viewBox="0 0 24 24" width="20" {...props}>{children}</svg>;
}

export function SparkIcon(props: IconProps) {
  return <IconBase {...props}><path d="m12 3 1.35 4.65L18 9l-4.65 1.35L12 15l-1.35-4.65L6 9l4.65-1.35L12 3Z" {...stroke} /><path d="m18.5 15 .65 2.35L21.5 18l-2.35.65L18.5 21l-.65-2.35L15.5 18l2.35-.65.65-2.35Z" {...stroke} /></IconBase>;
}

export function GamepadIcon(props: IconProps) {
  return <IconBase {...props}><path d="M8.5 8h7c3.2 0 5.2 2.7 4.4 5.8l-.7 2.7a2.6 2.6 0 0 1-4.3 1.2L13.1 16h-2.2l-1.8 1.7a2.6 2.6 0 0 1-4.3-1.2l-.7-2.7C3.3 10.7 5.3 8 8.5 8Z" {...stroke} /><path d="M8 11v4M6 13h4M16.5 11.5h.01M18 14h.01" {...stroke} /></IconBase>;
}

export function ShieldIcon(props: IconProps) {
  return <IconBase {...props}><path d="M12 3 5 6v5c0 4.4 2.7 8.2 7 10 4.3-1.8 7-5.6 7-10V6l-7-3Z" {...stroke} /><path d="m9 12 2 2 4-4" {...stroke} /></IconBase>;
}

export function ServerIcon(props: IconProps) {
  return <IconBase {...props}><rect height="6" rx="1" width="18" x="3" y="4" {...stroke} /><rect height="6" rx="1" width="18" x="3" y="14" {...stroke} /><path d="M7 7h.01M7 17h.01M11 7h6M11 17h6" {...stroke} /></IconBase>;
}

export function BellIcon(props: IconProps) {
  return <IconBase {...props}><path d="M18 9a6 6 0 0 0-12 0c0 7-3 7-3 7h18s-3 0-3-7M10 20h4" {...stroke} /></IconBase>;
}

export function PlusIcon(props: IconProps) {
  return <IconBase {...props}><path d="M12 5v14M5 12h14" {...stroke} /></IconBase>;
}

export function ArrowIcon(props: IconProps) {
  return <IconBase {...props}><path d="M5 12h14M14 7l5 5-5 5" {...stroke} /></IconBase>;
}
