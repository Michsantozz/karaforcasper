import type { Metadata } from "next";
import "./globals.css";

export const metadata: Metadata = {
  title: "Casper Agent",
  description: "Agente autônomo na Casper Network — Buildathon 2026",
};

export default function RootLayout({
  children,
}: {
  children: React.ReactNode;
}) {
  return (
    <html lang="pt-BR">
      <body>{children}</body>
    </html>
  );
}
