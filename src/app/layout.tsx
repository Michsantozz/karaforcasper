import type { Metadata } from "next";
import "./globals.css";
import { Geist, JetBrains_Mono } from "next/font/google";
import { cn } from "@/shared/lib/utils";
import { TooltipProvider } from "@/shared/ui/tooltip";
import { ThemeProvider } from "@/shared/ui/theme-provider";
import { QueryProvider } from "@/shared/ui/QueryProvider";
import { Toaster } from "@/shared/ui/sonner";
import { NotificationBell } from "@/features/notifications";

const geist = Geist({ subsets: ["latin"], variable: "--font-sans" });
const jetbrainsMono = JetBrains_Mono({
  subsets: ["latin"],
  variable: "--font-mono",
});

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
    <html
      lang="pt-BR"
      suppressHydrationWarning
      className={cn("font-sans", geist.variable, jetbrainsMono.variable)}
    >
      <body>
        <ThemeProvider
          attribute="class"
          defaultTheme="dark"
          enableSystem
          disableTransitionOnChange
        >
          <QueryProvider>
            <TooltipProvider>{children}</TooltipProvider>
            {/* Sino global de notificações — auto-contido, só aparece logado. */}
            <NotificationBell />
            <Toaster />
          </QueryProvider>
        </ThemeProvider>
      </body>
    </html>
  );
}
