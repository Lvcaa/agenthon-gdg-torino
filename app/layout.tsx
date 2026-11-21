import type { Metadata } from "next";
import { Funnel_Display, Funnel_Sans } from "next/font/google";
import type { ReactNode } from "react";
import "./globals.css";

const sans = Funnel_Sans({ subsets: ["latin"], variable: "--font-sans", display: "swap" });
const display = Funnel_Display({ subsets: ["latin"], variable: "--font-display", display: "swap" });

export const metadata: Metadata = {
  title: "Ask&Card",
  description: "Chiedi prima di spendere e paga con la carta aziendale. Il manager vede solo le spese fuori policy.",
};

export default function RootLayout({ children }: { children: ReactNode }) {
  return (
    <html lang="it" className={`${sans.variable} ${display.variable}`}>
      <body>{children}</body>
    </html>
  );
}
