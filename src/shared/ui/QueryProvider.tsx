"use client";

import { useState } from "react";
import { QueryClient, QueryClientProvider } from "@tanstack/react-query";

/**
 * Provider global do TanStack Query. Envolve a árvore client no layout.
 *
 * O QueryClient é criado UMA vez por montagem via useState (não no módulo) para
 * não vazar cache entre requests no SSR do Next e não recriar a cada render.
 *
 * Defaults escolhidos para o fluxo multisig/on-chain:
 *  - staleTime 3s: as telas fazem polling curto (5–8s); manter um staleTime
 *    baixo evita refetch redundante entre re-renders sem atrasar a atualização.
 *  - refetchOnWindowFocus: revalida ao voltar à aba (signatários remotos podem
 *    ter assinado enquanto a aba estava em background).
 *  - retry 1: as rotas /api são locais; falha real é rede, não vale insistir.
 */
export function QueryProvider({ children }: { children: React.ReactNode }) {
  const [client] = useState(
    () =>
      new QueryClient({
        defaultOptions: {
          queries: {
            staleTime: 3_000,
            refetchOnWindowFocus: true,
            retry: 1,
          },
        },
      }),
  );
  return <QueryClientProvider client={client}>{children}</QueryClientProvider>;
}
