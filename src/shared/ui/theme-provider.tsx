"use client";

import { ThemeProvider as NextThemesProvider } from "next-themes";
import type { ComponentProps } from "react";

/**
 * Wrapper do next-themes. Aplica/remove a classe `dark` no <html> conforme o
 * tema escolhido (persistido em localStorage). Antes o `dark` era cravado no
 * layout; agora o tema é alternável pela UI (ver ThemeToggle no AppShell).
 */
export function ThemeProvider({
  children,
  ...props
}: ComponentProps<typeof NextThemesProvider>) {
  return <NextThemesProvider {...props}>{children}</NextThemesProvider>;
}
