import "server-only";
import { randomUUID } from "node:crypto";
import { and, desc, eq, isNull } from "drizzle-orm";
import { db } from "@/shared/db";
import { notifications, type NotificationRow } from "@/shared/db/schema";

/**
 * Notificações in-app do fluxo multisig.
 *
 * Criadas ao abrir uma request (avisa cada signatário que tem conta) e ao mudar
 * de estado (ready/broadcast). Não há transporte externo (email) por ora — só
 * in-app, lido pelo sininho do dashboard /multisig.
 */

export type NotificationType =
  | "signature_requested"
  | "request_ready"
  | "request_broadcast"
  | "request_cancelled"
  // Ata da reunião gerada automaticamente após o fim da call (webhook de bot).
  | "meeting_summary_ready";

/** Cria uma notificação para um usuário. */
export async function createNotification(input: {
  userId: string;
  type: NotificationType;
  message: string;
  requestId?: string | null;
}): Promise<void> {
  await db.insert(notifications).values({
    id: randomUUID(),
    userId: input.userId,
    type: input.type,
    message: input.message,
    requestId: input.requestId ?? null,
  });
}

/**
 * Cria a mesma notificação para vários usuários de uma vez (ex.: avisar todos os
 * signatários que têm conta ao abrir uma request). Ignora lista vazia.
 */
export async function createNotificationsForUsers(input: {
  userIds: string[];
  type: NotificationType;
  message: string;
  requestId?: string | null;
}): Promise<void> {
  const unique = Array.from(new Set(input.userIds));
  if (unique.length === 0) return;

  await db.insert(notifications).values(
    unique.map((userId) => ({
      id: randomUUID(),
      userId,
      type: input.type,
      message: input.message,
      requestId: input.requestId ?? null,
    })),
  );
}

/** Notificações de um usuário, mais recentes primeiro. */
export async function listNotifications(
  userId: string,
  opts?: { unreadOnly?: boolean; limit?: number },
): Promise<NotificationRow[]> {
  const where = opts?.unreadOnly
    ? and(eq(notifications.userId, userId), isNull(notifications.readAt))
    : eq(notifications.userId, userId);

  return db
    .select()
    .from(notifications)
    .where(where)
    .orderBy(desc(notifications.createdAt))
    .limit(opts?.limit ?? 50);
}

/**
 * Marca uma notificação como lida. Restrito ao dono (userId) para um usuário não
 * conseguir marcar a notificação de outro.
 */
export async function markNotificationRead(
  notificationId: string,
  userId: string,
): Promise<void> {
  await db
    .update(notifications)
    .set({ readAt: new Date() })
    .where(
      and(
        eq(notifications.id, notificationId),
        eq(notifications.userId, userId),
      ),
    );
}

/** Marca todas as notificações não lidas de um usuário como lidas. */
export async function markAllNotificationsRead(userId: string): Promise<void> {
  await db
    .update(notifications)
    .set({ readAt: new Date() })
    .where(
      and(eq(notifications.userId, userId), isNull(notifications.readAt)),
    );
}
