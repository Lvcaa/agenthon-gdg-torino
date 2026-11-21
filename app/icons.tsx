// Icone SVG inline (tratto Lucide-like): nessuna dipendenza esterna.
import type { ReactNode, SVGProps } from "react";

function Icon({ children, size = 16, ...props }: SVGProps<SVGSVGElement> & { size?: number; children: ReactNode }) {
  return (
    <svg
      width={size}
      height={size}
      viewBox="0 0 24 24"
      fill="none"
      stroke="currentColor"
      strokeWidth={1.8}
      strokeLinecap="round"
      strokeLinejoin="round"
      aria-hidden="true"
      {...props}
    >
      {children}
    </svg>
  );
}

type P = SVGProps<SVGSVGElement> & { size?: number };

export const IconUser = (p: P) => (
  <Icon {...p}>
    <circle cx="12" cy="8" r="4" />
    <path d="M4 21a8 8 0 0 1 16 0" />
  </Icon>
);
export const IconShield = (p: P) => (
  <Icon {...p}>
    <path d="M12 3 4 6v6c0 5 3.5 8 8 9 4.5-1 8-4 8-9V6l-8-3Z" />
    <path d="m9 12 2 2 4-4" />
  </Icon>
);
export const IconChart = (p: P) => (
  <Icon {...p}>
    <path d="M3 3v18h18" />
    <path d="M7 15v2M12 10v7M17 6v11" />
  </Icon>
);
export const IconSpark = (p: P) => (
  <Icon {...p}>
    <path d="M12 3v4M12 17v4M3 12h4M17 12h4" />
    <path d="m12 8 1.5 2.5L16 12l-2.5 1.5L12 16l-1.5-2.5L8 12l2.5-1.5L12 8Z" />
  </Icon>
);
export const IconSend = (p: P) => (
  <Icon {...p}>
    <path d="M5 12h14M13 6l6 6-6 6" />
  </Icon>
);
export const IconReset = (p: P) => (
  <Icon {...p}>
    <path d="M3 12a9 9 0 1 0 3-6.7L3 8" />
    <path d="M3 3v5h5" />
  </Icon>
);
export const IconCheck = (p: P) => (
  <Icon {...p}>
    <path d="m5 12 5 5L20 7" />
  </Icon>
);
export const IconX = (p: P) => (
  <Icon {...p}>
    <path d="M6 6l12 12M18 6 6 18" />
  </Icon>
);
export const IconDownload = (p: P) => (
  <Icon {...p}>
    <path d="M12 4v11M7 10l5 5 5-5M5 20h14" />
  </Icon>
);
export const IconUpload = (p: P) => (
  <Icon {...p}>
    <path d="M12 16V5M7 10l5-5 5 5M5 20h14" />
  </Icon>
);
export const IconFile = (p: P) => (
  <Icon {...p}>
    <path d="M14 3H7a2 2 0 0 0-2 2v14a2 2 0 0 0 2 2h10a2 2 0 0 0 2-2V8l-5-5Z" />
    <path d="M14 3v5h5M9 13h6M9 17h4" />
  </Icon>
);
export const IconReceipt = (p: P) => (
  <Icon {...p}>
    <path d="M6 3h12v18l-3-2-3 2-3-2-3 2V3Z" />
    <path d="M9 8h6M9 12h6" />
  </Icon>
);
export const IconQuote = (p: P) => (
  <Icon {...p}>
    <path d="M4 6h16M4 12h10M4 18h7" />
  </Icon>
);
export const IconAlert = (p: P) => (
  <Icon {...p}>
    <path d="M12 3 2 20h20L12 3Z" />
    <path d="M12 10v4M12 17h.01" />
  </Icon>
);
export const IconClock = (p: P) => (
  <Icon {...p}>
    <circle cx="12" cy="12" r="9" />
    <path d="M12 7v5l3 2" />
  </Icon>
);
export const IconArrow = (p: P) => (
  <Icon {...p}>
    <path d="M5 12h14M13 6l6 6-6 6" />
  </Icon>
);
export const IconTelegram = (p: P) => (
  <Icon {...p}>
    <path d="m21 4-18 7 6 2 2 6 3-4 5 4 2-15Z" />
    <path d="m9 13 8-6" />
  </Icon>
);
export const IconCar = (p: P) => (
  <Icon {...p}>
    <path d="M5 16V11l2-5h10l2 5v5" />
    <path d="M3 16h18v2H3zM7 19v1M17 19v1" />
    <circle cx="8" cy="13.5" r=".5" />
    <circle cx="16" cy="13.5" r=".5" />
  </Icon>
);
export const IconTrain = (p: P) => (
  <Icon {...p}>
    <rect x="6" y="3" width="12" height="14" rx="3" />
    <path d="M6 11h12M9 21l1.5-4M15 21l-1.5-4" />
  </Icon>
);
export const IconFood = (p: P) => (
  <Icon {...p}>
    <path d="M7 3v8a2 2 0 0 0 2 2v8M11 3v8a2 2 0 0 1-2 2M17 21V3c-2 1-3 4-3 7h3" />
  </Icon>
);
export const IconBed = (p: P) => (
  <Icon {...p}>
    <path d="M3 18V6M3 13h18v5M21 13a3 3 0 0 0-3-3h-7v3" />
    <circle cx="7" cy="10" r="1.5" />
  </Icon>
);
export const IconBox = (p: P) => (
  <Icon {...p}>
    <path d="m12 3 8 4.5v9L12 21l-8-4.5v-9L12 3Z" />
    <path d="m4 7.5 8 4.5 8-4.5M12 12v9" />
  </Icon>
);

// Etichetta categoria (già tradotta lato server) → icona.
export function CategoryIcon({ label, size = 18 }: { label: string; size?: number }) {
  const map: Record<string, (p: P) => ReactNode> = { Taxi: IconCar, Treno: IconTrain, Cibo: IconFood, Hotel: IconBed };
  const C = map[label] ?? IconBox;
  return <C size={size} />;
}

// Marchio Ask&Card: un omino che porta la carta aziendale sulle spalle.
export function Logo({ size = 28, title }: { size?: number; title?: string }) {
  return (
    <svg width={size} height={size} viewBox="0 0 32 32" fill="none" role={title ? "img" : undefined} aria-hidden={title ? undefined : true}>
      {title && <title>{title}</title>}
      <g transform="rotate(-8 16 9)">
        <rect x="4" y="2.5" width="24" height="13.5" rx="2.6" fill="#d8f26a" stroke="#16170f" strokeWidth="1.8" />
        <path d="M4.9 6.6h22.2" stroke="#16170f" strokeWidth="2.2" />
        <rect x="7.2" y="9.6" width="4.4" height="3.2" rx="0.8" fill="#16170f" />
      </g>
      <g stroke="#16170f" strokeWidth="2.4" strokeLinecap="round" strokeLinejoin="round">
        <path d="M13 22.6 9.8 17.4M19 22.6l3.5-5.6" />
        <path d="M16 22.4v4.4M16 26.8l-3 3.6M16 26.8l3.2 3.4" />
      </g>
      <circle cx="16" cy="20.2" r="2.9" fill="#16170f" />
    </svg>
  );
}

export const IconSearch = (p: P) => (
  <Icon {...p}>
    <circle cx="11" cy="11" r="7" />
    <path d="m20 20-3.5-3.5" />
  </Icon>
);
