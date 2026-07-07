"use client";

/**
 * Camada TanStack Query das notificações in-app.
 *
 * O backend (GET /api/notifications, POST /api/notifications/:id/read) já existe;
 * aqui ficam a query key, o tipo e os hooks que o sino global (NotificationBell)
 * consome. Slice próprio para o AppShell (feature auth) poder renderizar o sino
 * sem cruzar a fronteira para `multisig` — notifications é transversal ao produto.
 */

import { useMutation, useQuery, useQueryClient } from "@tanstack/react-query";

export interface Notification {
  id: string;
  type: string;
  message: string;
  /** Request multisig relacionada (deep-link para /sign/:id), se houver. */
  requestId: string | null;
  readAt: string | null;
  createdAt: string;
}

interface NotificationsResponse {
  notifications: Notification[];
  unreadCount: number;
}

// Key própria do slice (o dashboard /multisig usa ["notifications"] com um
// select diferente; isolamos para nossas opções de polling/refetch não
// vazarem para a query dele).
const notificationsKey = ["notifications", "bell"] as const;

async function getJson<T>(url: string): Promise<T> {
  const res = await fetch(url, { cache: "no-store" });
  if (!res.ok) throw new Error(`GET ${url} → ${res.status}`);
  return res.json() as Promise<T>;
}

/**
 * Lista as notificações do usuário autenticado. Faz polling leve (30s) para o
 * sino refletir novas convocações de assinatura / atas prontas sem reload.
 * `enabled=false` (ex.: deslogado) desativa a query e o polling.
 */
export function useNotifications(enabled = true) {
  return useQuery({
    queryKey: notificationsKey,
    queryFn: () => getJson<NotificationsResponse>("/api/notifications"),
    enabled,
    refetchInterval: enabled ? 30_000 : false,
    refetchOnWindowFocus: true,
  });
}

/** Marca uma notificação como lida e revalida a lista/contador. */
export function useMarkNotificationRead() {
  const client = useQueryClient();
  return useMutation({
    mutationFn: async (id: string) => {
      const res = await fetch(`/api/notifications/${id}/read`, {
        method: "POST",
      });
      if (!res.ok) throw new Error(`read → ${res.status}`);
      return res.json();
    },
    onSuccess: () => {
      void client.invalidateQueries({ queryKey: notificationsKey });
    },
  });
}
